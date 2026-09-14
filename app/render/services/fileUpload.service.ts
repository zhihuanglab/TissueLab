import { ChunkedUploadManager } from '@/services/fileManager.service';
import {
    computeUploadSessionTimeoutMs,
    mapUploadErrorMessage,
    UPLOAD_PROGRESS_PRE_MERGE_MAX,
} from '@/services/chunkedUpload.utils';
import { FmApiError } from '@/services/fmApiError';
import type { UploadBatchUnit } from '@/services/uploadBatch.utils';

// ---------------------------------------------------------------------------
// Shared types & worker pool
// ---------------------------------------------------------------------------

export type UploadCounts = { successful: number; cancelled: number; failed: number };

export function emptyUploadCounts(): UploadCounts {
    return { successful: 0, cancelled: 0, failed: 0 };
}

export function mergeUploadCounts(a: UploadCounts, b: UploadCounts): UploadCounts {
    return {
        successful: a.successful + b.successful,
        cancelled: a.cancelled + b.cancelled,
        failed: a.failed + b.failed,
    };
}

/** Fixed-size worker pool: at most `concurrency` tasks in flight. */
export async function runConcurrentUploadWorkers<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<UploadCounts>
): Promise<UploadCounts> {
    if (items.length === 0) return emptyUploadCounts();

    const results: UploadCounts[] = [];
    let nextIdx = 0;

    const runWorker = async () => {
        while (true) {
            const idx = nextIdx++;
            if (idx >= items.length) return;
            results.push(await worker(items[idx], idx));
        }
    };

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results.reduce(mergeUploadCounts, emptyUploadCounts());
}

/** Sequential batch executor (large chunked uploads run one at a time). */
export async function runSequentialUploadBatch<T>(
    items: T[],
    uploadOne: (item: T, index: number) => Promise<UploadCounts>
): Promise<UploadCounts> {
    let totals = emptyUploadCounts();
    for (let i = 0; i < items.length; i++) {
        try {
            totals = mergeUploadCounts(totals, await uploadOne(items[i], i));
        } catch (error) {
            console.error('Sequential upload batch item failed:', error);
            totals.failed += 1;
        }
    }
    return totals;
}

// ---------------------------------------------------------------------------
// Small file batch upload (concurrent + retry)
// ---------------------------------------------------------------------------

export const SMALL_UPLOAD_CONCURRENCY = 6;
export const SMALL_UPLOAD_MAX_RETRIES = 3;
export const SMALL_UPLOAD_RETRY_BASE_MS = 500;

export interface SmallFileUploadUnit {
    file: File;
    fileId: string;
    relativePath?: string;
}

export type SmallFileUploadFilesApi = (
    uploadPath: string,
    files: FileList,
    onProgress: (percent: number) => void,
    hasConflicts: boolean,
    relativePaths?: string[],
    keepBoth?: boolean
) => Promise<void>;

function fileToFileList(file: File): FileList {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt.files;
}

export interface SmallFileUploadCallbacks {
    onProgress: (fileId: string, file: File, percent: number, relPath?: string) => void;
    onRetry: (
        fileId: string,
        file: File,
        attempt: number,
        maxRetries: number,
        relPath?: string
    ) => void;
    onSuccess: (fileId: string, file: File, relPath?: string) => void;
    onFailure: (
        fileId: string,
        file: File,
        error: unknown,
        relPath?: string
    ) => UploadCounts;
    onUnitStart?: (fileId: string) => void;
    onUnitComplete?: (fileId: string) => void;
    captureQuotaError: (error: unknown) => void;
}

/** Transient errors are retried; cancel/quota/4xx client errors are not. */
export function isTransientSmallUploadError(error: unknown): boolean {
    const err = error as { message?: string; errorCode?: string; status?: number };
    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('cancelled') || msg.includes('canceled')) return false;
    if (err?.errorCode === 'STORAGE_QUOTA_EXCEEDED') return false;
    const status = err?.status;
    if (status == null || status === 0) return true;
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function computeSmallUploadRetryDelayMs(error: unknown, attempt: number): number {
    if (error instanceof FmApiError && error.retryAfter && error.retryAfter > 0) {
        return error.retryAfter * 1000;
    }
    return SMALL_UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
}

async function uploadOneSmallFileWithRetry(
    params: {
        uploadPath: string;
        unit: SmallFileUploadUnit;
        hasConflicts: boolean;
        keepBoth: boolean;
        uploadFiles: SmallFileUploadFilesApi;
        maxRetries: number;
    },
    callbacks: SmallFileUploadCallbacks
): Promise<UploadCounts> {
    const { uploadPath, unit, hasConflicts, keepBoth, uploadFiles, maxRetries } = params;
    const { file, fileId, relativePath: relPath } = unit;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await uploadFiles(
                uploadPath,
                fileToFileList(file),
                (percent) => {
                    const clamped = Math.min(100, percent);
                    callbacks.onProgress(fileId, file, clamped, relPath);
                },
                hasConflicts,
                relPath ? [relPath] : undefined,
                keepBoth
            );
            callbacks.onSuccess(fileId, file, relPath);
            return { successful: 1, cancelled: 0, failed: 0 };
        } catch (error) {
            lastErr = error;
            const canRetry = attempt < maxRetries && isTransientSmallUploadError(error);
            if (!canRetry) break;

            callbacks.onRetry(fileId, file, attempt + 1, maxRetries, relPath);
            const baseMs = computeSmallUploadRetryDelayMs(error, attempt);
            const waitMs = baseMs + Math.random() * 200;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }

    console.error('Small files upload failed:', lastErr);
    callbacks.captureQuotaError(lastErr);
    return callbacks.onFailure(fileId, file, lastErr, relPath);
}

export async function executeSmallFileBatchUpload(
    params: {
        uploadPath: string;
        units: SmallFileUploadUnit[];
        hasConflicts: boolean;
        keepBoth: boolean;
        uploadFiles: SmallFileUploadFilesApi;
        concurrency?: number;
        maxRetries?: number;
    },
    callbacks: SmallFileUploadCallbacks
): Promise<UploadCounts> {
    const {
        uploadPath,
        units,
        hasConflicts,
        keepBoth,
        uploadFiles,
        concurrency = SMALL_UPLOAD_CONCURRENCY,
        maxRetries = SMALL_UPLOAD_MAX_RETRIES,
    } = params;

    if (units.length === 0) return emptyUploadCounts();

    try {
        return await runConcurrentUploadWorkers(units, concurrency, async (unit) => {
            callbacks.onUnitStart?.(unit.fileId);
            try {
                return await uploadOneSmallFileWithRetry(
                    { uploadPath, unit, hasConflicts, keepBoth, uploadFiles, maxRetries },
                    callbacks
                );
            } finally {
                callbacks.onUnitComplete?.(unit.fileId);
            }
        });
    } catch (error) {
        console.error('Small files upload process failed:', error);
        return mergeUploadCounts(emptyUploadCounts(), {
            successful: 0,
            cancelled: 0,
            failed: units.length,
        });
    }
}

// ---------------------------------------------------------------------------
// Large file batch upload (sequential chunked)
// ---------------------------------------------------------------------------

export type LargeFileUploadOne = (unit: UploadBatchUnit) => Promise<UploadCounts>;

export async function executeLargeFileBatchUpload(
    units: UploadBatchUnit[],
    uploadOne: LargeFileUploadOne,
    options?: { onAfterBatch?: () => void }
): Promise<UploadCounts> {
    if (units.length === 0) return emptyUploadCounts();

    try {
        const results = await runSequentialUploadBatch(units, async (unit) => {
            try {
                return await uploadOne(unit);
            } catch (error) {
                const fileName = unit.displayPath || unit.file.name;
                console.error(`Upload failed for ${fileName}:`, error);
                return { successful: 0, cancelled: 0, failed: 1 };
            }
        });
        options?.onAfterBatch?.();
        return results;
    } catch (error) {
        console.error('Large files upload process failed:', error);
        return {
            successful: 0,
            cancelled: 0,
            failed: units.length,
        };
    }
}

// ---------------------------------------------------------------------------
// Full batch upload (small → zarr → large)
// ---------------------------------------------------------------------------

export async function executeBatchUpload(params: {
    smallUnits: UploadBatchUnit[];
    zarrUnits: UploadBatchUnit[];
    largeUnits: UploadBatchUnit[];
    uploadSmall: (units: UploadBatchUnit[]) => Promise<UploadCounts>;
    uploadZarrUnit: (unit: UploadBatchUnit) => Promise<UploadCounts>;
    uploadLarge: (units: UploadBatchUnit[]) => Promise<UploadCounts>;
}): Promise<UploadCounts> {
    const { smallUnits, zarrUnits, largeUnits, uploadSmall, uploadZarrUnit, uploadLarge } = params;
    let counts = emptyUploadCounts();

    if (smallUnits.length > 0) {
        counts = mergeUploadCounts(counts, await uploadSmall(smallUnits));
    }
    if (zarrUnits.length > 0) {
        counts = mergeUploadCounts(counts, await runSequentialUploadBatch(zarrUnits, (unit) => uploadZarrUnit(unit)));
    }
    if (largeUnits.length > 0) {
        counts = mergeUploadCounts(counts, await uploadLarge(largeUnits));
    }

    return counts;
}

// ---------------------------------------------------------------------------
// Single large file (chunked upload)
// ---------------------------------------------------------------------------

type UiUploadStatus = 'Pending' | 'Uploading' | 'Cancelled' | 'Error' | 'Completed' | 'Merging';

export interface ChunkedFileUploadCallbacks {
    onInit?: () => void;
    onProgress: (progress: number) => void;
    onTerminalStatus: (status: Exclude<UiUploadStatus, 'Uploading' | 'Merging'>, errorMessage?: string) => void;
    onUiStatus: (
        status: UiUploadStatus,
        progress: number,
        extras?: { mergeStartedAt?: number }
    ) => void;
    onCompleteSuccess: (result: unknown) => void;
    onResumeHintsRefresh: () => void;
    captureQuotaError: (error: unknown) => void;
    onFinallyComplete?: () => void;
}

export interface ChunkedUploadManagerRegistry {
    set(fileId: string, manager: ChunkedUploadManager): void;
    delete(fileId: string): void;
}

const UPLOAD_TIMEOUT_MESSAGE =
    'Upload timed out. Re-select the same file to resume from where you left off.';

function mapManagerStatus(status: string): UiUploadStatus {
    switch (status) {
        case 'uploading': return 'Uploading';
        case 'cancelled': return 'Cancelled';
        case 'error': return 'Error';
        case 'completed': return 'Completed';
        case 'merging': return 'Merging';
        default: return 'Uploading';
    }
}

function resolveChunkedUploadCounts(
    finalStatus: { progress: number; status: UiUploadStatus; error?: string } | null | undefined,
    silent: boolean,
    onFinallyComplete?: () => void
): UploadCounts {
    if (finalStatus) {
        if (finalStatus.status === 'Completed' || finalStatus.progress === 100) {
            if (!silent) onFinallyComplete?.();
            return { successful: 1, cancelled: 0, failed: 0 };
        }
        if (finalStatus.status === 'Cancelled' || finalStatus.error?.toLowerCase().includes('cancelled')) {
            if (!silent) onFinallyComplete?.();
            return { successful: 0, cancelled: 1, failed: 0 };
        }
        if (finalStatus.status === 'Error' || finalStatus.error) {
            if (!silent) onFinallyComplete?.();
            return { successful: 0, cancelled: 0, failed: 1 };
        }
        if (!silent) onFinallyComplete?.();
        return { successful: 0, cancelled: 0, failed: 1 };
    }
    if (!silent) onFinallyComplete?.();
    return { successful: 0, cancelled: 0, failed: 1 };
}

export async function executeChunkedFileUpload(
    params: {
        file: File;
        uploadPath: string;
        hasConflicts: boolean;
        relativePath?: string;
        keepBoth: boolean;
        fileId: string;
        displayPath: string;
        startTime: number;
        silent?: boolean;
        abortSignal?: AbortSignal;
        getCurrentProgress?: () => number;
        getMergeStartedAt?: () => number | undefined;
        getFinalStatus?: () => {
            progress: number;
            status: UiUploadStatus;
            error?: string;
        } | undefined;
        managerRegistry?: ChunkedUploadManagerRegistry;
    },
    callbacks: ChunkedFileUploadCallbacks
): Promise<UploadCounts> {
    const {
        file,
        uploadPath,
        hasConflicts,
        relativePath,
        keepBoth,
        fileId,
        displayPath,
        startTime,
        silent = false,
        abortSignal,
        getCurrentProgress,
        getMergeStartedAt,
        managerRegistry,
    } = params;

    callbacks.onInit?.();

    let terminalStatusHandled = false;
    const emitTerminalStatus = (
        status: Exclude<UiUploadStatus, 'Uploading' | 'Merging' | 'Pending'>,
        errorMessage?: string
    ) => {
        if (terminalStatusHandled || silent) return;
        terminalStatusHandled = true;
        callbacks.onTerminalStatus(status, errorMessage);
        callbacks.onFinallyComplete?.();
    };

    let silentOutcome: {
        progress: number;
        status: Exclude<UiUploadStatus, 'Uploading' | 'Merging'>;
        error?: string;
        startTime: number;
    } | null = null;

    try {
        const manager = new ChunkedUploadManager(
            file.name,
            file,
            uploadPath,
            (progress) => {
                if (silent) return;
                callbacks.onProgress(progress);
            },
            (error) => {
                console.error(`Upload failed for ${displayPath}:`, error);
                callbacks.captureQuotaError(error);
                const rawMessage = error && typeof error === 'object' && 'message' in error
                    ? (error as Error).message
                    : String(error);
                const errorMessage = mapUploadErrorMessage(error);
                const isCancelled = rawMessage.toLowerCase().includes('cancel')
                    || rawMessage.toLowerCase().includes('abort')
                    || rawMessage.toLowerCase().includes('user cancelled');
                const status = isCancelled ? 'Cancelled' : 'Error';
                if (!silent) {
                    emitTerminalStatus(status, errorMessage);
                } else {
                    silentOutcome = { progress: 0, status, error: errorMessage, startTime };
                }
                callbacks.onResumeHintsRefresh();
            },
            (result) => {
                if (silent) {
                    silentOutcome = { progress: 100, status: 'Completed', startTime };
                    return;
                }
                callbacks.onCompleteSuccess(result);
                callbacks.onResumeHintsRefresh();
            },
            (status) => {
                if (silent) return;
                const statusValue = mapManagerStatus(status);
                const currentProgress = getCurrentProgress?.() ?? 0;
                const mergeProgress = statusValue === 'Merging'
                    ? Math.max(currentProgress, UPLOAD_PROGRESS_PRE_MERGE_MAX)
                    : currentProgress;
                const mergeStartedAt = statusValue === 'Merging'
                    ? (getMergeStartedAt?.() ?? Date.now())
                    : undefined;
                callbacks.onUiStatus(statusValue, mergeProgress, { mergeStartedAt });
            },
            hasConflicts,
            relativePath,
            keepBoth
        );

        managerRegistry?.set(fileId, manager);

        const onExternalAbort = () => {
            void manager.cancel();
        };

        if (abortSignal) {
            if (abortSignal.aborted) {
                await manager.cancel();
                managerRegistry?.delete(fileId);
                return { successful: 0, cancelled: 1, failed: 0 };
            }
            abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        const uploadTimeoutMs = computeUploadSessionTimeoutMs(file.size);
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

        try {
            await new Promise<void>((resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    manager.stopForTimeout();
                    reject(new Error(UPLOAD_TIMEOUT_MESSAGE));
                }, uploadTimeoutMs);

                manager.start()
                    .then(() => {
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        resolve();
                    })
                    .catch((err) => {
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        reject(err);
                    });
            });
        } finally {
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onExternalAbort);
            }
            managerRegistry?.delete(fileId);
        }

        if (silent && !silentOutcome) {
            silentOutcome = { progress: 100, status: 'Completed', startTime };
        }

        const finalStatus = silent ? silentOutcome : params.getFinalStatus?.();
        return resolveChunkedUploadCounts(finalStatus, silent, callbacks.onFinallyComplete);
    } catch (error: unknown) {
        console.error(`Upload error for ${file.name}:`, error);
        callbacks.captureQuotaError(error);

        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('cancelled')) {
            emitTerminalStatus('Cancelled', 'Upload cancelled');
            return { successful: 0, cancelled: 1, failed: 0 };
        }
        if (message.toLowerCase().includes('timed out')) {
            emitTerminalStatus('Error', message || UPLOAD_TIMEOUT_MESSAGE);
            return { successful: 0, cancelled: 0, failed: 1 };
        }
        emitTerminalStatus('Error', message || 'Upload failed');
        return { successful: 0, cancelled: 0, failed: 1 };
    }
}
