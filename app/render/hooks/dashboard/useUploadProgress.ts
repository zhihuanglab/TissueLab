import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { ChunkedUploadManager } from '@/services/fileManager.service';
import {
    isCancelBlockedWhileMerging,
    isStorageQuotaError,
    mapUploadErrorMessage,
    UPLOAD_PROGRESS_PRE_MERGE_MAX,
} from '@/services/chunkedUpload.utils';
import type { UploadCounts } from '@/services/fileUpload.service';
import type { SmallFileUploadCallbacks } from '@/services/fileUpload.service';
import type { ChunkedFileUploadCallbacks } from '@/services/fileUpload.service';
import { getUploadUnitWeight, type UploadBatchUnit } from '@/services/uploadBatch.utils';
import { cancelZarrUploadSession, ZarrUploadSessionStore } from '@/services/zarrUpload.service';
import type { ZarrBatchUploadCallbacks } from '@/services/zarrUpload.service';
import { setUploadSettings } from '@/store/slices/fileManagerSlice';

export type UploadUiStatus = 'Pending' | 'Uploading' | 'Cancelled' | 'Error' | 'Completed' | 'Merging';

export interface UploadStatusEntry {
    progress: number;
    status: UploadUiStatus;
    error?: string;
    mergeStartedAt?: number;
    retryCount?: number;
    startTime?: number;
    fileSize?: number;
    fileName?: string;
}

export interface UnitUploadBinding {
    fileId: string;
    file: File;
    displayPath: string;
    displayFileSize?: number;
}

export interface UnitUploadCallbacks {
    getStartTime: () => number;
    trackStart: () => void;
    trackComplete: () => void;
    reportProgress: (
        progress: number,
        opts?: {
            status?: UploadUiStatus;
            message?: string;
            extras?: { mergeStartedAt?: number };
            debounceOverallMs?: number;
        }
    ) => void;
    setMerging: (mergeStartedAt: number) => void;
    setCompleted: () => void;
    setFailed: (status: 'Cancelled' | 'Error', message?: string) => void;
    setRetrying: (attempt: number, maxRetries: number) => void;
    toSmallFailureCounts: (error: unknown) => UploadCounts;
    buildChunkedCallbacks: (options?: {
        silent?: boolean;
        onResumeHintsRefresh?: () => void;
        captureQuotaError?: (error: unknown) => void;
    }) => ChunkedFileUploadCallbacks;
    buildZarrCallbacks: (options?: {
        onResumeHintsRefresh?: () => void;
        captureQuotaError?: (error: unknown) => void;
    }) => Pick<
        ZarrBatchUploadCallbacks,
        'onInitProgress' | 'onProgress' | 'onMerging' | 'onCompleted' | 'onFailed' | 'captureQuotaError'
    >;
}

const isActiveUploadStatus = (status: string) =>
    status === 'Uploading' || status === 'Merging';

export function hasActiveUploadStatuses(statusMap: Map<string, { status: string }>) {
    return Array.from(statusMap.values()).some((entry) => isActiveUploadStatus(entry.status));
}

export function useUploadProgress() {
    const dispatch = useDispatch();

    const [uploadStatus, setUploadStatus] = useState<Map<string, UploadStatusEntry>>(new Map());
    const [uploadInterrupted, setUploadInterrupted] = useState(false);

    const uploadStatusRef = useRef(uploadStatus);
    const perFileProgressRef = useRef<Map<string, number>>(new Map());
    const uploadBatchWeightRef = useRef<number>(1);
    const uploadBatchGenerationRef = useRef(0);
    const totalUploadFilesRef = useRef<number>(0);
    const uploadQuotaErrorRef = useRef<unknown>(null);
    const uploadInterruptedRef = useRef(false);
    const chunkedUploadManagersRef = useRef<Map<string, ChunkedUploadManager>>(new Map());
    const zarrSessionStoreRef = useRef(new ZarrUploadSessionStore());

    const uploadCompletionTracker = useRef({
        activeUploads: new Map<string, { resolve: () => void; promise: Promise<void> }>(),
        add: (fileId: string) => {
            let resolveFn!: () => void;
            const promise = new Promise<void>((resolve) => {
                resolveFn = resolve;
            });
            uploadCompletionTracker.current.activeUploads.set(fileId, {
                resolve: resolveFn,
                promise,
            });
        },
        complete: (fileId: string) => {
            const upload = uploadCompletionTracker.current.activeUploads.get(fileId);
            if (upload) {
                upload.resolve();
                uploadCompletionTracker.current.activeUploads.delete(fileId);
            }
        },
        waitForAll: () => {
            const pending = Array.from(uploadCompletionTracker.current.activeUploads.values());
            if (pending.length === 0) return Promise.resolve();
            return Promise.all(pending.map((entry) => entry.promise));
        },
        hasActiveUploads: () => uploadCompletionTracker.current.activeUploads.size > 0,
    });

    useEffect(() => {
        uploadStatusRef.current = uploadStatus;
    }, [uploadStatus]);

    const updateFileUploadStatus = useCallback((
        fileId: string,
        file: File,
        progress: number,
        status: UploadUiStatus,
        startTime: number,
        error?: string,
        displayPath?: string,
        displayFileSize?: number,
        extras?: { mergeStartedAt?: number }
    ) => {
        const currentTime = Date.now();
        const prevStatus = uploadStatusRef.current.get(fileId);
        const fileSize = displayFileSize ?? file.size;

        const mergeStartedAt = status === 'Merging'
            ? (extras?.mergeStartedAt ?? prevStatus?.mergeStartedAt ?? currentTime)
            : undefined;

        const displayName = (displayPath || file.name).split(/[/\\]/).pop() || file.name;
        const newStatus: UploadStatusEntry = {
            progress,
            status,
            mergeStartedAt,
            retryCount: 0,
            startTime,
            fileSize,
            fileName: displayName,
            error: error || undefined,
        };

        setUploadStatus((prev) => {
            const newMap = new Map(prev);
            newMap.set(fileId, newStatus);
            uploadStatusRef.current = newMap;
            return newMap;
        });

        return newStatus;
    }, []);

    const subtractFileWeightFromBatch = useCallback((fileId: string) => {
        const status = uploadStatusRef.current.get(fileId);
        const weight = status?.fileSize && status.fileSize > 0 ? status.fileSize : 1;
        uploadBatchWeightRef.current = Math.max(1, uploadBatchWeightRef.current - weight);
        perFileProgressRef.current.delete(fileId);
    }, []);

    const markFileUploadComplete = useCallback((fileId: string, progress: number = 100) => {
        perFileProgressRef.current.set(fileId, progress);
    }, []);

    const updateOverallProgress = useCallback(() => {
        const totalWeight = uploadBatchWeightRef.current || 1;
        let weightedSum = 0;

        for (const [fileId, fileProgress] of perFileProgressRef.current) {
            const status = uploadStatusRef.current.get(fileId);
            if (status?.status === 'Cancelled') continue;
            const weight = status?.fileSize && status.fileSize > 0 ? status.fileSize : 1;
            weightedSum += Math.min(100, fileProgress) * weight;
        }

        if (weightedSum <= 0 && perFileProgressRef.current.size === 0) return;

        const progress = Math.min(100, weightedSum / totalWeight);
        dispatch(setUploadSettings({ uploadProgress: Number(progress.toFixed(1)) }));
    }, [dispatch]);

    const safeUpdateOverallProgress = useCallback(() => {
        if (uploadStatusRef.current.size > 0) {
            updateOverallProgress();
        }
    }, [updateOverallProgress]);

    const captureUploadQuotaError = useCallback((error: unknown) => {
        if (!uploadQuotaErrorRef.current && isStorageQuotaError(error)) {
            uploadQuotaErrorRef.current = error;
        }
    }, []);

    const initializeUploadStatusBatch = useCallback((units: UploadBatchUnit[]) => {
        uploadBatchGenerationRef.current += 1;
        const batchStartTime = Date.now();
        uploadBatchWeightRef.current = units.reduce((sum, unit) => sum + getUploadUnitWeight(unit), 0) || 1;
        const newMap = new Map<string, UploadStatusEntry>();
        perFileProgressRef.current.clear();

        for (const unit of units) {
            const displayName = unit.displayPath.split(/[/\\]/).pop() || unit.file.name;
            newMap.set(unit.fileId, {
                progress: 0,
                status: 'Pending',
                startTime: batchStartTime,
                fileSize: unit.displayFileSize ?? unit.file.size,
                fileName: displayName,
            });
            perFileProgressRef.current.set(unit.fileId, 0);
        }

        uploadStatusRef.current = newMap;
        setUploadStatus(newMap);
    }, []);

    const markUnitAsUploading = useCallback((fileId: string) => {
        setUploadStatus((prev) => {
            const current = prev.get(fileId);
            if (!current || current.status !== 'Pending') return prev;
            const newMap = new Map(prev);
            newMap.set(fileId, {
                ...current,
                status: 'Uploading',
                startTime: Date.now(),
            });
            uploadStatusRef.current = newMap;
            return newMap;
        });
        uploadCompletionTracker.current.add(fileId);
    }, []);

    const createUnitUploadCallbacks = useCallback((binding: UnitUploadBinding): UnitUploadCallbacks => {
        const { fileId, file, displayPath, displayFileSize } = binding;

        const getStartTime = () => uploadStatusRef.current.get(fileId)?.startTime ?? Date.now();

        const reportProgress = (
            progress: number,
            opts?: {
                status?: UploadUiStatus;
                message?: string;
                extras?: { mergeStartedAt?: number };
                debounceOverallMs?: number;
            }
        ) => {
            perFileProgressRef.current.set(fileId, progress);
            updateFileUploadStatus(
                fileId,
                file,
                progress,
                opts?.status ?? 'Uploading',
                getStartTime(),
                opts?.message,
                displayPath,
                displayFileSize,
                opts?.extras
            );
            if (opts?.debounceOverallMs != null) {
                setTimeout(() => safeUpdateOverallProgress(), opts.debounceOverallMs);
            } else {
                safeUpdateOverallProgress();
            }
        };

        return {
            getStartTime,
            trackStart: () => markUnitAsUploading(fileId),
            trackComplete: () => uploadCompletionTracker.current.complete(fileId),
            reportProgress,
            setMerging: (mergeStartedAt) => reportProgress(UPLOAD_PROGRESS_PRE_MERGE_MAX, { status: 'Merging', extras: { mergeStartedAt } }),
            setCompleted: () => {
                markFileUploadComplete(fileId, 100);
                reportProgress(100, { status: 'Completed' });
            },
            setFailed: (status, message) => {
                if (status === 'Cancelled') {
                    subtractFileWeightFromBatch(fileId);
                } else {
                    perFileProgressRef.current.set(fileId, 0);
                }
                updateFileUploadStatus(
                    fileId,
                    file,
                    0,
                    status,
                    getStartTime(),
                    message,
                    displayPath,
                    displayFileSize
                );
                safeUpdateOverallProgress();
            },
            setRetrying: (attempt, maxRetries) => {
                reportProgress(0, {
                    status: 'Uploading',
                    message: `Retrying (${attempt}/${maxRetries})…`,
                });
            },
            toSmallFailureCounts: (error) => {
                const isCancelled = String((error as { message?: string })?.message ?? '')
                    .toLowerCase()
                    .includes('cancel');
                return isCancelled
                    ? { successful: 0, cancelled: 1, failed: 0 }
                    : { successful: 0, cancelled: 0, failed: 1 };
            },
            buildChunkedCallbacks: (options) => ({
                    onProgress: (progress) => reportProgress(progress, { status: 'Uploading' }),
                    onTerminalStatus: (status, errorMessage) => {
                        if (status === 'Cancelled') {
                            subtractFileWeightFromBatch(fileId);
                        } else {
                            perFileProgressRef.current.set(fileId, 0);
                        }
                        updateFileUploadStatus(
                            fileId,
                            file,
                            0,
                            status,
                            getStartTime(),
                            errorMessage,
                            displayPath,
                            displayFileSize
                        );
                        safeUpdateOverallProgress();
                    },
                    onUiStatus: (status, progress, extras) => {
                        reportProgress(progress, { status, extras, debounceOverallMs: 50 });
                    },
                    onCompleteSuccess: () => {
                        markFileUploadComplete(fileId, 100);
                        reportProgress(100, { status: 'Completed' });
                    },
                    onResumeHintsRefresh: options?.onResumeHintsRefresh ?? (() => {}),
                    captureQuotaError: options?.captureQuotaError ?? captureUploadQuotaError,
                    onFinallyComplete: () => {
                        if (!options?.silent) {
                            uploadCompletionTracker.current.complete(fileId);
                        }
                    },
                }),
            buildZarrCallbacks: (options) => ({
                onInitProgress: () => {
                    markUnitAsUploading(fileId);
                    reportProgress(0, { status: 'Uploading' });
                },
                onProgress: (progress, message) => reportProgress(progress, { status: 'Uploading', message }),
                onMerging: (mergeStartedAt) => reportProgress(UPLOAD_PROGRESS_PRE_MERGE_MAX, { status: 'Merging', extras: { mergeStartedAt } }),
                onCompleted: () => {
                    markFileUploadComplete(fileId, 100);
                    reportProgress(100, { status: 'Completed' });
                    uploadCompletionTracker.current.complete(fileId);
                    options?.onResumeHintsRefresh?.();
                },
                onFailed: (status, message) => {
                    if (status === 'Cancelled') {
                        subtractFileWeightFromBatch(fileId);
                    } else {
                        perFileProgressRef.current.set(fileId, 0);
                    }
                    updateFileUploadStatus(
                        fileId,
                        file,
                        0,
                        status,
                        getStartTime(),
                        message,
                        displayPath,
                        displayFileSize
                    );
                    safeUpdateOverallProgress();
                    uploadCompletionTracker.current.complete(fileId);
                    options?.onResumeHintsRefresh?.();
                },
                captureQuotaError: options?.captureQuotaError ?? captureUploadQuotaError,
            }),
        };
    }, [
        captureUploadQuotaError,
        markFileUploadComplete,
        safeUpdateOverallProgress,
        subtractFileWeightFromBatch,
        updateFileUploadStatus,
        markUnitAsUploading,
    ]);

    const buildSmallFileBatchCallbacks = useCallback((
        captureQuotaError: (error: unknown) => void
    ): SmallFileUploadCallbacks => ({
        onProgress: (id, f, clamped, relPath) => {
            createUnitUploadCallbacks({ fileId: id, file: f, displayPath: relPath || f.name }).reportProgress(
                clamped,
                { status: clamped >= 100 ? 'Completed' : 'Uploading' }
            );
        },
        onRetry: (id, f, attempt, maxRetries, relPath) => {
            createUnitUploadCallbacks({ fileId: id, file: f, displayPath: relPath || f.name })
                .setRetrying(attempt, maxRetries);
        },
        onSuccess: (id, f, relPath) => {
            createUnitUploadCallbacks({ fileId: id, file: f, displayPath: relPath || f.name }).setCompleted();
        },
        onFailure: (id, f, lastErr, relPath) => {
            const unit = createUnitUploadCallbacks({ fileId: id, file: f, displayPath: relPath || f.name });
            unit.setFailed(
                String((lastErr as { message?: string })?.message ?? '').toLowerCase().includes('cancel')
                    ? 'Cancelled'
                    : 'Error',
                (lastErr as { message?: string })?.message
            );
            return unit.toSmallFailureCounts(lastErr);
        },
        onUnitStart: (id) => markUnitAsUploading(id),
        onUnitComplete: (id) => uploadCompletionTracker.current.complete(id),
        captureQuotaError,
    }), [createUnitUploadCallbacks, markUnitAsUploading]);

    const uploadRefreshLoop = useRef({
        isRunning: false,
        timerId: null as ReturnType<typeof setTimeout> | null,
        stopTimerId: null as ReturnType<typeof setTimeout> | null,
        lastProgressAt: 0,
    });

    useEffect(() => {
        const loop = uploadRefreshLoop.current;

        const tick = () => {
            if (!loop.isRunning) return;

            const now = Date.now();
            const hasUploads = uploadStatusRef.current.size > 0;
            const hasActive = Array.from(uploadStatusRef.current.values()).some(
                (status) => isActiveUploadStatus(status.status)
            );

            if (hasUploads) {
                const progressInterval = hasActive ? 200 : 500;
                if (now - loop.lastProgressAt >= progressInterval) {
                    safeUpdateOverallProgress();
                    loop.lastProgressAt = now;
                }
            }

            loop.timerId = setTimeout(tick, hasActive || hasUploads ? 100 : 1000);
        };

        const startLoop = () => {
            if (loop.stopTimerId) {
                clearTimeout(loop.stopTimerId);
                loop.stopTimerId = null;
            }
            if (loop.isRunning) return;
            loop.isRunning = true;
            loop.lastProgressAt = 0;
            tick();
        };

        const scheduleStop = () => {
            if (loop.stopTimerId) clearTimeout(loop.stopTimerId);
            loop.stopTimerId = setTimeout(() => {
                if (uploadStatusRef.current.size === 0) {
                    loop.isRunning = false;
                    if (loop.timerId) {
                        clearTimeout(loop.timerId);
                        loop.timerId = null;
                    }
                }
            }, 1000);
        };

        if (uploadStatus.size > 0) {
            startLoop();
        } else if (loop.isRunning) {
            scheduleStop();
        }

        return () => {
            if (loop.stopTimerId) {
                clearTimeout(loop.stopTimerId);
                loop.stopTimerId = null;
            }
        };
    }, [uploadStatus, safeUpdateOverallProgress]);

    const cleanupUploadState = useCallback((expectedGeneration?: number) => {
        if (
            expectedGeneration != null
            && uploadBatchGenerationRef.current !== expectedGeneration
        ) {
            return;
        }
        chunkedUploadManagersRef.current.clear();
        uploadStatusRef.current = new Map();
        setUploadStatus(new Map());
        perFileProgressRef.current.clear();
        uploadBatchWeightRef.current = 1;
        uploadInterruptedRef.current = false;
        setUploadInterrupted(false);
        dispatch(setUploadSettings({ uploadProgress: 0 }));
    }, [dispatch]);

    const cancelChunkedUpload = useCallback(async (fileId: string) => {
        const cancelManagerForFile = async (targetFileId: string, updateUi: boolean) => {
            const manager = chunkedUploadManagersRef.current.get(targetFileId);
            if (!manager) return false;
            try {
                await manager.cancel();
                if (updateUi) {
                    uploadInterruptedRef.current = true;
                    if (totalUploadFilesRef.current > 0) {
                        totalUploadFilesRef.current--;
                    }
                    dispatch(setUploadSettings({ uploadTotalFiles: totalUploadFilesRef.current }));
                    setUploadStatus((prev) => {
                        const newMap = new Map(prev);
                        const currentStatus = newMap.get(targetFileId);
                        if (currentStatus) {
                            newMap.set(targetFileId, {
                                ...currentStatus,
                                status: 'Cancelled',
                                error: 'Upload cancelled',
                                progress: 0,
                            });
                        }
                        uploadStatusRef.current = newMap;
                        return newMap;
                    });
                    setUploadInterrupted(true);
                    setTimeout(() => safeUpdateOverallProgress(), 50);
                }
                return true;
            } catch (error) {
                if (updateUi && isCancelBlockedWhileMerging(error)) {
                    setUploadStatus((prev) => {
                        const current = prev.get(targetFileId);
                        if (!current) return prev;
                        const newMap = new Map(prev).set(targetFileId, {
                            ...current,
                            status: 'Merging',
                            progress: Math.max(current.progress, UPLOAD_PROGRESS_PRE_MERGE_MAX),
                            mergeStartedAt: current.mergeStartedAt ?? Date.now(),
                            error: mapUploadErrorMessage(error),
                        });
                        uploadStatusRef.current = newMap;
                        return newMap;
                    });
                } else if (updateUi) {
                    console.error(`Failed to cancel upload for ${targetFileId}:`, error);
                }
                return false;
            }
        };

        const manager = chunkedUploadManagersRef.current.get(fileId);
        if (manager) {
            await cancelManagerForFile(fileId, true);
            return;
        }

        const zarrCancelled = await cancelZarrUploadSession(
            fileId,
            zarrSessionStoreRef.current,
            (childFileId) => cancelManagerForFile(childFileId, false).then(() => undefined)
        );
        if (zarrCancelled) {
            uploadInterruptedRef.current = true;
            if (totalUploadFilesRef.current > 0) {
                totalUploadFilesRef.current--;
            }
            dispatch(setUploadSettings({ uploadTotalFiles: totalUploadFilesRef.current }));
            setUploadStatus((prev) => {
                const newMap = new Map(prev);
                const currentStatus = newMap.get(fileId);
                if (currentStatus) {
                    newMap.set(fileId, {
                        ...currentStatus,
                        status: 'Cancelled',
                        error: 'Upload cancelled',
                        progress: 0,
                    });
                }
                uploadStatusRef.current = newMap;
                return newMap;
            });
            setUploadInterrupted(true);
            uploadCompletionTracker.current.complete(fileId);
            setTimeout(() => safeUpdateOverallProgress(), 50);
        }
    }, [dispatch, safeUpdateOverallProgress]);

    return {
        uploadStatus,
        uploadInterrupted,
        setUploadInterrupted,
        uploadStatusRef,
        perFileProgressRef,
        uploadBatchWeightRef,
        uploadBatchGenerationRef,
        totalUploadFilesRef,
        uploadQuotaErrorRef,
        uploadInterruptedRef,
        chunkedUploadManagersRef,
        zarrSessionStoreRef,
        uploadCompletionTracker,
        hasActiveUploadStatuses,
        initializeUploadStatusBatch,
        updateFileUploadStatus,
        subtractFileWeightFromBatch,
        markFileUploadComplete,
        safeUpdateOverallProgress,
        captureUploadQuotaError,
        createUnitUploadCallbacks,
        buildSmallFileBatchCallbacks,
        cleanupUploadState,
        cancelChunkedUpload,
    };
}
