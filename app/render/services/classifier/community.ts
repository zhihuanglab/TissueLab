import { apiFetch } from "@/utils/common/apiFetch";
import { COMMUNITY_API_ENDPOINT } from "@/config/api.config";

export interface ClassifierData {
  id: string;
  ownerId: string;
  fileName: string;
  localPath: string;
  title: string;
  description: string;
  factory: string;
  model?: string;  // Add model field
  downloadLink: string;
  tags: string[];
  classesCount?: number;
  fileSize?: number;
  isPublic: boolean;
  createdAt?: any;
  updatedAt?: any;
  /** @deprecated Backend no longer populates these — display name and avatar
   *  are now resolved per-uid via `useAuthorProfile(ownerId)`. Fields kept
   *  for type compatibility with older response shapes. */
  authorName?: string;
  author_avatar_url?: string;
  stats?: {
    classes?: number;
    downloads?: number;
    size?: number;
    stars?: number;
  };
}

export interface ClassifiersResponse {
  success: boolean;
  classifiers: ClassifierData[];
  total: number;
  offset: number;
  limit: number;
}

export class ClassifiersService {
  private baseUrl = `${COMMUNITY_API_ENDPOINT}/community`

  /**
   * Get all public classifiers from Firebase
   */
  async getPublicClassifiers(params?: {
    offset?: number;
    limit?: number;
  }): Promise<ClassifiersResponse> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.offset) queryParams.append('offset', params.offset.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());

      const url = `${this.baseUrl}/v1/classifiers/public${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
      
      return await apiFetch(url, {
        method: 'GET',
      });
    } catch (error) {
      console.error('Failed to get public classifiers:', error);
      throw error;
    }
  }

  /**
   * Get user's own classifiers
   */
  async getUserClassifiers(userId: string, params?: {
    offset?: number;
    limit?: number;
  }): Promise<ClassifiersResponse> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.offset) queryParams.append('offset', params.offset.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());

      const url = `${this.baseUrl}/v1/classifiers/user/${userId}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
      
      return await apiFetch(url, {
        method: 'GET',
      });
    } catch (error) {
      console.error('Failed to get user classifiers:', error);
      throw error;
    }
  }

  /**
   * Delete a classifier
   */
  async deleteClassifier(classifierId: string): Promise<any> {
    try {
      const result = await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}`, {
        method: 'DELETE',
      });
      return result;
    } catch (error) {
      const status = (error as any)?.status;
      // If classifier is already deleted (404), treat as success
      if (status === 404) {
        console.warn(`Classifier ${classifierId} not found - may have been deleted or does not exist`);
        return { success: true, message: 'Classifier not found or already deleted' };
      }
      console.error('Failed to delete classifier:', error);
      throw error;
    }
  }

  /**
   * Download a community classifier file.
   * Two-step (Ctrl Service): mint a one-time download token, then fetch the file.
   * The body is streamed so the caller can render real download progress —
   * classifier files can be large.
   * @param classifierId community classifier id (e.g. "uploaded-...")
   * @param onProgress called as bytes arrive; `total` is 0 when the server
   *   sends no Content-Length (caller should treat that as indeterminate)
   * @returns the downloaded file bytes plus the cloud-storage filename
   *   (UUID-based) — callers should write the local copy under that name so
   *   the local file matches what the server stores. `fileName` is empty
   *   when the server didn't surface it (legacy response).
   */
  async downloadClassifier(
    classifierId: string,
    onProgress?: (received: number, total: number) => void
  ): Promise<{ bytes: Uint8Array; fileName: string }> {
    const link = await apiFetch(
      `${this.baseUrl}/v1/classifiers/${encodeURIComponent(classifierId)}/download-link`,
      { method: 'POST' }
    ) as { download_token?: string; file_name?: string };
    const token = link?.download_token;
    if (!token) {
      throw new Error('Failed to create classifier download link');
    }
    const cloudFileName = (link?.file_name || '').trim();
    const resp = await apiFetch(
      `${this.baseUrl}/v1/classifiers/download/${encodeURIComponent(token)}`,
      { method: 'GET', isReturnResponse: true }
    ) as Response;
    if (!resp || !resp.ok) {
      throw new Error(`Failed to download classifier (HTTP ${resp?.status ?? 'unknown'})`);
    }
    const total = Number(resp.headers.get('content-length') || 0);

    // Stream the body so progress can be reported chunk-by-chunk.
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          chunks.push(value);
          received += value.length;
          onProgress?.(received, total);
        }
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      onProgress?.(received, total > 0 ? total : received);
      return { bytes: out, fileName: cloudFileName };
    }

    // Fallback for environments without a streaming body.
    const buf = new Uint8Array(await resp.arrayBuffer());
    onProgress?.(buf.length, total > 0 ? total : buf.length);
    return { bytes: buf, fileName: cloudFileName };
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes?: number): string {
    if (!bytes) return 'Unknown';
    
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Get classifier display name
   */
  getDisplayName(classifier: ClassifierData): string {
    return classifier.title || classifier.fileName || 'Unknown Classifier';
  }

  /**
   * Get classifier author display
   *
   * Priority:
   *   1. `authorName` from backend (resolved server-side from users/{ownerId})
   *      — works for every viewer, not just the owner themselves.
   *   2. localStorage `preferred_name_<uid>` — only ever populated for the
   *      currently signed-in user, so this only ever hits for own classifiers.
   *   3. uid prefix fallback (8 chars).
   */
  getAuthorDisplay(classifier: ClassifierData): string {
    const backendName = classifier.authorName?.trim()
    if (backendName) return backendName

    if (typeof window !== 'undefined' && classifier.ownerId && classifier.ownerId !== 'anonymous') {
      try {
        const preferredName = window.localStorage.getItem(`preferred_name_${classifier.ownerId}`)
        if (preferredName && preferredName !== 'null' && preferredName !== '') {
          return preferredName
        }
      } catch (error) {
        console.warn('Failed to get preferred_name from localStorage:', error)
      }
    }

    // Fallback to user ID substring
    return classifier.ownerId?.substring(0, 8) || 'Unknown';
  }
}

// Export a singleton instance
export const classifiersService = new ClassifiersService();
