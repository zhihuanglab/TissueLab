"use client";
import React from 'react'
import { useRouter } from 'next/router'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ArrowLeft, Upload } from "lucide-react"
import { FACTORY_CATEGORIES, MODALITY_TAGS } from '@/constants/community.constants'
import { useModelUpload } from '@/hooks/community/useModelUpload'
import { useFactoryNodes } from '@/hooks/community/useCommunityData'
import { toast } from 'sonner'

export default function UploadModelPage() {
  const router = useRouter()
  const { userInfo } = useUserInfo()
  
  const {
    categories,
  } = useFactoryNodes()

  const {
    uploadTitle,
    setUploadTitle,
    uploadDescription,
    setUploadDescription,
    uploadFilePath,
    uploadingModel,
    selectedFactory,
    setSelectedFactory,
    selectedSubCategory,
    setSelectedSubCategory,
    selectedUploadModalityTags,
    handleSelectModelFile,
    handleUploadModel,
    handleUploadModalityTagClick,
  } = useModelUpload(userInfo)

  const handleUpload = async () => {
    await handleUploadModel((model) => {
      toast.success('Model uploaded successfully!')
      // Navigate back to community page
      router.push('/community?tab=home')
    })
  }

  return (
    <div className="bg-background">
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-6 max-w-4xl">
        {/* Back Button */}
        <div className="mb-4 sm:mb-6 sticky top-0 z-10 bg-background pt-2 -mt-2 pb-2">
          <button
            onClick={() => router.push('/community?tab=home')}
            className="flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            <span>Back</span>
          </button>
        </div>

        {/* Upload Model Card */}
        <Card>
          <CardHeader>
            <CardTitle>Upload Custom Model</CardTitle>
            <CardDescription>
              Share your custom model (.zip file) with the community.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="model-title" className="text-right">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="model-title"
                className="col-span-3"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="e.g., My Custom Segmentation Model"
                disabled={uploadingModel}
              />
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="model-factory" className="text-right">
                Factory <span className="text-destructive">*</span>
              </Label>
              <Select value={selectedFactory} onValueChange={setSelectedFactory}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select factory category" />
                </SelectTrigger>
                <SelectContent>
                  {FACTORY_CATEGORIES.map((factory) => (
                    <SelectItem key={factory.id} value={factory.id}>
                      {factory.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="model-subcategory" className="text-right text-sm">
                Model <span className="text-destructive">*</span>
              </Label>
              <Select value={selectedSubCategory} onValueChange={setSelectedSubCategory}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select specific type" />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const factoryToCategoryMap: Record<string, string> = {
                      'tissue_segmentation': 'TissueSeg',
                      'cell_segmentation': 'NucleiSeg',
                      'nuclei_classification': 'NucleiClassify', 
                      'tissue_classification': 'TissueClassify',
                      'code_calculation': 'Scripts'
                    }
                    
                    const categoryKey = factoryToCategoryMap[selectedFactory]
                    const nodes = categoryKey ? categories[categoryKey] : undefined
                    
                    if (nodes && nodes.length > 0) {
                      return nodes.map((node) => (
                        <SelectItem key={node} value={node}>
                          {node}
                        </SelectItem>
                      ))
                    } else {
                      return <SelectItem value="general">General</SelectItem>
                    }
                  })()}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="model-file" className="text-right">
                File <span className="text-destructive">*</span>
              </Label>
              <div className="col-span-3 flex gap-2">
                <Input
                  id="model-file"
                  className="flex-1"
                  value={uploadFilePath}
                  placeholder="Select .zip file"
                  readOnly
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSelectModelFile}
                  disabled={uploadingModel}
                >
                  Browse
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-4 items-start gap-4">
              <Label htmlFor="model-description" className="text-right pt-2">
                Description
              </Label>
              <Textarea
                id="model-description"
                className="col-span-3"
                value={uploadDescription}
                onChange={(e) => setUploadDescription(e.target.value)}
                placeholder="Describe your model's purpose, training data, and performance"
                rows={3}
                disabled={uploadingModel}
              />
            </div>

            <div className="grid grid-cols-4 items-start gap-4">
              <Label className="text-right pt-2">
                Modality Tags
              </Label>
              <div className="col-span-3">
                <div className="flex flex-wrap gap-2">
                  {MODALITY_TAGS.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleUploadModalityTagClick(tag)}
                      disabled={uploadingModel}
                      className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                        selectedUploadModalityTags.includes(tag)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-muted-foreground hover:border-primary'
                      } ${uploadingModel ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <p className="mb-0 mt-1 text-xs text-muted-foreground">Select modality types that apply to your model</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                variant="outline"
                onClick={() => router.push('/community?tab=home')}
                disabled={uploadingModel}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpload}
                disabled={!uploadTitle || !uploadFilePath || !selectedFactory || !selectedSubCategory || uploadingModel}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {uploadingModel ? (
                  <>
                    <Upload className="mr-2 h-4 w-4 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

