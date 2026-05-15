/**
 * Utility functions for node management operations
 */

import { apiFetch, requireAxiosAppPayload } from '@/utils/common/apiFetch'
import { ApiError, getErrorMessage } from '@/utils/common/apiResponse'
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { toast } from 'sonner'

export async function deleteNode(nodeName: string) {
  try {
    const res = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/delete_node`, {
      method: 'POST',
      body: JSON.stringify({ model_name: nodeName }),
      returnAxiosFormat: true,
    })
    requireAxiosAppPayload(res)
    return { success: true }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Delete failed:', e.message)
      toast.error(getErrorMessage(e, 'Delete failed'))
      return { success: false, error: e.message }
    }
    console.error(e)
    return { success: false, error: 'Network error' }
  }
}

export async function downloadNodeForElectron(
  node: string,
  categories: Record<string, string[]>,
  installing: Record<string, boolean>,
  setInstalling: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void,
  onComplete?: () => void
) {
  // Set installing state IMMEDIATELY to prevent duplicate clicks
  if (installing[node]) {
    toast.info('This tasknode is already being installed')
    return
  }
  
  setInstalling(prev => ({ ...prev, [node]: true }))

  let onProgress: ((payload: any) => Promise<void>) | null = null
  
  try {
    const apiUrl = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/tasknodes/signed-url`
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const platform = ua.includes('Mac') ? 'darwin' : (ua.includes('Windows') ? 'win' : 'linux')
    const payload = { model_name: node, platform }
    
    console.log('Requesting signed URL:', { apiUrl, payload })
    
    let response
    try {
      response = await apiFetch(apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        returnAxiosFormat: true,
      })
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 404) {
        toast.info('No bundle available for your platform yet')
        setInstalling(prev => { const { [node]: _, ...rest } = prev; return rest })
        return
      }
      throw err
    }
    
    const j = response?.data
    console.log('API response data:', j)
    
    if (!j?.success || !j?.download_url) {
      throw new Error(j?.message || 'Failed to get signed URL')
    }
    
    const url = j.download_url as string
    const filename = j?.filename || 'tasknode.tar.gz'
    const factory = Object.keys(categories).find(f => categories[f].includes(node)) || ''

    let isExtracting = false
    onProgress = async (payload: any) => {
      if (payload.url === url && payload.state === 'completed' && !isExtracting) {
        isExtracting = true
        
        toast.info(`Extracting ${node}...`, { duration: Infinity, id: 'extraction-toast' } as any)
        
        try {
          const extractResult = await (window as any).electron.invoke('extract-zip-and-persist', {
            zipPath: payload.filePath,
            modelName: node,
            factory: factory,
            url: url,
          })
          
          toast.dismiss('extraction-toast')
          
          if (extractResult && extractResult.success) {
            toast.success(`${node} extracted successfully. Ready to activate!`, { duration: 5000 } as any)
            
            try {
              await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reload_model_registry`, {
                method: 'POST',
                returnAxiosFormat: true,
              })
            } catch (reloadErr) {
              console.warn('Failed to reload model registry:', reloadErr)
            }
            
            if (onComplete) onComplete()
          } else {
            toast.error(`Extraction failed: ${extractResult?.error || 'Unknown error'}`, { duration: 5000 } as any)
          }
          setInstalling(prev => { const { [node]: _, ...rest } = prev; return rest })
          ;(window as any).electron.off('download-progress', onProgress)
        } catch (err: any) {
          toast.dismiss('extraction-toast')
          console.error('Extract error:', err)
          toast.error(`Extraction failed: ${err?.message || 'Unknown error'}`, { duration: 5000 } as any)
          setInstalling(prev => { const { [node]: _, ...rest } = prev; return rest })
          ;(window as any).electron.off('download-progress', onProgress)
        }
      } else if (payload.url === url && (payload.state === 'failed' || payload.state === 'cancelled')) {
        ;(window as any).electron.off('download-progress', onProgress)
        toast.error(`Download ${payload.state}: ${payload.error || ''}`, { duration: 5000 } as any)
        setInstalling(prev => { const { [node]: _, ...rest } = prev; return rest })
      }
    }

    // Register listener BEFORE invoking download to ensure we catch all events
    ;(window as any).electron.on('download-progress', onProgress)

    const downloadResult = await (window as any).electron.invoke('download-signed-url', {
      url,
      filename,
      showSaveDialog: false,
    })

    if (!downloadResult?.ok) {
      throw new Error(downloadResult?.error || 'Download failed to start')
    }

  } catch (e) {
    console.error('Download error:', e)
    toast.error(getErrorMessage(e, 'Download failed'))
    // Ensure listener is removed even on error
    if (onProgress) {
      ;(window as any).electron.off('download-progress', onProgress)
    }
    setInstalling(prev => { const { [node]: _, ...rest } = prev; return rest })
  }
}
