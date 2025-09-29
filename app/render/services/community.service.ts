import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { apiFetch } from '@/utils/apiFetch'

export interface CreateClassifierRequest {
  title: string
  description: string
  task_type?: string
  license?: string
  tags: string[]
  source_type: string
}

export interface UploadFileRequest {
  classifierId: string
  file: File
}

export class CommunityService {
  private baseUrl = `${CTRL_SERVICE_API_ENDPOINT}/community`

  async createClassifier(data: CreateClassifierRequest): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/classifiers`, {
        method: 'POST',
        body: JSON.stringify(data),
      })
    } catch (error) {
      console.error('Failed to create classifier:', error)
      throw error
    }
  }

  async uploadFile(classifierId: string, file: File): Promise<any> {
    try {
      const formData = new FormData()
      formData.append('file', file)

      return await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}/upload`, {
        method: 'POST',
        body: formData,
      })
    } catch (error) {
      console.error('Failed to upload file:', error)
      throw error
    }
  }

  async getClassifiers(params?: {
    query?: string
    tags?: string[]
    task_type?: string
    sort_by?: string
    sort_order?: string
    offset?: number
    limit?: number
  }): Promise<any> {
    try {
      const searchParams = new URLSearchParams()
      
      if (params?.query) searchParams.append('query', params.query)
      if (params?.tags?.length) searchParams.append('tags', params.tags.join(','))
      if (params?.task_type) searchParams.append('task_type', params.task_type)
      if (params?.sort_by) searchParams.append('sort_by', params.sort_by)
      if (params?.sort_order) searchParams.append('sort_order', params.sort_order)
      if (params?.offset !== undefined) searchParams.append('offset', params.offset.toString())
      if (params?.limit !== undefined) searchParams.append('limit', params.limit.toString())

      const url = `${this.baseUrl}/v1/classifiers${searchParams.toString() ? '?' + searchParams.toString() : ''}`
      
      return await apiFetch(url, { method: 'GET' })
    } catch (error) {
      console.error('Failed to get classifiers:', error)
      throw error
    }
  }

  async getClassifierDetail(id: string): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/classifiers/${id}`, { method: 'GET' })
    } catch (error) {
      console.error('Failed to get classifier detail:', error)
      throw error
    }
  }

  async toggleLike(classifierId: string): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'like'
        }),
      })
    } catch (error) {
      console.error('Failed to toggle like:', error)
      throw error
    }
  }

  async toggleBookmark(classifierId: string): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          action_type: 'bookmark'
        }),
      })
    } catch (error) {
      console.error('Failed to toggle bookmark:', error)
      throw error
    }
  }

  async incrementDownloadCount(classifierId: string): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/classifiers/${classifierId}/download-count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    } catch (error) {
      console.error('Failed to increment download count:', error)
      throw error
    }
  }

}

export const communityService = new CommunityService()
