/**
 * Custom hook for managing classifier upload logic
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { uploadFiles } from '@/utils/dashboard/fileManager.service'
import { formatFileSize, readXGBClasses } from '@/utils/community.utils'
import { FACTORY_CATEGORIES } from '@/constants/community.constants'
import type { ClassifierData } from '@/types/community.types'

export function useClassifierUpload(userInfo?: any) {
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploadFilePath, setUploadFilePath] = useState('')
  const [uploadingClassifier, setUploadingClassifier] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [selectedFactory, setSelectedFactory] = useState<string>('')
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('')
  const [selectedUploadModalityTags, setSelectedUploadModalityTags] = useState<string[]>([])
  const [uploadFile_, setUploadFile_] = useState<File | null>(null)

  const handleSelectClassifierFile = async () => {
    try {
      const isElectron = typeof window !== 'undefined' && (window as any).electron
      if (isElectron) {
        const result = await (window as any).electron.invoke('open-file-dialog', {
          title: 'Select classifier file to upload',
          filters: [
            { name: 'Classifier Files', extensions: ['tlcls'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })
        if (result?.filePaths?.length) {
          const filePath = result.filePaths[0]
          // Validate file extension
          if (!filePath.toLowerCase().endsWith('.tlcls')) {
            toast.error('Please select a .tlcls file')
            return
          }
          setUploadFilePath(filePath)
          try {
            const fileBuffer = await (window as any).electron.invoke('read-file', filePath)
            const fileName = filePath.split(/[\\/]/).pop() || 'classifier'
            const file = new File([fileBuffer], fileName, { type: 'application/octet-stream' })
            setUploadFile_(file)
          } catch (readError) {
            console.error('Error reading file:', readError)
            setUploadFile_(null)
          }
        }
      } else {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.tlcls'
        input.style.display = 'none'
        input.onchange = (e: Event) => {
          const target = e.target as HTMLInputElement
          const file = target.files?.[0]
          if (file) {
            // Validate file extension
            if (!file.name.toLowerCase().endsWith('.tlcls')) {
              toast.error('Please select a .tlcls file')
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

  const handleUploadClassifier = async (
    onSuccess?: (classifier: ClassifierData) => void
  ) => {
    if (!uploadTitle || !uploadFile_ || !selectedFactory) {
      toast.error('Please provide a title, select a factory category, and choose a classifier file.')
      return
    }

    try {
      setUploadingClassifier(true)
      
      let filePath: string
      try {
        const dt = new DataTransfer()
        dt.items.add(uploadFile_)
        const files = dt.files
        const uploadResponse = await uploadFiles('classifiers', files, () => {} , false)
        const originalFileName = uploadFile_.name.split('\\').pop()?.split('/').pop() || uploadFile_.name
        
        let actualFileName = originalFileName
        if (uploadResponse?.uploaded_files?.length > 0) {
          actualFileName = uploadResponse.uploaded_files[0].actual_name
        }
        
        filePath = `classifiers/${actualFileName}`
      } catch (uploadError: any) {
        console.error('File manager upload error:', uploadError)
        throw new Error(`File upload failed: ${uploadError?.message || 'Unknown error'}`)
      }
      
      let classesCount = null
      try {
        classesCount = await readXGBClasses(filePath)
      } catch (error) {
        console.warn('Could not read classes from XGB file:', error)
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

      const newClassifier: ClassifierData = {
        id: `uploaded-${Date.now()}`,
        title: capitalizedTitle,
        description: uploadDescription || 'User uploaded classifier',
        author: {
          name: preferredName || userInfo?.user_id || 'Anonymous User',
          avatar: userCustomAvatar || '/avatars/default.jpg',
          user_id: userInfo?.user_id || 'anonymous',
          username: userInfo?.user_id || 'anonymous'
        },
        stats: {
          classes: classesCount,
          size: formatFileSize(uploadFile_.size),
          downloads: 0,
          stars: 0,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        },
        tags: [...selectedUploadModalityTags],
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
        
        const mappingResponse = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/register`, {
          method: 'POST',
          body: JSON.stringify({
            classifier_id: newClassifier.id,
            download_link: downloadLink,
            file_name: actualFileName,
            original_file_name: originalFileName,
            file_path: filePath,
            title: capitalizedTitle,
            description: uploadDescription || 'User uploaded classifier',
            tags: selectedUploadModalityTags,
            classes_count: classesCount,
            file_size: uploadFile_.size,
            factory: selectedFactory,
            model: selectedSubCategory || ''
          })
        })
        
        if (mappingResponse?.success) {
          console.log('Classifier successfully saved to Firebase')
        } else {
          console.warn('Failed to save classifier to Firebase:', mappingResponse)
        }
      } catch (error) {
        console.warn('Failed to register classifier to Firebase:', error)
      }
      
      // Save to localStorage
      const savedClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]')
      savedClassifiers.unshift(newClassifier)
      localStorage.setItem('userUploadedClassifiers', JSON.stringify(savedClassifiers))
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }))
      
      // Reset form
      setUploadTitle('')
      setUploadDescription('')
      setUploadFilePath('')
      setSelectedFactory('')
      setSelectedSubCategory('')
      setSelectedUploadModalityTags([])
      setUploadFile_(null)
      setUploadDialogOpen(false)
      
      if (onSuccess) onSuccess(newClassifier)
      
    } catch (e) {
      console.error('Upload error:', e)
      toast.error(getErrorMessage(e, 'Upload failed'))
    } finally {
      setUploadingClassifier(false)
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
    uploadingClassifier,
    uploadDialogOpen,
    setUploadDialogOpen,
    selectedFactory,
    setSelectedFactory,
    selectedSubCategory,
    setSelectedSubCategory,
    selectedUploadModalityTags,
    handleSelectClassifierFile,
    handleUploadClassifier,
    handleUploadModalityTagClick,
  }
}
