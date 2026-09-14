import { COMMUNITY_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { FmApiError } from '@/services/fmApiError';
import { apiFetch } from '@/utils/common/apiFetch';
import { getAuthToken } from '@/utils/common/authToken';
import { sanitizeFilename } from '@/utils/common/string.utils';
import Cookies from 'js-cookie';
import { getAuth } from 'firebase/auth';
import { app } from '@/config/firebase.config';
import {
    buildChunkUploadSessionKey,
    CHUNK_UPLOAD_CONCURRENCY,
    CHUNK_UPLOAD_MIN_BYTES,
    CHUNK_UPLOAD_PERSIST_INTERVAL_MS,
    clearPersistedChunkUploadSession,
    computeChunkUploadTimeoutMs,
    computeCompleteRetryAttempts,
    computeCompleteUploadTimeoutMs,
    isAbortError,
    isCancelBlockedWhileMerging,
    isMergeInProgressError,
    isRequestQuotaExceededError,
    computeRetryDelayMs,
    loadPersistedChunkUploadSession,
    pickChunkSizeForFile,
    pickZarrBatchMaxBytesForTotalSize,
    progressBeforeMergeFromRatio,
    savePersistedChunkUploadSession,
    shouldRetryCompleteUpload,
    uploadedChunksFromStatus,
    withUploadTimeout,
    ZARR_BATCH_UPLOAD_MAX_FILES,
    type PersistedChunkUploadSession,
} from '@/services/chunkedUpload.utils';

export type { ChunkUploadResumeHint, PersistedChunkUploadSession, PersistedZarrBatchUploadSession } from '@/services/chunkedUpload.utils';

export interface ZarrBatchFileEntry {
    file: File;
    relativePath: string;
}

interface ZarrBatchHeaderEntry {
    relativePath: string;
    offset: number;
    length: number;
    name: string;
    size: number;
}

const isAppResponseBody = (value: unknown): value is { code: number; message: string; data?: unknown } => {
    return (
        typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof (value as { code?: unknown }).code === 'number' &&
        'message' in value &&
        typeof (value as { message?: unknown }).message === 'string'
    );
};

const buildFmApiError = (payload: any, statusFallback: number, isAppErrorWrapped: boolean = false): FmApiError => {
    const detailObj = (payload?.detail && typeof payload.detail === 'object') ? payload.detail : null;
    const appData = (payload?.data && typeof payload.data === 'object') ? payload.data : null;
    const structured = {
        ...(appData || {}),
        ...(detailObj || {}),
        ...(payload || {}),
    };
    const rawDetail = detailObj ?? payload?.detail;
    const rawMsg = payload?.message
        ?? (typeof rawDetail === 'string' ? rawDetail : undefined)
        ?? payload?.error
        ?? `Request failed with status ${statusFallback}`;
    const status = (typeof payload?.code === 'number' && payload.code !== 0) ? payload.code : statusFallback;
    const msgStr = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);

    return new FmApiError(msgStr, {
        status,
        isAppErrorWrapped,
        errorCode: structured?.error_code != null ? String(structured.error_code) : '',
        accessMode: structured?.access_mode != null ? String(structured.access_mode) : '',
        operation: structured?.operation != null ? String(structured.operation) : '',
        requestId: String(
            payload?.request_id
            ?? structured?.request_id
            ?? ''
        ),
        requiredBytes: structured?.required_bytes !== undefined ? Number(structured.required_bytes) : null,
        availableBytes: structured?.available_bytes !== undefined ? Number(structured.available_bytes) : null,
        quotaBytes: structured?.quota_bytes !== undefined ? Number(structured.quota_bytes) : null,
        retryAfter: structured?.retry_after !== undefined ? Number(structured.retry_after) : null,
    });
};

let cachedDefaultPath: string | null = null;
const getDefaultPath = async (): Promise<string> => {
    if (cachedDefaultPath) return cachedDefaultPath;
    const cfg = await getConfig();
    cachedDefaultPath = (cfg?.defaultPath || '').replace(/\\/g, '/');
    return cachedDefaultPath || '';
};

const handleResponse = async (response: Response) => {
    const body = await response.json().catch(() => ({ error: 'Invalid JSON response' }));

    if (isAppResponseBody(body)) {
        if (body.code !== 0) {
            throw buildFmApiError(body, body.code, true);
        }
        return body.data ?? {};
    }

    if (!response.ok) {
        throw buildFmApiError(body, response.status);
    }
    return body;
};


export interface ListFilesPagination {
    offset: number;
    limit: number | null;
    total: number;
    has_more: boolean;
}

export interface ListFilesPage {
    items: any[];
    pagination: ListFilesPagination;
}

/**
 * Server-side view options. Only take effect with `limit`; without it the
 * endpoint returns a bare array of the whole directory, which is what the
 * whole-listing callers (upload preflight, sidebar browsers, study page) want.
 */
export interface ListFilesOptions {
    sortBy?: 'name' | 'mtime' | 'size' | 'type';
    sortDir?: 'asc' | 'desc';
    /** false keeps only folders, WSI and zarr rows (the "show non-image files" toggle). */
    includeNonImage?: boolean;
    /** Fold each .zarr store into its WSI row as `attachedZarrPath`. */
    groupZarr?: boolean;
    /** Navigable folders only — for the move-to destination picker. */
    dirsOnly?: boolean;
}

export const listFiles = async (
    path: string,
    offset: number = 0,
    limit?: number | null,
    options?: ListFilesOptions,
) => {
    const effective = path && path.trim() ? path : await getDefaultPath();
    const params = new URLSearchParams({ path: effective, offset: String(offset) });
    if (limit !== undefined && limit !== null) {
        params.set('limit', String(limit));
    }
    // `sortConfig` is restored from localStorage, so a value written by an older
    // build could reach the server; the endpoint validates strictly and would
    // 422. Clamp to the known set instead of failing the whole listing.
    const SORT_KEYS = ['name', 'mtime', 'size', 'type'];
    if (options?.sortBy) params.set('sort_by', SORT_KEYS.includes(options.sortBy) ? options.sortBy : 'mtime');
    if (options?.sortDir) params.set('sort_dir', options.sortDir === 'asc' ? 'asc' : 'desc');
    if (options?.includeNonImage !== undefined) params.set('include_non_image', String(options.includeNonImage));
    if (options?.groupZarr !== undefined) params.set('group_zarr', String(options.groupZarr));
    if (options?.dirsOnly !== undefined) params.set('dirs_only', String(options.dirsOnly));

    const response = await apiFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files?${params.toString()}`,
        { method: 'GET', isReturnResponse: true },
    );
    // Either shape passes through untouched: a bare array (no `limit`), or
    // `{ items, pagination }` when the server did the filtering/sorting/slicing.
    return await handleResponse(response as Response);
};

/**
 * One page of a directory, always in the paginated shape. Callers that render a
 * pager should use this rather than `listFiles` so a large folder never crosses
 * the wire in full.
 *
 * `limit === null` is the pager's "All": it asks the server for every row, but
 * still with filtering / grouping / sorting applied there, so the client never
 * has to reproduce that pipeline.
 */
export const listFilesPage = async (
    path: string,
    offset: number,
    limit: number | null,
    options?: ListFilesOptions,
): Promise<ListFilesPage> => {
    // `limit=0` is the wire encoding for "no page limit" — distinct from
    // omitting `limit`, which asks for the whole directory as a bare array.
    const data = await listFiles(path, limit === null ? 0 : offset, limit === null ? 0 : limit, options);
    return {
        items: Array.isArray(data?.items) ? data.items : [],
        pagination: {
            offset: data?.pagination?.offset ?? (limit === null ? 0 : offset),
            limit: data?.pagination?.limit ?? limit,
            total: data?.pagination?.total ?? 0,
            has_more: !!data?.pagination?.has_more,
        },
    };
};

export const downloadFile = async (
    path: string,
    suggestedFilename?: string,
    onProgress?: (progress: { state: string; receivedBytes?: number; totalBytes?: number; percent?: number }) => void
): Promise<{ ok: boolean; cancelled?: boolean; target?: string } | void> => {
    // Unified download entry: create token and hand off to Electron/browser download manager
    const linkData = await createDownloadLink(path);
    const directUrl = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/download/${linkData.download_token}`;
    const filename = suggestedFilename && suggestedFilename.trim() ? suggestedFilename : 'download';

    if (isElectronEnv()) {
        // Set up progress listener if provided
        if (onProgress && (window as any).electron?.on) {
            const progressHandler = (payload: any) => {
                try {
                    if (!payload || payload.url !== directUrl) return;
                    const { state, receivedBytes, totalBytes } = payload;
                    if (state === 'progressing' && totalBytes > 0) {
                        const percent = Math.max(0, Math.min(100, Math.round(receivedBytes / totalBytes * 100)));
                        onProgress({ state, receivedBytes, totalBytes, percent });
                    } else {
                        onProgress({ state });
                    }
                } catch {}
            };

            (window as any).electron.on('download-progress', progressHandler);

            try {
                const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
                return result;
            } finally {
                // Clean up listener
                if ((window as any).electron?.off) {
                    (window as any).electron.off('download-progress', progressHandler);
            }
        }
        } else {
            return await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
        }
    }

    const a = document.createElement('a');
    a.href = directUrl;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// Create a temporary download link for a file
export const createDownloadLink = async (path: string): Promise<{
    download_token: string;
    expires_in: number;
    expires_at: number;
}> => {
    const effective = path && path.trim() ? path : await getDefaultPath();
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/download-link?path=${encodeURIComponent(effective)}`, {
        method: 'POST',
        isReturnResponse: true,
    });
    return await handleResponse(response as Response);
};

/** In-viewer load token (read ACL). For Niivue/radiology volumes on Samples/Viewer. */
export const createViewLink = async (path: string): Promise<{
    download_token: string;
    expires_in: number;
    expires_at: number;
    purpose?: string;
}> => {
    const effective = path && path.trim() ? path : await getDefaultPath();
    const response = await apiFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/view-link?path=${encodeURIComponent(effective)}`,
        {
            method: 'POST',
            isReturnResponse: true,
        },
    );
    return await handleResponse(response as Response);
};

// Download a file using a direct link token (no authentication required)
export const downloadFileDirect = async (token: string): Promise<Blob> => {
    const response = await fetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/download/${token}`, {
        method: 'GET',
    });
    
    if (!response.ok) {
        try {
            const data = await response.json();
            throw new Error(data.detail || data.error || `Request failed with status ${response.status}`);
        } catch {
            throw new Error(`Request failed with status ${response.status}`);
        }
    }
    return await response.blob();
};

// Detect Electron renderer
const isElectronEnv = (): boolean => {
    try {
        return typeof window !== 'undefined' && !!(window as any).electron && typeof (window as any).electron.invoke === 'function';
    } catch (_) {
        return false;
    }
};

// Unified download entry: create token link and hand off to OS/browser/Electron download manager
export const startDownload = async (
    path: string,
    suggestedFilename?: string
): Promise<{ ok: boolean; cancelled?: boolean; target?: string } | void> => {
    const linkData = await createDownloadLink(path);
    const directUrl = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/download/${linkData.download_token}`;
    const filename = suggestedFilename && suggestedFilename.trim() ? suggestedFilename : 'download';

    if (isElectronEnv()) {
        // Let Chromium download manager handle the download
        const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
        return result;
    }

    // Browser: trigger download via an anchor tag to allow native download manager
    const a = document.createElement('a');
    a.href = directUrl;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
};

// Community: create token link and download classifier with progress (Electron) or anchor (browser)
export const downloadCommunityClassifier = async (
    classifierId: string,
    suggestedFilename?: string,
    onProgress?: (progress: { state: string; receivedBytes?: number; totalBytes?: number; percent?: number }) => void
) => {
    const resp = await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/${encodeURIComponent(classifierId)}/download-link`, {
        method: 'POST',
        isReturnResponse: true,
    });
    const data = await handleResponse(resp as Response);
    const token = data?.download_token as string;
    if (!token) throw new Error('Failed to obtain classifier download token');
    const directUrl = `${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/download/${token}`;
    const filename = suggestedFilename && suggestedFilename.trim() ? suggestedFilename : 'classifier.bin';

    if (isElectronEnv()) {
        if (onProgress && (window as any).electron?.on) {
            const progressHandler = (payload: any) => {
                try {
                    if (!payload || payload.url !== directUrl) return;
                    const { state, receivedBytes, totalBytes } = payload;
                    if (state === 'progressing' && totalBytes > 0) {
                        const percent = Math.max(0, Math.min(100, Math.round(receivedBytes / totalBytes * 100)));
                        onProgress({ state, receivedBytes, totalBytes, percent });
                    } else {
                        onProgress({ state });
                    }
                } catch {}
            };
            (window as any).electron.on('download-progress', progressHandler);
            try {
                const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
                return result;
            } finally {
                if ((window as any).electron?.off) {
                    (window as any).electron.off('download-progress', progressHandler);
            }
        }
        }
        const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
        return result;
    }

    const a = document.createElement('a');
    a.href = directUrl;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
};

export const downloadCommunityModel = async (
    modelId: string,
    suggestedFilename?: string,
    onProgress?: (progress: { state: string; receivedBytes?: number; totalBytes?: number; percent?: number }) => void
) => {
    const resp = await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/models/${encodeURIComponent(modelId)}/download-link`, {
        method: 'POST',
        isReturnResponse: true,
    });
    const data = await handleResponse(resp as Response);
    const token = data?.download_token as string;
    if (!token) throw new Error('Failed to obtain model download token');
    const directUrl = `${COMMUNITY_API_ENDPOINT}/community/v1/models/download/${token}`;
    const filename = suggestedFilename && suggestedFilename.trim() ? suggestedFilename : 'model.zip';

    if (isElectronEnv()) {
        if (onProgress && (window as any).electron?.on) {
            const progressHandler = (payload: any) => {
                try {
                    if (!payload || payload.url !== directUrl) return;
                    const { state, receivedBytes, totalBytes } = payload;
                    if (state === 'progressing' && totalBytes > 0) {
                        const percent = Math.max(0, Math.min(100, Math.round(receivedBytes / totalBytes * 100)));
                        onProgress({ state, receivedBytes, totalBytes, percent });
                    } else {
                        onProgress({ state });
                    }
                } catch {}
            };
            (window as any).electron.on('download-progress', progressHandler);
            try {
                const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
                return result;
            } finally {
                if ((window as any).electron?.off) {
                    (window as any).electron.off('download-progress', progressHandler);
            }
        }
        }
        const result = await (window as any).electron.invoke('download-signed-url', { url: directUrl, filename });
        return result;
    }

    const a = document.createElement('a');
    a.href = directUrl;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
};

export const searchFiles = async (
    query: string,
    scope?: string,
): Promise<{ items: any[]; truncated: boolean }> => {
    let url = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/search?query=${encodeURIComponent(query)}`;
    if (scope && scope.trim()) {
        url += `&scope=${encodeURIComponent(scope.trim())}`;
    }
    const response = (await apiFetch(url, { method: 'GET', isReturnResponse: true })) as Response;
    // The backend caps the result set; without this the UI would quietly show
    // a short list and look like the file simply isn't there.
    const truncated = response.headers?.get('X-Search-Truncated') === '1';
    const body = await handleResponse(response);
    return { items: Array.isArray(body) ? body : [], truncated };
};

/** Lightweight ACL peek — shareMode for an open path. */
export const getFileAccess = async (path: string): Promise<{
    path?: string;
    shareMode?: 'share' | 'collaborate' | 'view' | null;
    // Open edition: the local service also reports read-only roots (Samples).
    readOnly?: boolean;
}> => {
    const response = await apiFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/access?path=${encodeURIComponent(path)}`,
        { method: 'GET', isReturnResponse: true },
    );
    return handleResponse(response as Response);
};

/**
 * Five independent consumers request `/fm/v1/config` on a dashboard mount, and
 * the backend recomputes the Firestore storage-usage aggregation for each — a
 * large part of the post-login stall, with WebFileManager unable to mount until
 * the first lands.
 *
 * Concurrent callers now share one request, reusable for a short window after.
 * Keyed by uid so a user switch never inherits the previous `defaultPath`.
 * Pass `forceRefresh` when the quota must be recomputed (post-upload).
 */
const CONFIG_CACHE_TTL_MS = 3000;
/** uid the cached request belongs to — a user switch must not inherit it. */
let configKey: string | null = null;
let configFetchedAt = 0;
let configRequest: Promise<any> | null = null;

const currentConfigCacheKey = (): string => {
    try {
        return getAuth(app).currentUser?.uid || 'guest';
    } catch {
        return 'guest';
    }
};

const invalidateConfigCache = () => {
    configKey = null;
    configFetchedAt = 0;
    configRequest = null;
};

export const getConfig = async (forceRefresh: boolean = false) => {
    const key = currentConfigCacheKey();
    if (forceRefresh || key !== configKey || Date.now() - configFetchedAt > CONFIG_CACHE_TTL_MS) {
        configKey = key;
        configFetchedAt = Date.now();
        configRequest = (async () => {
            const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/config`, { method: 'GET', isReturnResponse: true });
            const data = await handleResponse(response as Response);
            // The signed-in user can change between reading `key` above and the
            // ID token apiFetch attached, so this response may describe the other
            // account. Drop it rather than let the next caller inherit an
            // anonymous `defaultPath` under a real uid.
            if (currentConfigCacheKey() !== key) invalidateConfigCache();
            return data;
        })().catch((err) => {
            invalidateConfigCache();
            throw err;
        });
    }
    return configRequest;
};

export const createFile = async (path: string, content?: string) => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/create`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const createFolder = async (path: string) => {
    if (!path.endsWith('/')) {
        path += '/';
    }
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/create`, {
        method: 'POST',
        body: JSON.stringify({ path }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const renameFile = async (oldPath: string, newPath: string) => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/rename`, {
        method: 'POST',
        body: JSON.stringify({ path: oldPath, new_path: newPath }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const deleteFiles = async (
    items: string[],
    onStatusUpdate?: (status: string, data?: any) => void,
    waitForCompletion: boolean = true
): Promise<{ success: boolean; task_id?: string; message?: string }> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/delete`, {
        method: 'POST',
        body: JSON.stringify({ items }),
        isReturnResponse: true,
    });
    const result = await handleResponse(response as Response);
    
    // Use SSE for real-time status updates if task_id is returned
    if (waitForCompletion && result.task_id) {
        return await subscribeTaskStatus(result.task_id, onStatusUpdate);
    }
    
    // If no task_id, return immediately (e.g., no items to delete)
    if (!result.task_id) {
        console.warn('[deleteFiles] No task_id returned, deletion may be immediate or items not found');
    }
    
    return result;
};

export interface UploadFilesOptions {
    /**
     * API base to upload to. Defaults to the local service; the community
     * publish flows pass `COMMUNITY_API_ENDPOINT` so the classifier / model file
     * lands in the hosted TissueLab storage the community serves downloads from.
     */
    endpoint?: string;
}

export const uploadFiles = (
    path: string,
    files: FileList,
    onProgress: (percent: number) => void,
    overwrite: boolean = false,
    relativePaths?: string[],
    keepBoth: boolean = false,
    options: UploadFilesOptions = {}
): Promise<any> => {
    const endpoint = options.endpoint || CTRL_SERVICE_API_ENDPOINT;
    const formData = new FormData();
    const setEffectivePath = async () => (path && path.trim()) ? path : await getDefaultPath();
    // We'll resolve effective path right before sending
    for (let i = 0; i < files.length; i++) {
        const original = files[i];
        const safeName = sanitizeFilename(original.name);
        const fileToSend = safeName !== original.name
            ? new File([original], safeName, { type: original.type })
            : original;
        formData.append('files', fileToSend);
    }

    return new Promise(async (resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                const percentComplete = progressBeforeMergeFromRatio(event.loaded / event.total);
                onProgress(percentComplete);
            }
        });

        xhr.addEventListener('load', () => {
            let parsedBody: any = null;
            if (xhr.responseText) {
                try {
                    parsedBody = JSON.parse(xhr.responseText);
                } catch {
                    parsedBody = null;
                }
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                if (isAppResponseBody(parsedBody)) {
                        if (parsedBody.code !== 0) {
                            reject(buildFmApiError(parsedBody, parsedBody.code, true));
                            return;
                        }
                    onProgress(100); // Only confirmed application success reaches 100%.
                    resolve(parsedBody.data ?? {});
                    return;
                }
                onProgress(100);
                resolve(parsedBody ?? { success: true });
            } else {
                if (parsedBody && typeof parsedBody === 'object') {
                    reject(buildFmApiError(parsedBody, xhr.status));
                    return;
                }
                reject(new Error(`Request failed with status ${xhr.status}`));
            }
        });

        xhr.addEventListener('error', () => {
            reject(new Error('Upload failed due to a network error.'));
        });

        const applyFormDataAndOpen = (effective: string) => {
            formData.set('path', effective);
            formData.set('overwrite', keepBoth ? 'false' : overwrite.toString());
            if (keepBoth) formData.set('keep_both', 'true');
            if (relativePaths && relativePaths.length > 0) {
                formData.set('relative_paths', JSON.stringify(relativePaths));
            }
            xhr.open('POST', `${endpoint}/fm/v1/files/upload`, true);
        };
        try {
            const effective = await setEffectivePath();
            applyFormDataAndOpen(effective);
            const token = await getAuthToken();
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        } catch (e) {
            const effective = await setEffectivePath();
            applyFormDataAndOpen(effective);
        }
        xhr.send(formData);
    });
};

export const uploadZarrManifest = async (
    path: string,
    files: Array<{ relativePath: string; size: number }>,
    overwrite: boolean = false,
    keepBoth: boolean = false,
    maxBatchBytes?: number
): Promise<any> => {
    const effective = (path && path.trim()) ? path : await getDefaultPath();
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    const resolvedMaxBatchBytes = maxBatchBytes ?? pickZarrBatchMaxBytesForTotalSize(totalBytes);
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/manifest`, {
        method: 'POST',
        body: JSON.stringify({
            path: effective,
            overwrite: keepBoth ? false : overwrite,
            keep_both: keepBoth,
            upload_type: 'zarr-batch',
            batch: {
                max_batch_bytes: resolvedMaxBatchBytes,
                max_batch_files: ZARR_BATCH_UPLOAD_MAX_FILES,
            },
            files: files.map((f) => ({ ...f, relativePath: f.relativePath.replace(/\\/g, '/') })),
        }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

const buildZarrBatchBlob = async (
    entries: ZarrBatchFileEntry[],
    batchIndex: number,
    totalBatches: number,
    uploadId?: string
): Promise<Blob> => {
    let offset = 0;
    const headerFiles: ZarrBatchHeaderEntry[] = [];
    const payloadParts: Blob[] = [];

    for (const entry of entries) {
        const length = entry.file.size;
        headerFiles.push({
            relativePath: entry.relativePath.replace(/\\/g, '/'),
            offset,
            length,
            name: entry.file.name,
            size: entry.file.size,
        });
        payloadParts.push(entry.file);
        offset += length;
    }

    const header = {
        version: 1,
        uploadId,
        batchIndex,
        totalBatches,
        files: headerFiles,
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const prefix = new ArrayBuffer(8);
    const view = new DataView(prefix);
    view.setBigUint64(0, BigInt(headerBytes.byteLength), true);

    return new Blob([prefix, headerBytes, ...payloadParts], { type: 'application/octet-stream' });
};

export const uploadZarrBatch = async (
    path: string,
    entries: ZarrBatchFileEntry[],
    batchIndex: number,
    totalBatches: number,
    overwrite: boolean = false,
    keepBoth: boolean = false,
    uploadId?: string,
    options?: { signal?: AbortSignal }
): Promise<any> => {
    const effective = (path && path.trim()) ? path : await getDefaultPath();
    const batchBlob = await buildZarrBatchBlob(entries, batchIndex, totalBatches, uploadId);
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/zarr-batch`, {
        method: 'POST',
        body: batchBlob,
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Path': effective,
            'X-Overwrite': keepBoth ? 'false' : String(overwrite),
            'X-Keep-Both': keepBoth ? 'true' : 'false',
            'X-Batch-Index': String(batchIndex),
            'X-Total-Batches': String(totalBatches),
            ...(uploadId ? { 'X-Upload-Id': uploadId } : {}),
        },
        isReturnResponse: true,
        signal: options?.signal,
    });
    return handleResponse(response as Response);
};

export const uploadZarrBatchWithTimeout = async (
    path: string,
    entries: ZarrBatchFileEntry[],
    batchIndex: number,
    totalBatches: number,
    overwrite: boolean = false,
    keepBoth: boolean = false,
    uploadId?: string,
    options?: { signal?: AbortSignal }
): Promise<any> => {
    const batchBytes = entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0);
    return withUploadTimeout(
        computeChunkUploadTimeoutMs(batchBytes),
        (signal) => uploadZarrBatch(path, entries, batchIndex, totalBatches, overwrite, keepBoth, uploadId, { signal }),
        options?.signal
    );
};

export const completeZarrBatchUpload = async (
    path: string,
    uploadId: string | undefined,
    totalBatches: number,
    options?: { signal?: AbortSignal }
): Promise<any> => {
    const effective = (path && path.trim()) ? path : await getDefaultPath();
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/complete`, {
        method: 'POST',
        body: JSON.stringify({
            upload_type: 'zarr-batch',
            upload_id: uploadId,
            path: effective,
            total_batches: totalBatches,
        }),
        isReturnResponse: true,
        signal: options?.signal,
    });
    return handleResponse(response as Response);
};

export const completeZarrBatchUploadWithTimeout = async (
    path: string,
    uploadId: string | undefined,
    totalBatches: number,
    totalBytes: number
): Promise<any> => {
    return completeZarrBatchUploadWithRetry(path, uploadId, totalBatches, totalBytes);
};

export const completeZarrBatchUploadWithRetry = async (
    path: string,
    uploadId: string | undefined,
    totalBatches: number,
    totalBytes: number,
    options?: { signal?: AbortSignal; isCancelled?: () => boolean }
): Promise<any> => {
    const completeTimeoutMs = computeCompleteUploadTimeoutMs(totalBytes);
    const maxRetryAttempts = computeCompleteRetryAttempts(totalBytes);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetryAttempts; attempt++) {
        if (options?.isCancelled?.()) {
            throw new Error('Upload cancelled');
        }
        try {
            return await withUploadTimeout(
                completeTimeoutMs,
                (signal) => completeZarrBatchUpload(path, uploadId, totalBatches, { signal }),
                options?.signal
            );
        } catch (error) {
            lastError = error;
            const { retry, delayMs } = shouldRetryCompleteUpload(
                error,
                options?.isCancelled?.() ?? false,
                false
            );
            if (retry && attempt < maxRetryAttempts) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
            }
            break;
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? 'Zarr batch complete failed'));
};

export const cancelZarrBatchUpload = async (uploadId: string): Promise<any> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/zarr-batch/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const moveFiles = async (items: string[], newPath: string) => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/move`, {
        method: 'POST',
        body: JSON.stringify({ items, new_path: newPath }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
}; 

// Subscribe to task status updates via Server-Sent Events (SSE)
export const subscribeTaskStatus = async (
    taskId: string,
    onStatusUpdate?: (status: string, data?: any) => void,
    maxWaitTime: number = 300000 // 5 minutes max
): Promise<any> => {
    const startTime = Date.now();
    const remainingMs = () => Math.max(0, maxWaitTime - (Date.now() - startTime));

    const pollOnce = async (): Promise<{ done: boolean; result?: any; error?: string; missing?: boolean }> => {
        try {
            const response = await apiFetch(
                `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/task_status/${taskId}`,
                { method: 'GET', isReturnResponse: true }
            );
            const res = response as Response;
            if (res.status === 404) {
                // Completed tasks are removed from memory — result may already be gone.
                return { done: true, missing: true, error: 'Task not found or already finished' };
            }
            const data = await handleResponse(res);
            if (onStatusUpdate && data?.status) {
                onStatusUpdate(data.status, data);
            }
            if (data?.status === 'completed') {
                return { done: true, result: data.result || data };
            }
            if (data?.status === 'failed') {
                return { done: true, error: data.error || 'Task failed' };
            }
            return { done: false };
        } catch {
            return { done: false };
        }
    };

    const openStream = (token: string): Promise<any> =>
        new Promise((resolve, reject) => {
            const budget = remainingMs();
            if (budget <= 0) {
                reject(new Error('Task timeout: task took too long to complete'));
                return;
            }

            const url = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/task_status/${taskId}/stream?token=${encodeURIComponent(token)}`;
            const eventSource = new EventSource(url);
            let result: any = null;
            let settled = false;
            const timeoutId = setTimeout(() => {
                settle(() => reject(new Error('Task timeout: task took too long to complete')));
            }, budget);

            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                try {
                    eventSource.close();
                } catch {
                    /* ignore */
                }
                fn();
            };

            eventSource.addEventListener('status', (event: MessageEvent) => {
                try {
                    const data = JSON.parse(event.data);
                    if (onStatusUpdate) {
                        onStatusUpdate(data.status, data);
                    }
                    if (data.status === 'completed') {
                        result = data.result || data;
                        settle(() => resolve(result));
                    } else if (data.status === 'failed') {
                        settle(() => reject(new Error(data.error || 'Task failed')));
                    }
                } catch (e) {
                    console.error('Error parsing SSE status event:', e);
                }
            });

            eventSource.addEventListener('heartbeat', () => {
                /* keepalive — ignore */
            });

            eventSource.addEventListener('done', (event: MessageEvent) => {
                try {
                    const data = JSON.parse(event.data);
                    if (result) {
                        settle(() => resolve(result));
                    } else if (data.status === 'failed') {
                        settle(() => reject(new Error('Task failed')));
                    } else if (data.status === 'completed') {
                        // Missed the status payload (e.g. reconnect race) — fall back to HTTP poll.
                        settle(() =>
                            reject(Object.assign(new Error('SSE_RECONNECT'), { code: 'SSE_RECONNECT' }))
                        );
                    } else {
                        settle(() => resolve(result ?? data));
                    }
                } catch (e) {
                    console.error('Error parsing SSE done event:', e);
                }
            });

            eventSource.addEventListener('error', (event: MessageEvent) => {
                try {
                    const data = JSON.parse(event.data);
                    const msg = String(data.error || 'Task error');
                    // Task GC'd after completion — soft-reconnect so pollOnce can classify 404.
                    if (/not found/i.test(msg)) {
                        settle(() =>
                            reject(Object.assign(new Error('SSE_RECONNECT'), { code: 'SSE_RECONNECT' }))
                        );
                        return;
                    }
                    settle(() => reject(new Error(msg)));
                } catch {
                    // Named "error" events with non-JSON bodies fall through to onerror.
                }
            });

            eventSource.onerror = () => {
                // Do not hard-fail: proxies may idle-kill the stream while the task still runs.
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                try {
                    eventSource.close();
                } catch {
                    /* ignore */
                }
                reject(Object.assign(new Error('SSE_RECONNECT'), { code: 'SSE_RECONNECT' }));
            };
        });

    let attempt = 0;
    while (remainingMs() > 0) {
        const token =
            (await getAuthToken()) ||
            Cookies.get('tissuelab_token') ||
            process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN ||
            'local-default-token';
        try {
            return await openStream(token);
        } catch (err: any) {
            if (err?.message === 'Task timeout: task took too long to complete') {
                throw err;
            }
            if (err?.code !== 'SSE_RECONNECT' && err?.message !== 'SSE_RECONNECT') {
                throw err;
            }
            // Prefer a cheap poll before reopening the stream — may already be done.
            const polled = await pollOnce();
            if (polled.done) {
                if (polled.missing) {
                    throw new Error(polled.error || 'Task not found or already finished');
                }
                if (polled.error) throw new Error(polled.error);
                return polled.result;
            }
            attempt += 1;
            const delay = Math.min(800 * Math.pow(2, Math.min(attempt - 1, 4)), 8000, remainingMs());
            if (delay <= 0) break;
            console.warn(
                `[FileManager] task_status SSE disconnected; retrying in ${delay}ms (attempt ${attempt})`
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error('Task timeout: task took too long to complete');
};

export const compressItems = async (
    items: string[],
    destPath?: string,
    zipName?: string,
    overwrite: boolean = false,
    onStatusUpdate?: (status: string, data?: any) => void,
    waitForCompletion: boolean = true
) => {
    const payload: any = { items, overwrite };
    if (destPath && destPath.trim()) payload.dest_path = destPath;
    if (zipName && zipName.trim()) payload.zip_name = zipName;
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/compress`, {
        method: 'POST',
        body: JSON.stringify(payload),
        isReturnResponse: true,
    });
    const result = await handleResponse(response as Response);
    
    if (waitForCompletion && result.task_id) {
        return await subscribeTaskStatus(result.task_id, onStatusUpdate);
    }
    
    return result;
};

export const decompressZip = async (
    zipPath: string,
    destPath?: string,
    overwrite: boolean = false,
    onStatusUpdate?: (status: string, data?: any) => void,
    waitForCompletion: boolean = true
) => {
    const payload: any = { zip_path: zipPath, overwrite };
    if (destPath && destPath.trim()) payload.dest_path = destPath;
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/decompress`, {
        method: 'POST',
        body: JSON.stringify(payload),
        isReturnResponse: true,
    });
    const result = await handleResponse(response as Response);
    
    if (waitForCompletion && result.task_id) {
        return await subscribeTaskStatus(result.task_id, onStatusUpdate);
    }
    
    return result;
};

// Chunked upload related type definitions
interface ChunkedUploadInfo {
    upload_id: string;
    upload_type?: 'zarr-batch';
    filename?: string;
    total_size: number;
    chunk_size?: number;
    total_chunks?: number;
    uploaded_chunks?: number;
    missing_chunks?: number[];
    progress?: number;
    uploaded_batches?: number[];
    uploaded_batch_count?: number;
    total_batches?: number;
    file_count?: number;
    path?: string;
    status?: string;
    folder_rewrite?: Record<string, string>;
    max_batch_bytes?: number;
    keep_both?: boolean;
    overwrite?: boolean;
}

interface UploadChunkResult {
    success: boolean;
    chunk_index: number;
    uploaded_chunks: number;
    total_chunks: number;
}

// Chunked upload service
export const initChunkedUpload = async (
    filename: string,
    totalSize: number,
    path: string = "",
    chunkSize: number = CHUNK_UPLOAD_MIN_BYTES,
    overwrite: boolean = false,
    relativePath?: string,
    keepBoth: boolean = false,
    options?: { signal?: AbortSignal }
): Promise<{ upload_id: string; total_chunks: number; chunk_size: number }> => {
    const formData = new FormData();
    formData.append('filename', sanitizeFilename(filename));
    formData.append('total_size', totalSize.toString());
    const effective = (path && path.trim()) ? path : await getDefaultPath();
    formData.append('path', effective);
    formData.append('chunk_size', chunkSize.toString());
    formData.append('overwrite', keepBoth ? 'false' : overwrite.toString());
    if (keepBoth) formData.append('keep_both', 'true');
    if (relativePath) formData.append('relative_path', relativePath);

    const response = (await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/init`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
        signal: options?.signal,
    })) as Response;

    const result = await handleResponse(response);
    return {
        upload_id: result.upload_id,
        total_chunks: result.total_chunks,
        chunk_size: result.chunk_size
    };
};

export const uploadChunk = async (
    uploadId: string,
    chunkIndex: number,
    chunkData: Blob,
    options?: { signal?: AbortSignal }
): Promise<UploadChunkResult> => {
    const formData = new FormData();
    formData.append('upload_id', uploadId);
    formData.append('chunk_index', chunkIndex.toString());
    formData.append('chunk_data', chunkData);

    const response = (await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/chunk`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
        signal: options?.signal,
    })) as Response;

    return await handleResponse(response);
};

export const completeChunkedUpload = async (
    uploadId: string,
    options?: { signal?: AbortSignal }
): Promise<any> => {
    const formData = new FormData();
    formData.append('upload_id', uploadId);

    const response = (await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/complete`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
        signal: options?.signal,
    })) as Response;

    return await handleResponse(response);
};

export const getUploadStatus = async (uploadId: string): Promise<ChunkedUploadInfo> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/status/${uploadId}`, { method: 'GET', isReturnResponse: true });
    return await handleResponse(response as Response);
};

export const cancelChunkedUpload = async (uploadId: string): Promise<any> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload/cancel/${uploadId}`, {
        method: 'DELETE',
        isReturnResponse: true,
    });

    return await handleResponse(response as Response);
};

// Chunked upload manager
export class ChunkedUploadManager {
    private uploadId: string | null = null;
    private totalChunks: number = 0;
    private chunkSize: number;
    private uploadedChunks: Set<number> = new Set();
    private isUploading: boolean = false;
    private isCancelled: boolean = false;
    private isSessionTimeout: boolean = false;
    private isCompleting: boolean = false;
    private completeUploadPromise: Promise<void> | null = null;
    private retryCount: number = 0;
    private maxRetries: number = 3;
    private abortController: AbortController | null = null;
    private uploadStartTime: number = 0;
    private lastProgressUpdate: number = 0;
    private lastPersistAt: number = 0;
    private sessionKey: string;

    constructor(
        private filename: string,
        private file: File,
        private path: string = "",
        private onProgress?: (progress: number) => void,
        private onError?: (error: unknown) => void,
        private onComplete?: (result: any) => void,
        private onStatusChange?: (status: 'uploading' | 'cancelled' | 'error' | 'completed' | 'merging') => void,
        private overwrite: boolean = false,
        private relativePath?: string,
        private keepBoth: boolean = false
    ) {
        this.chunkSize = pickChunkSizeForFile(file.size);
        this.sessionKey = buildChunkUploadSessionKey(
            filename,
            file.size,
            file.lastModified,
            path,
            relativePath,
            overwrite,
            keepBoth
        );
    }

    private persistSession(force = false): void {
        if (!this.uploadId) return;
        const now = Date.now();
        if (!force && now - this.lastPersistAt < CHUNK_UPLOAD_PERSIST_INTERVAL_MS) {
            return;
        }
        this.lastPersistAt = now;
        savePersistedChunkUploadSession(this.sessionKey, {
            uploadId: this.uploadId,
            filename: this.filename,
            fileSize: this.file.size,
            fileLastModified: this.file.lastModified,
            path: this.path,
            chunkSize: this.chunkSize,
            totalChunks: this.totalChunks,
            relativePath: this.relativePath,
            overwrite: this.overwrite,
            keepBoth: this.keepBoth,
            updatedAt: now,
        });
    }

    private clearPersistedSession(): void {
        clearPersistedChunkUploadSession(this.sessionKey);
    }

    private async abandonPersistedSession(persisted: PersistedChunkUploadSession): Promise<void> {
        this.clearPersistedSession();
        try {
            await cancelChunkedUpload(persisted.uploadId);
        } catch (error) {
            console.warn('Failed to cancel abandoned upload session:', error);
        }
    }

    private async tryResumeFromPersistence(): Promise<boolean> {
        const persisted = loadPersistedChunkUploadSession(this.sessionKey);
        if (!persisted) return false;

        if (
            persisted.filename !== this.filename
            || persisted.fileSize !== this.file.size
            || persisted.fileLastModified !== this.file.lastModified
            || persisted.path !== this.path
            || (persisted.relativePath || '') !== (this.relativePath || '')
            || persisted.overwrite !== this.overwrite
            || persisted.keepBoth !== this.keepBoth
        ) {
            await this.abandonPersistedSession(persisted);
            return false;
        }

        try {
            const status = await getUploadStatus(persisted.uploadId);
            if (
                status.upload_type === 'zarr-batch'
                || status.total_chunks == null
                || status.total_size !== this.file.size
                || status.total_chunks !== persisted.totalChunks
            ) {
                await this.abandonPersistedSession(persisted);
                return false;
            }

            this.uploadId = persisted.uploadId;
            this.totalChunks = status.total_chunks;
            this.chunkSize = persisted.chunkSize;
            this.uploadedChunks = uploadedChunksFromStatus({
                total_chunks: status.total_chunks,
                missing_chunks: status.missing_chunks ?? [],
                progress: status.progress ?? 0,
                total_size: status.total_size,
            });

            if (this.onProgress) {
                const ratio = this.totalChunks > 0
                    ? this.uploadedChunks.size / this.totalChunks
                    : 0;
                this.onProgress(progressBeforeMergeFromRatio(ratio));
            }
            return true;
        } catch (error) {
            console.warn('Failed to resume persisted chunked upload, starting fresh:', error);
            await this.abandonPersistedSession(persisted);
            return false;
        }
    }

    async start(): Promise<void> {
        try {
            this.isUploading = true;
            this.isCancelled = false;
            this.isSessionTimeout = false;
            this.uploadStartTime = Date.now();
            this.abortController = new AbortController();

            const resumed = await this.tryResumeFromPersistence();
            if (!resumed) {
                const initResult = await initChunkedUpload(
                    this.filename,
                    this.file.size,
                    this.path,
                    this.chunkSize,
                    this.overwrite,
                    this.relativePath,
                    this.keepBoth,
                    { signal: this.abortController?.signal }
                );

                this.uploadId = initResult.upload_id;
                this.totalChunks = initResult.total_chunks;
                this.chunkSize = initResult.chunk_size;
                this.persistSession(true);
            }

            if (this.uploadedChunks.size >= this.totalChunks) {
                await this.completeUpload();
                return;
            }

            if (this.onStatusChange) {
                this.onStatusChange('uploading');
            }

            await this.uploadAllChunks();

        } catch (error: any) {
            if (this.isSessionTimeout) {
                const timeoutError = new Error(
                    'Upload timed out. Re-select the same file to resume from where you left off.'
                );
                this.handleError(timeoutError);
                throw timeoutError;
            }
            if (this.isCancelled || String(error?.message ?? '').toLowerCase().includes('cancel')) {
                this.handleCancellation();
                throw error instanceof Error ? error : new Error('Upload cancelled');
            }
            this.handleError(error);
            throw error;
        }
    }

    private async uploadAllChunks(): Promise<void> {
        if (!this.uploadId) return;

        const pending: number[] = [];
        for (let i = 0; i < this.totalChunks; i++) {
            if (!this.uploadedChunks.has(i)) {
                pending.push(i);
            }
        }

        if (pending.length === 0) {
            await this.completeUpload();
            return;
        }

        let nextIdx = 0;
        const worker = async () => {
            while (true) {
                if (this.isCancelled) {
                    throw new Error('Upload cancelled');
                }

                const idx = nextIdx++;
                if (idx >= pending.length) return;

                const chunkIndex = pending[idx];
                if (this.uploadedChunks.has(chunkIndex)) {
                    continue;
                }
                await this.uploadChunkWithRetry(chunkIndex);
            }
        };

        const workerCount = Math.min(CHUNK_UPLOAD_CONCURRENCY, pending.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        await this.completeUpload();
    }

    private async uploadChunkWithRetry(chunkIndex: number): Promise<void> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                // Check for cancellation before each attempt
                if (this.isCancelled) {
                    throw new Error('Upload cancelled');
                }

                const chunk = this.getChunk(chunkIndex);
                await withUploadTimeout(
                    computeChunkUploadTimeoutMs(chunk.size),
                    (signal) => uploadChunk(this.uploadId!, chunkIndex, chunk, { signal }),
                    this.abortController?.signal
                );
                
                this.uploadedChunks.add(chunkIndex);
                this.retryCount = 0;
                this.persistSession();

                if (this.onProgress) {
                    const progress = progressBeforeMergeFromRatio(this.uploadedChunks.size / this.totalChunks);
                    this.onProgress(progress);
                    this.lastProgressUpdate = Date.now();
                }

                return;
            } catch (error: any) {
                if (isMergeInProgressError(error)) {
                    try {
                        const status = await getUploadStatus(this.uploadId!);
                        this.uploadedChunks = uploadedChunksFromStatus({
                            total_chunks: status.total_chunks ?? this.totalChunks,
                            missing_chunks: status.missing_chunks ?? [],
                            progress: status.progress ?? 0,
                            total_size: status.total_size,
                        });
                    } catch {
                        // keep local set if status poll fails
                    }
                    this.retryCount = 0;
                    this.persistSession();
                    if (this.onStatusChange) {
                        this.onStatusChange('merging');
                    }
                    if (this.uploadedChunks.size >= this.totalChunks) {
                        await this.completeUpload();
                        return;
                    }
                    if (attempt < this.maxRetries) {
                        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
                        continue;
                    }
                    lastError = new Error('Upload merge in progress; retry chunk upload later');
                    continue;
                }
                if (isAbortError(error)) {
                    if (this.isCancelled) throw new Error('Upload cancelled');
                    lastError = new Error('Chunk upload timeout');
                } else {
                    lastError = error;
                }
                this.retryCount++;

                if (attempt < this.maxRetries) {
                    const delayMs = isRequestQuotaExceededError(error)
                        ? computeRetryDelayMs(error, attempt + 1, 2000)
                        : 1000 * (attempt + 1);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        throw lastError || new Error('Failed to upload chunk after retries');
    }

    private getChunk(chunkIndex: number): Blob {
        const start = chunkIndex * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.file.size);
        return this.file.slice(start, end);
    }

    private async completeUpload(): Promise<void> {
        if (!this.uploadId) return;
        if (this.completeUploadPromise) {
            return this.completeUploadPromise;
        }

        this.completeUploadPromise = this.runCompleteUpload();
        try {
            await this.completeUploadPromise;
        } finally {
            this.completeUploadPromise = null;
        }
    }

    private async runCompleteUpload(): Promise<void> {
        if (!this.uploadId) return;

        this.isCompleting = true;
        this.persistSession(true);
        if (this.onStatusChange) {
            this.onStatusChange('merging');
        }

        const completeTimeoutMs = computeCompleteUploadTimeoutMs(this.file.size);
        const maxRetryAttempts = computeCompleteRetryAttempts(this.file.size);
        let lastError: unknown = null;

        try {
            for (let attempt = 0; attempt <= maxRetryAttempts; attempt++) {
                if (this.isCancelled) {
                    throw new Error('Upload cancelled');
                }
                if (this.isSessionTimeout) {
                    throw new Error(
                        'Upload timed out. Re-select the same file to resume from where you left off.'
                    );
                }

                try {
                    const result = await withUploadTimeout(
                        completeTimeoutMs,
                        (signal) => completeChunkedUpload(this.uploadId!, { signal }),
                        this.abortController?.signal
                    );
                    this.finishUploadSuccess(result);
                    return;
                } catch (error) {
                    lastError = error;
                    const { retry, delayMs } = shouldRetryCompleteUpload(
                        error,
                        this.isCancelled,
                        this.isSessionTimeout
                    );
                    if (retry && attempt < maxRetryAttempts) {
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                        continue;
                    }
                    break;
                }
            }

            throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Complete upload failed'));
        } finally {
            this.isCompleting = false;
        }
    }

    private finishUploadSuccess(result: unknown): void {
        this.isUploading = false;
        if (this.onProgress) this.onProgress(100);
        if (this.onStatusChange) this.onStatusChange('completed');
        // Clear persistence before onComplete: onComplete triggers resume-hint refresh
        // in the UI; reading localStorage first would leave a false "unfinished upload" banner.
        this.clearPersistedSession();
        if (this.onComplete) this.onComplete(result);
    }

    private handleError(error: any): void {
        this.isUploading = false;
        console.error('Chunked upload error:', error);

        // When the upload was cancelled (e.g. isCancelled flag set between chunks,
        // which throws Error('Upload cancelled') instead of AbortError), treat this
        // as a cancellation so onStatusChange('cancelled') is still emitted.
        // Previously this silently returned without any callback, leaving localStatus
        // in WebFileManager stuck at 'Uploading' and causing the wrong toast.
        if (this.isCancelled) {
            console.log('Upload was cancelled, emitting cancelled status');
            if (this.onStatusChange) {
                this.onStatusChange('cancelled');
            }
            return;
        }

        if (this.onStatusChange) {
            this.onStatusChange('error');
        }

        if (this.onError) {
            this.onError(error);
        }
    }

    private handleCancellation(): void {
        this.isUploading = false;
        console.log('Upload cancelled by user');

        if (this.onStatusChange) {
            this.onStatusChange('cancelled');
        }
    }

    stopForTimeout(): void {
        if (!this.isUploading) return;
        this.isSessionTimeout = true;
        this.isUploading = false;
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    async cancel(): Promise<void> {
        if (this.isCancelled) return;

        if (this.uploadId) {
            try {
                await cancelChunkedUpload(this.uploadId);
            } catch (error) {
                if (isCancelBlockedWhileMerging(error)) {
                    if (this.onStatusChange) {
                        this.onStatusChange('merging');
                    }
                    throw new Error(
                        'Cannot cancel while the file is being merged on the server. Please wait for merge to finish.'
                    );
                }
                console.warn('Failed to cancel upload on server:', error);
            }
        }

        this.isCancelled = true;
        this.isUploading = false;

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        if (this.uploadStartTime > 0) {
            this.uploadStartTime = 0;
        }
        this.lastProgressUpdate = 0;

        if (this.uploadId) {
            this.uploadId = null;
        }

        this.clearPersistedSession();

        this.uploadedChunks.clear();
        this.totalChunks = 0;
        this.retryCount = 0;

        if (this.onStatusChange) {
            this.onStatusChange('cancelled');
        }
    }
}

// ── Copy-to-Personal ──────────────────────────────────────────────────────────

const normalizeCopyToPersonalPayload = (payload: any): {
    copied_path: string;
    message: string;
} => {
    const copiedPath = payload?.copied_path ?? payload?.destination ?? '';
    const message = payload?.message ?? 'Copied to Personal';
    return {
        copied_path: String(copiedPath),
        message: String(message),
    };
};

/**
 * Copy a single slide file from Samples to the current user's Personal folder root.
 * Backend resolves the destination automatically (no user-provided dest).
 *
 * When `link` is true the backend symlinks the slide (and a sparse overlay of
 * its .zarr) instead of copying bytes — the WSI/embeddings stay shared in place
 * while the user gets a writable workspace. The slide still counts against the
 * user's quota (a file-table doc carries its real size).
 */
export const copyFileToPersonal = async (
    sourcePath: string,
    link: boolean = false,
    includeZarr: boolean = false,
): Promise<{
    copied_path: string;
    message: string;
}> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/copy-to-personal`, {
        method: 'POST',
        body: JSON.stringify({ source_path: sourcePath, link, include_zarr: includeZarr }),
        isReturnResponse: true,
    });
    return normalizeCopyToPersonalPayload(await handleResponse(response as Response));
};

/**
 * Copy or link a folder (and its slide files) from Samples to the current
 * user's Personal folder root.
 *
 * Default (`link=false`): backend recursively copies only slide files
 * (.svs / .tif / .tiff etc.) and ignores .zarr / .zip.
 *
 * `link=true`: backend recursively SYMLINKS each slide and builds a sparse
 * .zarr overlay per slide — bytes stay in Samples, the user gets a
 * writable workspace. Linked sizes still count against quota via per-file
 * file-table docs.
 */
export const copyFolderToPersonal = async (
    sourcePath: string,
    link: boolean = false,
    includeZarr: boolean = false,
): Promise<{
    copied_path: string;
    message: string;
}> => {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/folders/copy-to-personal`, {
        method: 'POST',
        body: JSON.stringify({ source_path: sourcePath, link, include_zarr: includeZarr }),
        isReturnResponse: true,
    });
    return normalizeCopyToPersonalPayload(await handleResponse(response as Response));
};
