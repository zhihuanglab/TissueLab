import { apiFetch } from "@/utils/apiFetch";
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config";

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
  private baseUrl = `${CTRL_SERVICE_API_ENDPOINT}/community`

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
      return await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      const status = (error as any)?.status;
      // If classifier is already deleted (404), treat as success
      if (status === 404) {
        console.log(`Classifier ${classifierId} was already deleted`);
        return { success: true, message: 'Classifier was already deleted' };
      }
      console.error('Failed to delete classifier:', error);
      throw error;
    }
  }

  /**
   * Download a classifier file
   */
  async downloadClassifier(downloadLink: string): Promise<any> {
    try {
      // This will use the existing download endpoint
      return await apiFetch(`${this.baseUrl}/v1/download/${downloadLink}`, {
        method: 'GET',
        isReturnResponse: true
      });
    } catch (error) {
      console.error('Failed to download classifier:', error);
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
   * Get classifier display name
   */
  getDisplayName(classifier: ClassifierData): string {
    return classifier.title || classifier.fileName || 'Unknown Classifier';
  }

  /**
   * Get classifier author display
   */
  getAuthorDisplay(classifier: ClassifierData): string {
    // Try to get preferred_name from localStorage first
    if (classifier.ownerId && classifier.ownerId !== 'anonymous') {
      try {
        const preferredName = localStorage.getItem(`preferred_name_${classifier.ownerId}`);
        if (preferredName && preferredName !== 'null' && preferredName !== '') {
          return preferredName;
        }
      } catch (error) {
        console.warn('Failed to get preferred_name from localStorage:', error);
      }
    }
    
    // Fallback to user ID substring
    return classifier.ownerId?.substring(0, 8) || 'Unknown';
  }
}

// Export a singleton instance
export const classifiersService = new ClassifiersService();
