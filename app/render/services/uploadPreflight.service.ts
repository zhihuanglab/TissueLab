import { getConfig } from '@/services/fileManager.service';
import {
    computeKeepBothPaths,
    detectUploadConflicts,
    filterValidUploadFiles,
    type UploadConflictInfo,
} from '@/services/uploadBatch.utils';

export type UploadConflictChoice = 'cancel' | 'overwrite' | 'keep_both';

export interface StorageConfigSnapshot {
    storageQuota?: number | null;
    storageUsage?: number;
}

export interface UploadPreflightResult {
    validFiles: File[];
    pathsForUpload?: string[];
    effectiveRelPaths?: string[];
    hasConflicts: boolean;
    keepBoth: boolean;
    uploadTargetPath: string;
    totalIncomingBytes: number;
}

export interface UploadPreflightParams {
    files: FileList | File[];
    relativePaths?: string[];
    forceOverwrite: boolean;
    resolveUploadTargetPath: () => Promise<string>;
    listExistingNames: (targetPath: string) => Promise<Set<string>>;
    getStorageConfig?: () => Promise<StorageConfigSnapshot | null>;
    onQuotaExceeded?: (totalBytes: number) => void;
    promptConflict?: (input: UploadConflictInfo & {
        validFiles: File[];
        effectiveRelPaths?: string[];
    }) => Promise<UploadConflictChoice>;
}

export type UploadPreflightOutcome =
    | UploadPreflightResult
    | 'no_valid_files'
    | 'quota_exceeded'
    | 'cancelled';

export async function runUploadPreflight(
    params: UploadPreflightParams
): Promise<UploadPreflightOutcome> {
    const fileArray = Array.from(params.files);
    const { validFiles, effectiveRelPaths } = filterValidUploadFiles(
        fileArray,
        params.relativePaths
    );

    if (validFiles.length === 0) {
        return 'no_valid_files';
    }

    const totalIncomingBytes = validFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    const uploadTargetPath = await params.resolveUploadTargetPath();
    const loadStorageConfig = params.getStorageConfig ?? (async () => getConfig());

    try {
        const cfg = await loadStorageConfig();
        const quota = typeof cfg?.storageQuota === 'number' ? cfg.storageQuota : null;
        const usage = typeof cfg?.storageUsage === 'number' ? cfg.storageUsage : 0;
        if (quota !== null && usage + totalIncomingBytes > quota) {
            params.onQuotaExceeded?.(totalIncomingBytes);
            return 'quota_exceeded';
        }
    } catch (error) {
        console.warn('Failed to pre-check storage quota before upload:', error);
    }

    let hasConflicts = false;
    let keepBoth = false;
    let listingExistingNames: Set<string> | null = null;

    if (!params.forceOverwrite) {
        try {
            listingExistingNames = await params.listExistingNames(uploadTargetPath);
            const conflict = detectUploadConflicts({
                validFiles,
                effectiveRelPaths,
                existingNames: listingExistingNames,
            });

            if (conflict && params.promptConflict) {
                const choice = await params.promptConflict({
                    ...conflict,
                    validFiles,
                    effectiveRelPaths,
                });
                if (choice === 'cancel') {
                    return 'cancelled';
                }
                hasConflicts = choice === 'overwrite';
                keepBoth = choice === 'keep_both';
            }
        } catch (error) {
            console.warn('Failed to check for existing files:', error);
        }
    } else {
        hasConflicts = true;
    }

    let pathsForUpload = effectiveRelPaths;
    if (keepBoth) {
        try {
            const existingNames = listingExistingNames
                ?? await params.listExistingNames(uploadTargetPath);
            const keepBothResult = computeKeepBothPaths({
                validFiles,
                effectiveRelPaths,
                existingNames,
            });
            pathsForUpload = keepBothResult.pathsForUpload ?? effectiveRelPaths;
            keepBoth = keepBothResult.keepBoth;
        } catch (error) {
            console.warn('Failed to compute keep-both paths:', error);
        }
    }

    return {
        validFiles,
        pathsForUpload,
        effectiveRelPaths,
        hasConflicts,
        keepBoth,
        uploadTargetPath,
        totalIncomingBytes,
    };
}
