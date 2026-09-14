import {
    cancelZarrBatchUpload,
    completeZarrBatchUploadWithRetry,
    getUploadStatus,
    uploadZarrBatchWithTimeout,
    uploadZarrManifest,
    type ZarrBatchFileEntry,
} from '@/services/fileManager.service';
import {
    buildZarrBatchUploadSessionKey,
    clearPersistedZarrBatchUploadSession,
    computeRetryDelayMs,
    isAbortError,
    isRequestQuotaExceededError,
    loadPersistedZarrBatchUploadSession,
    mapUploadErrorMessage,
    pickZarrBatchMaxBytesForTotalSize,
    progressBeforeMergeFromRatio,
    savePersistedZarrBatchUploadSession,
    ZARR_BATCH_UPLOAD_MAX_FILES,
} from '@/services/chunkedUpload.utils';
import type { UploadCounts } from '@/services/fileUpload.service';

export type { ZarrBatchFileEntry };

export interface ZarrUploadSession {
    uploadId: string;
    uploadPath: string;
    sessionKey: string;
    childFileIds: string[];
}

export class ZarrUploadSessionStore {
    private sessions = new Map<string, ZarrUploadSession>();
    private abortControllers = new Map<string, AbortController>();

    registerAbort(fileId: string, controller: AbortController): void {
        this.abortControllers.set(fileId, controller);
    }

    setSession(fileId: string, session: ZarrUploadSession): void {
        this.sessions.set(fileId, session);
    }

    getSession(fileId: string): ZarrUploadSession | undefined {
        return this.sessions.get(fileId);
    }

    deleteSession(fileId: string): void {
        this.sessions.delete(fileId);
    }

    abort(fileId: string): void {
        this.abortControllers.get(fileId)?.abort();
    }

    cleanupAbort(fileId: string): void {
        this.abortControllers.delete(fileId);
    }
}

export function getZarrRootFromRelativePath(relativePath?: string): string | null {
    if (!relativePath) return null;
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const zarrIndex = parts.findIndex((part) => part.toLowerCase().endsWith('.zarr'));
    if (zarrIndex < 0) return null;
    return parts.slice(0, zarrIndex + 1).join('/');
}

export function applyZarrFolderRewrite(relativePath: string, folderRewrite: Record<string, string>): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!folderRewrite || Object.keys(folderRewrite).length === 0) {
        return normalized;
    }
    const parts = normalized.split('/');
    if (parts[0] && folderRewrite[parts[0]]) {
        parts[0] = folderRewrite[parts[0]];
        return parts.join('/');
    }
    return normalized;
}

export function splitZarrBatchEntries(
    entries: ZarrBatchFileEntry[],
    maxBatchBytes: number
): ZarrBatchFileEntry[][] {
    const batches: ZarrBatchFileEntry[][] = [];
    let current: ZarrBatchFileEntry[] = [];
    let currentBytes = 0;

    for (const entry of entries) {
        const fileBytes = entry.file.size || 0;
        if (fileBytes > maxBatchBytes) {
            continue;
        }
        const wouldExceedBytes = current.length > 0 && currentBytes + fileBytes > maxBatchBytes;
        const wouldExceedFiles = current.length >= ZARR_BATCH_UPLOAD_MAX_FILES;
        if (wouldExceedBytes || wouldExceedFiles) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(entry);
        currentBytes += fileBytes;
    }

    if (current.length > 0) batches.push(current);
    return batches;
}

export function groupZarrBatchEntriesByRoot(entries: ZarrBatchFileEntry[]): ZarrBatchFileEntry[][] {
    const groups = new Map<string, ZarrBatchFileEntry[]>();
    for (const entry of entries) {
        const root = getZarrRootFromRelativePath(entry.relativePath);
        if (!root) continue;
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(entry);
    }
    return Array.from(groups.values());
}

export interface ZarrLargeFileUploader {
    (
        uploadPath: string,
        file: File,
        hasConflicts: boolean,
        relativePath: string,
        childFileId: string,
        abortSignal: AbortSignal
    ): Promise<UploadCounts>;
}

export interface ZarrBatchUploadCallbacks {
    onInitProgress: () => void;
    onProgress: (progress: number, message?: string) => void;
    onMerging: (mergeStartedAt: number) => void;
    onCompleted: () => void;
    onFailed: (status: 'Cancelled' | 'Error', message: string) => void;
    captureQuotaError: (error: unknown) => void;
    uploadLargeFile: ZarrLargeFileUploader;
}

const ZARR_BATCH_CONCURRENCY = 4;
const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_RETRY_BASE_MS = 700;

export async function executeZarrBatchUpload(
    params: {
        uploadPath: string;
        entries: ZarrBatchFileEntry[];
        hasConflicts: boolean;
        keepBoth: boolean;
        presetFileId?: string;
        presetDisplayPath?: string;
        presetTotalBytes?: number;
        sessionStore: ZarrUploadSessionStore;
    },
    callbacks: ZarrBatchUploadCallbacks
): Promise<UploadCounts> {
    const {
        uploadPath,
        entries,
        hasConflicts,
        keepBoth,
        presetFileId,
        presetDisplayPath,
        presetTotalBytes,
        sessionStore,
    } = params;
    const {
        onInitProgress,
        onProgress,
        onMerging,
        onCompleted,
        onFailed,
        captureQuotaError,
        uploadLargeFile,
    } = callbacks;

    if (entries.length === 0) return { successful: 0, cancelled: 0, failed: 0 };

    const zarrTotalBytes = presetTotalBytes ?? entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0);
    const zarrRoots = Array.from(
        new Set(entries.map((entry) => getZarrRootFromRelativePath(entry.relativePath)).filter(Boolean))
    );
    const zarrDisplayPath = presetDisplayPath || zarrRoots[0] || 'Zarr upload';
    const zarrSessionKey = buildZarrBatchUploadSessionKey(
        uploadPath,
        zarrDisplayPath,
        zarrTotalBytes,
        entries.length,
        hasConflicts,
        keepBoth
    );
    const persistedZarr = loadPersistedZarrBatchUploadSession(zarrSessionKey);
    const maxBatchBytes = persistedZarr?.maxBatchBytes ?? pickZarrBatchMaxBytesForTotalSize(zarrTotalBytes);
    const batchableEntries = entries.filter((entry) => (entry.file.size || 0) <= maxBatchBytes);
    const oversizedEntries = entries.filter((entry) => (entry.file.size || 0) > maxBatchBytes);
    const batches = splitZarrBatchEntries(batchableEntries, maxBatchBytes);
    const oversizedStepCount = oversizedEntries.length > 0 ? 1 : 0;
    const totalBatchSteps = Math.max(oversizedStepCount + batches.length, 1);
    const zarrFileId = presetFileId || `zarr_${zarrDisplayPath}_${zarrTotalBytes}_${Date.now()}`;
    const zarrAbort = new AbortController();
    sessionStore.registerAbort(zarrFileId, zarrAbort);

    const persistSession = (uploadId: string, folderRewrite: Record<string, string>) => {
        savePersistedZarrBatchUploadSession(zarrSessionKey, {
            uploadId,
            path: uploadPath,
            zarrDisplayPath,
            totalBytes: zarrTotalBytes,
            fileCount: entries.length,
            hasConflicts,
            keepBoth,
            maxBatchBytes,
            folderRewrite,
            updatedAt: Date.now(),
        });
    };

    const abandonZarrPersistedSession = async (uploadId?: string) => {
        if (uploadId) {
            try {
                await cancelZarrBatchUpload(uploadId);
            } catch (cleanupError) {
                console.warn('Failed to abandon zarr upload session:', cleanupError);
            }
        }
        clearPersistedZarrBatchUploadSession(zarrSessionKey);
    };

    let completedSteps = 0;
    let zarrFinalFailureMessage = 'Zarr batch upload failed';

    const fail = (status: 'Cancelled' | 'Error', message: string): UploadCounts => {
        zarrFinalFailureMessage = message;
        if (status === 'Cancelled') {
            clearPersistedZarrBatchUploadSession(zarrSessionKey);
        }
        onFailed(status, message);
        return {
            successful: 0,
            cancelled: status === 'Cancelled' ? 1 : 0,
            failed: status === 'Error' ? 1 : 0,
        };
    };

    const bumpProgress = (extraInFlight = 0) => {
        const progress = progressBeforeMergeFromRatio((completedSteps + extraInFlight) / totalBatchSteps);
        onProgress(progress);
    };

    onInitProgress();

    try {
        let zarrUploadId: string | undefined;
        let folderRewrite: Record<string, string> = {};
        let resumedUploadedBatches = new Set<number>();

        const cleanupPartialZarr = async () => {
            if (!zarrUploadId) return;
            try {
                await cancelZarrBatchUpload(zarrUploadId);
            } catch (cleanupError) {
                console.warn('Failed to cleanup partial zarr upload:', cleanupError);
            } finally {
                sessionStore.deleteSession(zarrFileId);
            }
        };

        try {
            if (persistedZarr?.uploadId) {
                try {
                    const status = await getUploadStatus(persistedZarr.uploadId);
                    const resumeValid = status.upload_type === 'zarr-batch'
                        && Boolean(status.upload_id)
                        && status.file_count === entries.length
                        && status.total_size === zarrTotalBytes
                        && persistedZarr.keepBoth === keepBoth
                        && persistedZarr.hasConflicts === hasConflicts
                        && (status.total_batches == null || status.total_batches === 0 || status.total_batches === batches.length);
                    if (resumeValid) {
                        zarrUploadId = status.upload_id;
                        folderRewrite = (status.folder_rewrite ?? persistedZarr.folderRewrite ?? {}) as Record<string, string>;
                        resumedUploadedBatches = new Set(status.uploaded_batches ?? []);
                        completedSteps += status.uploaded_batch_count ?? resumedUploadedBatches.size;
                        bumpProgress();
                    } else {
                        await abandonZarrPersistedSession(persistedZarr.uploadId);
                    }
                } catch {
                    await abandonZarrPersistedSession(persistedZarr.uploadId);
                }
            }

            if (!zarrUploadId) {
                const manifestResult = await uploadZarrManifest(
                    uploadPath,
                    entries.map((entry) => ({ relativePath: entry.relativePath, size: entry.file.size })),
                    hasConflicts,
                    keepBoth,
                    maxBatchBytes
                );
                zarrUploadId = manifestResult?.upload_id || manifestResult?.uploadId;
                if (manifestResult?.folder_rewrite && typeof manifestResult.folder_rewrite === 'object') {
                    folderRewrite = manifestResult.folder_rewrite as Record<string, string>;
                }
                if (zarrUploadId) {
                    persistSession(zarrUploadId, folderRewrite);
                }
            } else if (persistedZarr) {
                zarrUploadId = persistedZarr.uploadId;
                if (!folderRewrite || Object.keys(folderRewrite).length === 0) {
                    folderRewrite = persistedZarr.folderRewrite ?? {};
                }
            }
        } catch (error: unknown) {
            console.error('Zarr manifest upload failed:', error);
            captureQuotaError(error);
            const message = error instanceof Error ? error.message : 'Zarr manifest upload failed';
            return fail('Error', message || 'Zarr manifest upload failed');
        }

        if (!zarrUploadId) {
            return fail('Error', 'Zarr manifest response missing upload_id');
        }

        sessionStore.setSession(zarrFileId, {
            uploadId: zarrUploadId,
            uploadPath,
            sessionKey: zarrSessionKey,
            childFileIds: [],
        });

        if (oversizedEntries.length > 0) {
            bumpProgress(0.1);
            let oversizedCancelled = 0;
            let oversizedFailed = 0;

            for (const entry of oversizedEntries) {
                if (zarrAbort.signal.aborted) {
                    oversizedCancelled++;
                    break;
                }
                const resolvedRelativePath = applyZarrFolderRewrite(entry.relativePath, folderRewrite);
                const childFileId = `${zarrFileId}_oversized_${resolvedRelativePath.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
                const zarrSession = sessionStore.getSession(zarrFileId);
                if (zarrSession) {
                    zarrSession.childFileIds.push(childFileId);
                }
                try {
                    const result = await uploadLargeFile(
                        uploadPath,
                        entry.file,
                        hasConflicts,
                        resolvedRelativePath,
                        childFileId,
                        zarrAbort.signal
                    );
                    oversizedCancelled += result.cancelled;
                    oversizedFailed += result.failed;
                } catch (error) {
                    console.error(`Oversized zarr file upload failed for ${resolvedRelativePath}:`, error);
                    oversizedFailed++;
                }
            }

            if (oversizedCancelled > 0 || oversizedFailed > 0) {
                await cleanupPartialZarr();
                const isCancelled = oversizedCancelled > 0 && oversizedFailed === 0;
                return fail(
                    isCancelled ? 'Cancelled' : 'Error',
                    isCancelled ? 'Zarr upload cancelled' : 'Failed to upload large zarr chunk(s)'
                );
            }
            completedSteps++;
            bumpProgress();
        }

        let batchFailed = false;
        let batchCancelled = false;

        if (batches.length > 0) {
            let nextIdx = 0;

            const uploadBatchWithRetry = async (batch: ZarrBatchFileEntry[], batchIndex: number) => {
                if (zarrAbort.signal.aborted) {
                    batchCancelled = true;
                    return;
                }
                if (resumedUploadedBatches.has(batchIndex)) {
                    completedSteps++;
                    bumpProgress();
                    return;
                }
                for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
                    if (zarrAbort.signal.aborted) {
                        batchCancelled = true;
                        return;
                    }
                    try {
                        bumpProgress(0.2);
                        await uploadZarrBatchWithTimeout(
                            uploadPath,
                            batch,
                            batchIndex,
                            batches.length,
                            hasConflicts,
                            keepBoth,
                            zarrUploadId,
                            { signal: zarrAbort.signal }
                        );
                        completedSteps++;
                        bumpProgress();
                        persistSession(zarrUploadId!, folderRewrite);
                        return;
                    } catch (error: unknown) {
                        if (isAbortError(error) || zarrAbort.signal.aborted) {
                            batchCancelled = true;
                            return;
                        }
                        const canRetry = attempt < UPLOAD_MAX_RETRIES;
                        if (!canRetry) {
                            nextIdx = batches.length;
                            zarrAbort.abort();
                            console.error(`Zarr batch ${batchIndex} upload failed:`, error);
                            captureQuotaError(error);
                            batchCancelled = String((error as Error)?.message ?? '').toLowerCase().includes('cancel');
                            batchFailed = !batchCancelled;
                            zarrFinalFailureMessage = (error as Error)?.message || 'Zarr batch upload failed';
                            return;
                        }

                        const waitMs = isRequestQuotaExceededError(error)
                            ? computeRetryDelayMs(error, attempt + 1, UPLOAD_RETRY_BASE_MS)
                            : UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 250;
                        onProgress(
                            progressBeforeMergeFromRatio((completedSteps + 0.1) / totalBatchSteps),
                            `Retrying batch (${attempt + 1}/${UPLOAD_MAX_RETRIES})...`
                        );
                        await new Promise((resolve) => setTimeout(resolve, waitMs));
                    }
                }
            };

            const worker = async () => {
                while (true) {
                    const idx = nextIdx++;
                    if (idx >= batches.length) return;
                    await uploadBatchWithRetry(batches[idx], idx);
                }
            };

            await Promise.all(
                Array.from({ length: Math.min(ZARR_BATCH_CONCURRENCY, batches.length) }, () => worker())
            );
        }

        if (batchFailed || batchCancelled) {
            await cleanupPartialZarr();
            return fail(
                batchCancelled ? 'Cancelled' : 'Error',
                zarrFinalFailureMessage
            );
        }

        const mergeStartedAt = Date.now();
        onMerging(mergeStartedAt);
        persistSession(zarrUploadId, folderRewrite);

        try {
            await completeZarrBatchUploadWithRetry(
                uploadPath,
                zarrUploadId,
                batches.length,
                zarrTotalBytes,
                {
                    signal: zarrAbort.signal,
                    isCancelled: () => zarrAbort.signal.aborted,
                }
            );
        } catch (error: unknown) {
            if (zarrAbort.signal.aborted || String((error as Error)?.message ?? '').toLowerCase().includes('cancel')) {
                await cleanupPartialZarr();
                return fail('Cancelled', 'Zarr upload cancelled');
            }
            console.error('Zarr batch complete failed:', error);
            captureQuotaError(error);
            persistSession(zarrUploadId, folderRewrite);
            return fail('Error', mapUploadErrorMessage(error));
        }

        sessionStore.deleteSession(zarrFileId);
        clearPersistedZarrBatchUploadSession(zarrSessionKey);
        onCompleted();
        return { successful: 1, cancelled: 0, failed: 0 };
    } finally {
        sessionStore.cleanupAbort(zarrFileId);
    }
}

export async function cancelZarrUploadSession(
    fileId: string,
    sessionStore: ZarrUploadSessionStore,
    cancelChildUpload: (childFileId: string) => Promise<void>
): Promise<boolean> {
    const zarrSession = sessionStore.getSession(fileId);
    if (!zarrSession) return false;

    sessionStore.abort(fileId);
    for (const childFileId of zarrSession.childFileIds) {
        await cancelChildUpload(childFileId);
    }
    try {
        await cancelZarrBatchUpload(zarrSession.uploadId);
    } catch (error) {
        console.warn(`Failed to cancel zarr upload ${zarrSession.uploadId}:`, error);
    }
    clearPersistedZarrBatchUploadSession(zarrSession.sessionKey);
    sessionStore.deleteSession(fileId);
    return true;
}
