import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config';
import { sanitizeFilename } from '@/utils/string.utils';
import { apiFetch } from '@/utils/common/apiFetch';
import { getAuthToken } from '@/utils/common/authToken';
import { FmApiError } from '@/utils/dashboard/fmApiError';
import Cookies from 'js-cookie';

const FM_API_ENDPOINT = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1`;
const USERS_API_ENDPOINT = `${CTRL_SERVICE_API_ENDPOINT}/users/v1`;

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
    const inferredErrorCode = status === 429 ? 'STORAGE_QUOTA_EXCEEDED' : undefined;
    const msgStr = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);

    return new FmApiError(msgStr, {
        status,
        isAppErrorWrapped,
        ...(structured?.error_code != null ? { errorCode: String(structured.error_code) } : {}),
        ...(structured?.error_code == null && inferredErrorCode ? { errorCode: inferredErrorCode } : {}),
        ...(structured?.required_bytes !== undefined ? { requiredBytes: Number(structured.required_bytes) } : {}),
        ...(structured?.available_bytes !== undefined ? { availableBytes: Number(structured.available_bytes) } : {}),
        ...(structured?.quota_bytes !== undefined ? { quotaBytes: Number(structured.quota_bytes) } : {}),
        ...(structured?.retry_after !== undefined ? { retryAfter: Number(structured.retry_after) } : {}),
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


export const listFiles = async (path: string, offset: number = 0, limit?: number) => {
    const effective = path && path.trim() ? path : await getDefaultPath();
    let url = `${FM_API_ENDPOINT}/files?path=${encodeURIComponent(effective)}&offset=${offset}`;
    if (limit !== undefined && limit !== null) {
        url += `&limit=${limit}`;
    }
    const response = await apiFetch(url, { method: 'GET', isReturnResponse: true });
    const data = await handleResponse(response as Response);
    
    // Handle both old format (array) and new format (object with items and pagination)
    if (Array.isArray(data)) {
        // Backward compatibility: return old format structure
        return data;
    } else if (data && data.items) {
        // New format with pagination
        return data;
    } else {
        // Fallback: return as-is
        return data;
    }
};

export const downloadFile = async (
    path: string,
    suggestedFilename?: string,
    onProgress?: (progress: { state: string; receivedBytes?: number; totalBytes?: number; percent?: number }) => void
): Promise<{ ok: boolean; cancelled?: boolean; target?: string } | void> => {
    // Unified download entry: create token and hand off to Electron/browser download manager
    const linkData = await createDownloadLink(path);
    const directUrl = `${FM_API_ENDPOINT}/files/download/${linkData.download_token}`;
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
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/download-link?path=${encodeURIComponent(effective)}`, {
        method: 'POST',
        isReturnResponse: true,
    });
    return await handleResponse(response as Response);
};

// Download a file using a direct link token (no authentication required)
export const downloadFileDirect = async (token: string): Promise<Blob> => {
    const response = await fetch(`${FM_API_ENDPOINT}/files/download/${token}`, {
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
    const directUrl = `${FM_API_ENDPOINT}/files/download/${linkData.download_token}`;
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
    const resp = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${encodeURIComponent(classifierId)}/download-link`, {
        method: 'POST',
        isReturnResponse: true,
    });
    const data = await handleResponse(resp as Response);
    const token = data?.download_token as string;
    if (!token) throw new Error('Failed to obtain classifier download token');
    const directUrl = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/download/${token}`;
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
    const resp = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${encodeURIComponent(modelId)}/download-link`, {
        method: 'POST',
        isReturnResponse: true,
    });
    const data = await handleResponse(resp as Response);
    const token = data?.download_token as string;
    if (!token) throw new Error('Failed to obtain model download token');
    const directUrl = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/download/${token}`;
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

export const searchFiles = async (query: string) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/search?query=${encodeURIComponent(query)}`, { method: 'GET', isReturnResponse: true });
    return handleResponse(response as Response);
};

export const listSharedFiles = async () => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/shared`, { method: 'GET', isReturnResponse: true });
    return handleResponse(response as Response);
};

export const getShareInfo = async (path: string) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/share?path=${encodeURIComponent(path)}`, { method: 'GET', isReturnResponse: true });
    return handleResponse(response as Response);
};

export const updateShareInfo = async (payload: {
    path: string;
    isPublic?: boolean;
    sharedWith?: string[];
    expiresAt?: any;
    generateLink?: boolean;
    revokeLink?: boolean;
}) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/share`, {
        method: 'POST',
        body: JSON.stringify(payload),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const getConfig = async () => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/config`, { method: 'GET', isReturnResponse: true });
    return handleResponse(response as Response);
};

export const lookupUserByEmail = async (email: string) => {
    const response = await apiFetch(`${USERS_API_ENDPOINT}/lookup_by_email`, {
        method: 'POST',
        body: JSON.stringify({ email }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const searchUsersByEmail = async (query: string, max: number = 5) => {
    const response = await apiFetch(`${USERS_API_ENDPOINT}/search_by_email`, {
        method: 'POST',
        body: JSON.stringify({ query, limit: max }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const getUsersBasicInfo = async (uids: string[]) => {
    const response = await apiFetch(`${USERS_API_ENDPOINT}/users_basic_info`, {
        method: 'POST',
        body: JSON.stringify({ uids }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const createFile = async (path: string, content?: string) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/create`, {
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
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/create`, {
        method: 'POST',
        body: JSON.stringify({ path }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const renameFile = async (oldPath: string, newPath: string) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/rename`, {
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
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/delete`, {
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

export const uploadFiles = (
    path: string,
    files: FileList,
    onProgress: (percent: number) => void,
    overwrite: boolean = false,
    relativePaths?: string[],
    keepBoth: boolean = false
): Promise<any> => {
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
                // Cap at 95% during upload — reserve last 5% for server processing
                const percentComplete = Math.min(95, Math.round((event.loaded / event.total) * 95));
                onProgress(percentComplete);
            }
        });

        xhr.addEventListener('load', () => {
            onProgress(100); // Server responded — now mark as truly 100%
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
                    resolve(parsedBody.data ?? {});
                    return;
                }
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
            xhr.open('POST', `${FM_API_ENDPOINT}/files/upload`, true);
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

export const moveFiles = async (items: string[], newPath: string) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/move`, {
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
    // Get token before creating EventSource (which doesn't support custom headers)
    const token = await getAuthToken() || Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token';
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const url = `${FM_API_ENDPOINT}/files/task_status/${taskId}/stream?token=${encodeURIComponent(token)}`;
        
        const eventSource = new EventSource(url);
        let result: any = null;
        
        eventSource.addEventListener('status', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                
                if (onStatusUpdate) {
                    onStatusUpdate(data.status, data);
                }
                
                if (data.status === 'completed') {
                    result = data.result || data;
                    eventSource.close();
                    resolve(result);
                } else if (data.status === 'failed') {
                    eventSource.close();
                    reject(new Error(data.error || 'Task failed'));
                }
            } catch (e) {
                console.error('Error parsing SSE status event:', e);
            }
        });
        
        eventSource.addEventListener('done', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                eventSource.close();
                if (result) {
                    resolve(result);
                } else if (data.status === 'failed') {
                    reject(new Error('Task failed'));
                }
            } catch (e) {
                console.error('Error parsing SSE done event:', e);
            }
        });
        
        eventSource.addEventListener('error', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                eventSource.close();
                reject(new Error(data.error || 'Task error'));
            } catch (e) {
                // If parsing fails, check if it's a connection error
                if (eventSource.readyState === EventSource.CLOSED) {
                    eventSource.close();
                    reject(new Error('Connection closed unexpectedly'));
                }
            }
        });
        
        eventSource.onerror = (error) => {
            // Handle connection errors
            if (eventSource.readyState === EventSource.CLOSED) {
                eventSource.close();
                reject(new Error('SSE connection closed'));
            }
        };
        
        // Timeout protection
        setTimeout(() => {
            if (eventSource.readyState !== EventSource.CLOSED) {
                eventSource.close();
                reject(new Error('Task timeout: task took too long to complete'));
            }
        }, maxWaitTime);
    });
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
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/compress`, {
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
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/decompress`, {
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
    filename: string;
    total_size: number;
    chunk_size: number;
    total_chunks: number;
    uploaded_chunks: number;
    missing_chunks: number[];
    progress: number;
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
    chunkSize: number = 2 * 1024 * 1024, // Default 2MB
    overwrite: boolean = false,
    relativePath?: string,
    keepBoth: boolean = false
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

    const response = (await apiFetch(`${FM_API_ENDPOINT}/files/upload/init`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
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
    chunkData: Blob
): Promise<UploadChunkResult> => {
    const formData = new FormData();
    formData.append('upload_id', uploadId);
    formData.append('chunk_index', chunkIndex.toString());
    formData.append('chunk_data', chunkData);

    const response = (await apiFetch(`${FM_API_ENDPOINT}/files/upload/chunk`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
    })) as Response;

    return await handleResponse(response);
};

export const completeChunkedUpload = async (uploadId: string): Promise<any> => {
    const formData = new FormData();
    formData.append('upload_id', uploadId);

    const response = (await apiFetch(`${FM_API_ENDPOINT}/files/upload/complete`, {
        method: 'POST',
        body: formData,
        isReturnResponse: true,
    })) as Response;

    return await handleResponse(response);
};

export const getUploadStatus = async (uploadId: string): Promise<ChunkedUploadInfo> => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/upload/status/${uploadId}`, { method: 'GET', isReturnResponse: true });
    return await handleResponse(response as Response);
};

export const cancelChunkedUpload = async (uploadId: string): Promise<any> => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/upload/cancel/${uploadId}`, {
        method: 'DELETE',
        isReturnResponse: true,
    });

    return await handleResponse(response as Response);
};

// Chunked upload manager
export class ChunkedUploadManager {
    private uploadId: string | null = null;
    private totalChunks: number = 0;
    private chunkSize: number = 2 * 1024 * 1024;
    private uploadedChunks: Set<number> = new Set();
    private isUploading: boolean = false;
    private isCancelled: boolean = false;
    private isPaused: boolean = false;
    private retryCount: number = 0;
    private maxRetries: number = 3;
    private abortController: AbortController | null = null;
    private uploadStartTime: number = 0;
    private lastProgressUpdate: number = 0;

    constructor(
        private filename: string,
        private file: File,
        private path: string = "",
        private onProgress?: (progress: number) => void,
        private onError?: (error: unknown) => void,
        private onComplete?: (result: any) => void,
        private onStatusChange?: (status: 'uploading' | 'paused' | 'cancelled' | 'error' | 'completed') => void,
        private overwrite: boolean = false,
        private relativePath?: string,
        private keepBoth: boolean = false
    ) {}

    async start(): Promise<void> {
        try {
            this.isUploading = true;
            this.isCancelled = false;
            this.isPaused = false;
            this.uploadStartTime = Date.now();
            this.abortController = new AbortController();

            // Initialize upload
            const initResult = await initChunkedUpload(
                this.filename,
                this.file.size,
                this.path,
                this.chunkSize,
                this.overwrite,
                this.relativePath,
                this.keepBoth
            );

            this.uploadId = initResult.upload_id;
            this.totalChunks = initResult.total_chunks;
            this.chunkSize = initResult.chunk_size;

            if (this.onStatusChange) {
                this.onStatusChange('uploading');
            }

            // Check if there are incomplete uploads
            await this.resumeUpload();

            // Start upload
            await this.uploadAllChunks();

        } catch (error: any) {
            if (error.name === 'AbortError') {
                this.handleCancellation();
            } else {
                this.handleError(error);
            }
        }
    }

    private async resumeUpload(): Promise<void> {
        if (!this.uploadId) return;

        try {
            const status = await getUploadStatus(this.uploadId);
            this.uploadedChunks = new Set(
                Array.from({ length: status.total_chunks }, (_, i) => i)
                    .filter(i => !status.missing_chunks.includes(i))
            );

            if (this.onProgress) {
                this.onProgress(status.progress);
            }
        } catch (error) {
            console.warn('Failed to get upload status, starting fresh:', error);
        }
    }

    private async uploadAllChunks(): Promise<void> {
        if (!this.uploadId) return;

        for (let i = 0; i < this.totalChunks; i++) {
            // Check for cancellation or pause
            if (this.isCancelled) {
                throw new Error('Upload cancelled');
            }

            if (this.isPaused) {
                await this.waitForResume();
            }

            if (this.uploadedChunks.has(i)) {
                continue; // Skip already uploaded chunks
            }

            await this.uploadChunkWithRetry(i);
        }

        // Complete upload
        await this.completeUpload();
    }

    private async waitForResume(): Promise<void> {
        while (this.isPaused && !this.isCancelled) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (this.isCancelled) {
            throw new Error('Upload cancelled while paused');
        }
    }

    private async uploadChunkWithRetry(chunkIndex: number): Promise<void> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                // Check for cancellation before each attempt
                if (this.isCancelled) {
                    throw new Error('Upload cancelled');
                }

                // Check for pause before each attempt
                if (this.isPaused) {
                    await this.waitForResume();
                }

                const chunk = this.getChunk(chunkIndex);
                
                // Use AbortController for request cancellation
                const chunkPromise = uploadChunk(this.uploadId!, chunkIndex, chunk);
                
                // Create a timeout promise
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Chunk upload timeout')), 30000); // 30s timeout
                });

                // Race between upload and timeout
                await Promise.race([chunkPromise, timeoutPromise]);
                
                this.uploadedChunks.add(chunkIndex);
                this.retryCount = 0; // Reset retry count

                if (this.onProgress) {
                    // Cap at 95% during chunk upload — reserve last 5% for server assembly
                    const progress = Math.min(95, (this.uploadedChunks.size / this.totalChunks) * 95);
                    this.onProgress(progress);
                    this.lastProgressUpdate = Date.now();
                }

                return;
            } catch (error: any) {
                lastError = error;
                this.retryCount++;

                if (error.name === 'AbortError') {
                    throw error;
                }

                if (attempt < this.maxRetries) {
                    // Wait for a while before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
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

        try {
            const result = await completeChunkedUpload(this.uploadId);
            this.isUploading = false;

            // Report 100% now that server has assembled the file
            if (this.onProgress) {
                this.onProgress(100);
            }

            if (this.onStatusChange) {
                this.onStatusChange('completed');
            }

            if (this.onComplete) {
                this.onComplete(result);
            }
        } catch (error: any) {
            this.handleError(error);
        }
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

    async pause(): Promise<void> {
        if (this.isUploading && !this.isPaused) {
            this.isPaused = true;
            console.log(`Upload paused for ${this.filename}`);
            if (this.onStatusChange) {
                this.onStatusChange('paused');
            }
        }
    }

    async resume(): Promise<void> {
        if (this.isPaused) {
            this.isPaused = false;
            console.log(`Upload resumed for ${this.filename}`);
            if (this.onStatusChange) {
                this.onStatusChange('uploading');
            }
        }
    }

    async cancel(): Promise<void> {
        this.isCancelled = true;
        this.isUploading = false;
        this.isPaused = false;

        // Abort any ongoing requests
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        // Clear any timers or intervals
        if (this.uploadStartTime > 0) {
            this.uploadStartTime = 0;
        }
        this.lastProgressUpdate = 0;

        if (this.uploadId) {
            try {
                await cancelChunkedUpload(this.uploadId);
            } catch (error) {
                console.warn('Failed to cancel upload on server:', error);
            } finally {
                // Clear upload ID after cancellation
                this.uploadId = null;
            }
        }

        // Reset chunk tracking
        this.uploadedChunks.clear();
        this.totalChunks = 0;
        this.retryCount = 0;

        if (this.onStatusChange) {
            this.onStatusChange('cancelled');
        }
    }

    isUploadingStatus(): boolean {
        return this.isUploading && !this.isPaused;
    }

    isPausedStatus(): boolean {
        return this.isPaused;
    }

    isCancelledStatus(): boolean {
        return this.isCancelled;
    }

    getProgress(): number {
        return this.uploadedChunks.size / this.totalChunks * 100;
    }

    getUploadTime(): number {
        return this.uploadStartTime > 0 ? Date.now() - this.uploadStartTime : 0;
    }

    getEstimatedTimeRemaining(): number {
        if (this.lastProgressUpdate === 0 || this.uploadedChunks.size === 0) {
            return -1; // Cannot estimate yet
        }

        const elapsed = Date.now() - this.lastProgressUpdate;
        const progress = this.uploadedChunks.size / this.totalChunks;
        const remainingChunks = this.totalChunks - this.uploadedChunks.size;
        
        if (progress === 0) return -1;
        
        const timePerChunk = elapsed / this.uploadedChunks.size;
        return remainingChunks * timePerChunk;
    }

    // Clean up any temporary files or resources
    async cleanup(): Promise<void> {
        if (this.uploadId) {
            try {
                await cancelChunkedUpload(this.uploadId);
            } catch (error) {
                console.warn('Failed to cleanup upload on server:', error);
            }
        }
    }

    // Public getters for accessing private properties
    getFilename(): string {
        return this.filename;
    }

    getFile(): File {
        return this.file;
    }

    getPath(): string {
        return this.path;
    }

    getUploadId(): string | null {
        return this.uploadId;
    }
}

// Convenient chunked upload function
export const uploadFileWithChunks = (
    file: File,
    path: string = "",
    onProgress?: (progress: number) => void,
    onError?: (error: unknown) => void,
    onComplete?: (result: any) => void
): ChunkedUploadManager => {
    const manager = new ChunkedUploadManager(
        file.name,
        file,
        path,
        onProgress,
        onError,
        onComplete
    );

    manager.start();
    return manager;
};

// Promise-based chunked upload function
export const uploadFileWithChunksAsync = (
    file: File,
    path: string = "",
    onProgress?: (progress: number) => void
): Promise<any> => {
    return new Promise((resolve, reject) => {
        const manager = new ChunkedUploadManager(
            file.name,
            file,
            path,
            onProgress,
            (error) => reject(error instanceof Error ? error : new Error(String(error))),
            (result) => resolve(result)
        );

        manager.start();
    });
}; 

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
 */
export const copyFileToPersonal = async (sourcePath: string): Promise<{
    copied_path: string;
    message: string;
}> => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/copy-to-personal`, {
        method: 'POST',
        body: JSON.stringify({ source_path: sourcePath }),
        isReturnResponse: true,
    });
    return normalizeCopyToPersonalPayload(await handleResponse(response as Response));
};

/**
 * Copy a folder (and its slide files) from Samples to the current user's Personal folder root.
 * Backend recursively copies only slide files (.svs / .tif / .tiff etc.) and ignores .zarr / .zip.
 */
export const copyFolderToPersonal = async (sourcePath: string): Promise<{
    copied_path: string;
    message: string;
}> => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/folders/copy-to-personal`, {
        method: 'POST',
        body: JSON.stringify({ source_path: sourcePath }),
        isReturnResponse: true,
    });
    return normalizeCopyToPersonalPayload(await handleResponse(response as Response));
};
