import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { apiFetch } from '@/utils/apiFetch'

export interface UserProfile {
  user_id: string
  email?: string
  is_anonymous: boolean
  preferred_name?: string
  custom_title?: string
  organization?: string
  avatar_url?: string
  registered_at?: number
  plan: {
    total_limit: number
    available_count: number
    usage_count: number
    lifetime_limit: number
    expire_limit?: number
    expire_at?: number
  }
  subscription: {
    in_subscription: boolean
    subscription_name?: string
    start_at?: number
    end_at?: number
  }
  allow_email_notify: boolean
  ever_paid: boolean
}

export interface UpdateProfileRequest {
  preferred_name?: string
  custom_title?: string
  organization?: string
  avatar_url?: string
}

export class UsersService {
  private baseUrl = `${CTRL_SERVICE_API_ENDPOINT}/users`

  async getCurrentUser(): Promise<UserProfile> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/me`, {
        method: 'POST',
      })
    } catch (error) {
      console.error('Failed to get current user:', error)
      throw error
    }
  }

  async updateProfile(profileData: UpdateProfileRequest): Promise<any> {
    try {
      return await apiFetch(`${this.baseUrl}/v1/update_profile`, {
        method: 'POST',
        body: JSON.stringify(profileData),
      })
    } catch (error) {
      console.error('Failed to update profile:', error)
      throw error
    }
  }

  async getUserByUsername(username: string): Promise<UserProfile | null> {
    // For now, we'll try to get the current user and see if username matches
    // In a real implementation, there would be a specific endpoint for this
    try {
      const currentUser = await this.getCurrentUser()
      const userUsername = currentUser.user_id.substring(0, 8)
      
      if (userUsername === username) {
        return currentUser
      }
      
      return null
    } catch (error) {
      console.error('Failed to get user by username:', error)
      return null
    }
  }
}

export const usersService = new UsersService()
