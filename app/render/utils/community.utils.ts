/**
 * Utility functions for the Community module
 */

import { getTagColor } from '@/components/ui/color-tag'
import { apiFetch } from '@/utils/common/apiFetch'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import type { BaseModelItem } from '@/types/community.types'

/**
 * Format file size from bytes to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Read number of classes from XGB classifier file
 */
export async function readXGBClasses(filePath: string): Promise<number | null> {
  try {
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/analyze-file`, {
      method: 'POST',
      body: JSON.stringify({ file_path: filePath }),
      returnAxiosFormat: true,
    })

    if (response.status !== 200) {
      throw new Error(`Analysis API failed: ${response.status}`)
    }

    const result = response.data
    const classesCount = result.analysis?.classes
    
    if (classesCount && typeof classesCount === 'number') {
      return classesCount
    }
    
    console.warn('No classes information found in file analysis')
    return null
  } catch (error) {
    console.warn('Failed to read XGB classes:', error)
    return null
  }
}

/**
 * Convert various timestamp formats to ISO string
 */
export function toISOString(value: any): string {
  try {
    if (!value) return new Date().toISOString()
    
    // Handle Firebase Timestamp objects
    if (typeof value === 'object') {
      const seconds = (value as any).seconds || (value as any)._seconds
      if (typeof seconds === 'number') {
        return new Date(seconds * 1000).toISOString()
      }
      if (typeof (value as any).toDate === 'function') {
        return (value as any).toDate().toISOString()
      }
    }
    
    // Handle number or string timestamps
    const date = new Date(typeof value === 'number' ? value : String(value))
    if (isNaN(date.getTime())) {
      return new Date().toISOString()
    }
    
    return date.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * Get hierarchical color class for factory tags
 * @deprecated Use getTagColor from @/components/ui/color-tag instead
 */
export function getFactoryTagColor(displayTag: string, isFactory: boolean, factoryName: string): string {
  return getTagColor(displayTag, isFactory, factoryName)
}

/**
 * Get color for filter display tags (returns ColorTag color value)
 * Wrapper around getTagColor that handles classifier/model lookup
 */
export function getFilterTagColor(
  tagText: string, 
  allItems: BaseModelItem[],
  factoryName?: string
): ReturnType<typeof getTagColor> {
  // Use provided factoryName or find it from items
  const resolvedFactoryName = factoryName || 
    allItems.find((c) => c.node === tagText)?.factory

  return getTagColor(tagText, false, resolvedFactoryName)
}

