/**
 * Upload Model Dialog Component
 */

'use client'

import React from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Upload } from "lucide-react"
import { FACTORY_CATEGORIES, MODALITY_TAGS } from '@/constants/community.constants'

interface UploadModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onTitleChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  filePath: string
  onSelectFile: () => void
  selectedFactory: string
  onFactoryChange: (value: string) => void
  selectedSubCategory: string
  onSubCategoryChange: (value: string) => void
  selectedModalityTags: string[]
  onModalityTagClick: (tag: string) => void
  uploading: boolean
  onUpload: () => void
  categories: Record<string, string[]>
}

export function UploadModelDialog({
  open,
  onOpenChange,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  filePath,
  onSelectFile,
  selectedFactory,
  onFactoryChange,
  selectedSubCategory,
  onSubCategoryChange,
  selectedModalityTags,
  onModalityTagClick,
  uploading,
  onUpload,
  categories,
}: UploadModelDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-[500px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const titleInput = document.getElementById('model-title')
          if (titleInput) {
            titleInput.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Upload Custom Model</DialogTitle>
          <DialogDescription>
            Share your custom model (.zip file) with the community.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="model-title" className="text-right">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="model-title"
              className="col-span-3"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="e.g., My Custom Segmentation Model"
              disabled={uploading}
            />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="model-factory" className="text-right">
              Factory <span className="text-destructive">*</span>
            </Label>
            <Select value={selectedFactory} onValueChange={onFactoryChange}>
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
            <Select value={selectedSubCategory} onValueChange={onSubCategoryChange}>
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
                value={filePath}
                placeholder="Select .zip file"
                readOnly
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSelectFile}
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
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Describe your model's purpose, training data, and performance"
              rows={3}
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
                    onClick={() => onModalityTagClick(tag)}
                    className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                      selectedModalityTags.includes(tag)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card text-muted-foreground hover:border-primary'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <p className="mb-0 mt-1 text-xs text-muted-foreground">Select modality types that apply to your model</p>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={onUpload}
            disabled={!title || !filePath || !selectedFactory || !selectedSubCategory || uploading}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {uploading ? (
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
      </DialogContent>
    </Dialog>
  )
}




