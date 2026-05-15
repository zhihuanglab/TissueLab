/**
 * Custom hook for managing model upload logic
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '@/utils/common/apiFetch'
import { getApiResponseErrorMessage, getErrorMessage } from '@/utils/common/apiResponse'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { uploadFiles } from '@/utils/dashboard/fileManager.service'
import { formatFileSize } from '@/utils/community.utils'
import { FACTORY_CATEGORIES } from '@/constants/community.constants'
import type { ModelData } from '@/types/community.types'

export function useModelUpload(userInfo?: any) {
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploadFilePath, setUploadFilePath] = useState('')
  const [uploadingModel, setUploadingModel] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [selectedFactory, setSelectedFactory] = useState<string>('')
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('')
  const [selectedUploadModalityTags, setSelectedUploadModalityTags] = useState<string[]>([])
  const [uploadFile_, setUploadFile_] = useState<File | null>(null)

  const handleSelectModelFile = async () => {
    try {
      const isElectron = typeof window !== 'undefined' && (window as any).electron
      
      if (isElectron) {
        const result = await (window as any).electron.invoke('open-file-dialog', {
          title: 'Select model file to upload',
          filters: [
            { name: 'ZIP Files', extensions: ['zip'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        
        if (result?.filePaths?.length) {
          const filePath = result.filePaths[0]
          // Validate file extension
          if (!filePath.toLowerCase().endsWith('.zip')) {
            toast.error('Please select a .zip file')
            return
          }
          setUploadFilePath(filePath)
          try {
            const fileBuffer = await (window as any).electron.invoke('read-file', filePath)
            const fileName = filePath.split(/[\\/]/).pop() || 'model'
            const file = new File([fileBuffer], fileName, { type: 'application/zip' })
            setUploadFile_(file)
          } catch (readError) {
            console.error('Error reading file:', readError)
            setUploadFile_(null)
          }
        }
      } else {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.zip,application/zip,application/x-zip-compressed'
        input.style.display = 'none'
        input.onchange = (e: Event) => {
          const target = e.target as HTMLInputElement
          const file = target.files?.[0]
          if (file) {
            // Validate file extension
            if (!file.name.toLowerCase().endsWith('.zip')) {
              toast.error('Please select a .zip file')
              return
            }
            setUploadFilePath(file.name)
            setUploadFile_(file)
          }
        }
        document.body.appendChild(input)
        input.click()
        document.body.removeChild(input)
      }
    } catch (e) {
      console.error('File selection error:', e)
    }
  }

  const handleUploadModel = async (
    onSuccess?: (model: ModelData) => void
  ) => {
    if (!uploadTitle || !uploadFile_ || !selectedFactory) {
      toast.error('Please provide a title, select a factory category, and choose a model file.')
      return
    }

    try {
      setUploadingModel(true)
      
      let filePath: string
      try {
        const dt = new DataTransfer()
        dt.items.add(uploadFile_)
        const files = dt.files
        const uploadResponse = await uploadFiles('models', files, () => {} , false)
        const originalFileName = uploadFile_.name.split('\\').pop()?.split('/').pop() || uploadFile_.name
        
        let actualFileName = originalFileName
        if (uploadResponse?.uploaded_files?.length > 0) {
          actualFileName = uploadResponse.uploaded_files[0].actual_name
        }
        
        filePath = `models/${actualFileName}`
      } catch (uploadError: any) {
        console.error('File manager upload error:', uploadError)
        throw new Error(`File upload failed: ${uploadError?.message || 'Unknown error'}`)
      }

      const generateDownloadLink = () => {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      }
      
      const downloadLink = generateDownloadLink()
      const factoryCategory = FACTORY_CATEGORIES.find(f => f.id === selectedFactory)
      
      const preferredName = userInfo?.user_id ? 
        localStorage.getItem(`preferred_name_${userInfo.user_id}`) : null
      
      const capitalizedTitle = uploadTitle.charAt(0).toUpperCase() + uploadTitle.slice(1)
      
      const userCustomAvatar = userInfo?.user_id
        ? localStorage.getItem(`user_avatar_${userInfo.user_id}`)
        : null

      // Build complete tags array (factory + node + modality tags)
      const categoryDisplay: Record<string, string> = {
        'tissue_segmentation': 'Tissue Segmentation',
        'cell_segmentation': 'Cell Segmentation + Embedding',
        'nuclei_classification': 'Nuclei Classification',
        'code_calculation': 'Coding Agent',
        'tissue_classification': 'Tissue Classification',
      }
      
      const completeTags: string[] = []
      const factoryDisplay = selectedFactory ? (categoryDisplay[selectedFactory] || selectedFactory) : ''
      if (factoryDisplay) completeTags.push(factoryDisplay)
      if (selectedSubCategory && (!factoryDisplay || !factoryDisplay.toLowerCase().includes(selectedSubCategory.toLowerCase()))) {
        completeTags.push(selectedSubCategory)
      }
      for (const t of selectedUploadModalityTags) {
        if (typeof t === 'string') completeTags.push(t)
      }

      const newModel: ModelData = {
        id: `uploaded-${Date.now()}`,
        title: capitalizedTitle,
        description: uploadDescription || 'User uploaded model',
        author: {
          name: preferredName || userInfo?.user_id || 'Anonymous User',
          avatar: userCustomAvatar || '/avatars/default.jpg',
          user_id: userInfo?.user_id || 'anonymous',
          username: userInfo?.user_id || 'anonymous'
        },
        stats: {
          size: formatFileSize(uploadFile_.size),
          downloads: 0,
          stars: 0,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        },
        tags: completeTags,
        thumbnail: '/thumbnails/default.jpg',
        filePath: filePath,
        downloadLink: downloadLink,
        factory: selectedFactory,
        model: selectedSubCategory || '',
        node: selectedSubCategory || ''
      }
      
      try {
        const originalFileName = uploadFile_.name.split('\\').pop()?.split('/').pop() || uploadFile_.name
        const actualFileName = filePath.split('/').pop() || originalFileName
        
        const mappingResponse = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/register`, {
          method: 'POST',
          body: JSON.stringify({
            model_id: newModel.id,
            download_link: downloadLink,
            file_name: actualFileName,
            original_file_name: originalFileName,
            file_path: filePath,
            title: capitalizedTitle,
            description: uploadDescription || 'User uploaded model',
            tags: completeTags,
            file_size: uploadFile_.size,
            factory: selectedFactory,
            model: selectedSubCategory || ''
          })
        })
        
        if (!mappingResponse?.success) {
          throw new Error(
            getApiResponseErrorMessage(mappingResponse)
            || mappingResponse?.message
            || 'Firebase registration failed'
          )
        }
      } catch (error) {
        console.error('Failed to register model to Firebase:', error)
        throw new Error(getErrorMessage(error, 'Failed to register model'))
      }
      
      // Save to localStorage
      const savedModels = JSON.parse(localStorage.getItem('userUploadedModels') || '[]')
      savedModels.unshift(newModel)
      localStorage.setItem('userUploadedModels', JSON.stringify(savedModels))
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedModels' } }))
      
      // Reset form
      setUploadTitle('')
      setUploadDescription('')
      setUploadFilePath('')
      setSelectedFactory('')
      setSelectedSubCategory('')
      setSelectedUploadModalityTags([])
      setUploadFile_(null)
      setUploadDialogOpen(false)
      
      if (onSuccess) onSuccess(newModel)
      
    } catch (e) {
      console.error('Upload error:', e)
      toast.error(getErrorMessage(e, 'Upload failed'))
    } finally {
      setUploadingModel(false)
    }
  }

  const handleUploadModalityTagClick = (tag: string) => {
    setSelectedUploadModalityTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    )
  }

  return {
    uploadTitle,
    setUploadTitle,
    uploadDescription,
    setUploadDescription,
    uploadFilePath,
    uploadingModel,
    uploadDialogOpen,
    setUploadDialogOpen,
    selectedFactory,
    setSelectedFactory,
    selectedSubCategory,
    setSelectedSubCategory,
    selectedUploadModalityTags,
    handleSelectModelFile,
    handleUploadModel,
    handleUploadModalityTagClick,
  }
}

