import { apiFetch } from "@/utils/common/apiFetch";
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config";

export interface ModelDataResponse {
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
  fileSize?: number;
  isPublic: boolean;
  createdAt?: any;
  updatedAt?: any;
  stats?: {
    downloads?: number;
    size?: number;
    stars?: number;
  };
}

export interface ModelsResponse {
  success: boolean;
  models: ModelDataResponse[];
  total: number;
  offset: number;
  limit: number;
}

export class ModelsService {
  private baseUrl = `${CTRL_SERVICE_API_ENDPOINT}/community`

  /**
   * Get all public models from Firebase
   */
  async getPublicModels(params?: {
    offset?: number;
    limit?: number;
  }): Promise<ModelsResponse> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.offset) queryParams.append('offset', params.offset.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());

      const url = `${this.baseUrl}/v1/models/public${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
      
      return await apiFetch(url, {
        method: 'GET',
      });
    } catch (error) {
      console.error('Failed to get public models:', error);
      throw error;
    }
  }

  /**
   * Get user's own models
   */
  async getUserModels(userId: string, params?: {
    offset?: number;
    limit?: number;
  }): Promise<ModelsResponse> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.offset) queryParams.append('offset', params.offset.toString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());

      const url = `${this.baseUrl}/v1/models/user/${userId}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
      
      return await apiFetch(url, {
        method: 'GET',
      });
    } catch (error) {
      console.error('Failed to get user models:', error);
      throw error;
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelId: string): Promise<any> {
    try {
      const result = await apiFetch(`${this.baseUrl}/v1/models/${modelId}`, {
        method: 'DELETE',
      });
      return result;
    } catch (error) {
      const status = (error as any)?.status;
      if (status === 404) {
        return { success: true, message: 'Model was already deleted' };
      }
      throw error;
    }
  }

  /**
   * Download a model file
   */
  async downloadModel(downloadLink: string): Promise<any> {
    try {
      // This will use the existing download endpoint
      return await apiFetch(`${this.baseUrl}/v1/models/download/${downloadLink}`, {
        method: 'GET',
        isReturnResponse: true
      });
    } catch (error) {
      console.error('Failed to download model:', error);
      throw error;
    }
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
   * Get model display name
   */
  getDisplayName(model: ModelDataResponse): string {
    return model.title || model.fileName || 'Unknown Model';
  }

  /**
   * Get model author display
   */
  getAuthorDisplay(model: ModelDataResponse): string {
    // Browser-only: SSR / Node has no `localStorage` (access throws ReferenceError).
    if (typeof window !== 'undefined' && model.ownerId && model.ownerId !== 'anonymous') {
      try {
        const preferredName = window.localStorage.getItem(`preferred_name_${model.ownerId}`)
        if (preferredName && preferredName !== 'null' && preferredName !== '') {
          return preferredName
        }
      } catch (error) {
        console.warn('Failed to get preferred_name from localStorage:', error)
      }
    }
    
    // Fallback to user ID substring
    return model.ownerId?.substring(0, 8) || 'Unknown';
  }
}

// Export a singleton instance
export const modelsService = new ModelsService();

