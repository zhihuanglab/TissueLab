import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config';
import { sanitizeFilename } from '@/utils/string.utils';
import { apiFetch } from './apiFetch';
import Cookies from 'js-cookie';

const FM_API_ENDPOINT = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1`;
const USERS_API_ENDPOINT = `${CTRL_SERVICE_API_ENDPOINT}/users/v1`;

let cachedDefaultPath: string | null = null;
const getDefaultPath = async (): Promise<string> => {
    if (cachedDefaultPath) return cachedDefaultPath;
    const cfg = await getConfig();
    cachedDefaultPath = (cfg?.defaultPath || '').replace(/\\/g, '/');
    return cachedDefaultPath || '';
};

const handleResponse = async (response: Response) => {
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Invalid JSON response' }));
        const error = new Error(errorData.detail || errorData.error || `Request failed with status ${response.status}`);
        // Attach status code for better error handling
        (error as any).status = response.status;
        throw error;
    }
    return response.json();
};

export const listFiles = async (path: string) => {
    const effective = path && path.trim() ? path : await getDefaultPath();
    const response = await apiFetch(`${FM_API_ENDPOINT}/files?path=${encodeURIComponent(effective)}`, { method: 'GET', isReturnResponse: true });
    return handleResponse(response as Response);
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

export const deleteFiles = async (items: string[]) => {
    const response = await apiFetch(`${FM_API_ENDPOINT}/files/delete`, {
        method: 'POST',
        body: JSON.stringify({ items }),
        isReturnResponse: true,
    });
    return handleResponse(response as Response);
};

export const uploadFiles = (
    path: string, 
    files: FileList, 
    onProgress: (percent: number) => void,
    overwrite: boolean = false
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
        // Quota pre-check
        try {
            const cfg = await getConfig();
            const quota: number | null = cfg?.storageQuota ?? null;
            const usage: number = cfg?.storageUsage ?? 0;
            const incoming = Array.from(files).reduce((acc, f) => acc + (f.size || 0), 0);
            if (quota && usage + incoming > quota) {
                const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(2);
                return reject(new Error(`Upload failed: will exceed storage quota (used ${gb(usage)}GB / quota ${gb(quota)}GB, trying to upload ${gb(incoming)}GB)`));
            }
        } catch (e) {
            // If config fails, continue; backend will enforce quota
        }

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                const percentComplete = Math.round((event.loaded / event.total) * 100);
                onProgress(percentComplete);
            }
        });

        xhr.addEventListener('load', () => {
            onProgress(100); // Ensure it completes to 100
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText));
            } else {
                try {
                    const errorData = JSON.parse(xhr.responseText);
                    reject(new Error(errorData.detail || errorData.error || `Request failed with status ${xhr.status}`));
                } catch {
                    reject(new Error(`Request failed with status ${xhr.status}`));
                }
            }
        });

        xhr.addEventListener('error', () => {
            reject(new Error('Upload failed due to a network error.'));
        });

        // set auth header if available
        try {
            // Get token from cookies
            const token = Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token';
            
            // Resolve default path lazily to avoid blocking earlier
            const effective = await setEffectivePath();
            formData.set('path', effective);
            formData.set('overwrite', overwrite.toString());
            xhr.open('POST', `${FM_API_ENDPOINT}/files/upload`, true);
            if (token) {
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            }
        } catch (e) {
            const effective = await setEffectivePath();
            formData.set('path', effective);
            formData.set('overwrite', overwrite.toString());
            xhr.open('POST', `${FM_API_ENDPOINT}/files/upload`, true);
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
    chunkSize: number = 1024 * 1024, // Default 1MB
    overwrite: boolean = false
): Promise<{ upload_id: string; total_chunks: number; chunk_size: number }> => {
    // Quota pre-check
    try {
        const cfg = await getConfig();
        const quota: number | null = cfg?.storageQuota ?? null;
        const usage: number = cfg?.storageUsage ?? 0;
        if (quota && usage + totalSize > quota) {
            const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(2);
            throw new Error(`Storage quota exceeded: ${gb(usage)}GB / ${gb(quota)}GB, trying to upload ${gb(totalSize)}GB`);
        }
    } catch (e) {
        // If config fails, continue; backend will enforce quota
    }

    const formData = new FormData();
    formData.append('filename', sanitizeFilename(filename));
    formData.append('total_size', totalSize.toString());
    const effective = (path && path.trim()) ? path : await getDefaultPath();
    formData.append('path', effective);
    formData.append('chunk_size', chunkSize.toString());
    formData.append('overwrite', overwrite.toString());

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
    private chunkSize: number = 1024 * 1024;
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
        private onError?: (error: string) => void,
        private onComplete?: (result: any) => void,
        private onStatusChange?: (status: 'uploading' | 'paused' | 'cancelled' | 'error' | 'completed') => void,
        private overwrite: boolean = false
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
                this.overwrite
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
                    const progress = (this.uploadedChunks.size / this.totalChunks) * 100;
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

        // Ensure we do not override a cancelled status with an error
        if (this.isCancelled) {
            console.log('Upload was cancelled, not treating as error');
            return;
        }

        if (this.onStatusChange) {
            this.onStatusChange('error');
        }

        if (this.onError) {
            this.onError(error.message || 'Upload failed');
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
    onError?: (error: string) => void,
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
            (error) => reject(new Error(error)),
            (result) => resolve(result)
        );

        manager.start();
    });
}; 
