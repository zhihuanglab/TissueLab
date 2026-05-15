/**
 * Models Section Component
 * Displays the custom models grid with search, sort, and pagination
 */

'use client'

import { ClassifiersHeader } from '@/components/community/Classifiers-Header'
import { Button } from "@/components/ui/button"
import type { BaseModelItem, ModelData, SortOption } from '@/types/community.types'
import { ChevronLeft, ChevronRight, Package, Upload } from "lucide-react"
import { useEffect, useState } from 'react'
import ModelCard from './ModelCard'

interface ModelsSectionProps {
  models: ModelData[]
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  selectedTags: string[]
  onTagClick: (tag: string) => void
  sort: SortOption
  onSortChange: (value: SortOption) => void
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  onUploadClick: () => void
  onDeleteModel: (id: string) => void
  canDelete: (model: ModelData) => boolean
  onStatsUpdate: (id: string, stats: { downloads?: number; stars?: number }) => void
  userInfo?: any
  firebaseModels: any[]
  userUploadedModels: ModelData[]
}

export function ModelsSection({
  models,
  loading,
  search,
  onSearchChange,
  selectedTags,
  onTagClick,
  sort,
  onSortChange,
  currentPage,
  totalPages,
  onPageChange,
  onUploadClick,
  onDeleteModel,
  canDelete,
  onStatsUpdate,
  userInfo,
  firebaseModels,
  userUploadedModels,
}: ModelsSectionProps) {
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  if (!isMounted) {
    return null
  }

  return (
    <div>
      <ClassifiersHeader
        title="Custom Models"
        titleIcon={Package}
        search={search}
        onSearchChange={onSearchChange}
        selectedTags={selectedTags}
        onTagClick={onTagClick}
        classifiers={models as BaseModelItem[]}
        useSimpleTagColor={false}
        sort={sort}
        onSortChange={onSortChange}
        onUploadClick={onUploadClick}
      />
      
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="animate-pulse rounded-[6px] border border-border bg-card p-4">
              <div className="mb-2 h-4 rounded bg-muted"></div>
              <div className="mb-3 h-3 rounded bg-muted"></div>
              <div className="mb-3 flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-muted"></div>
                <div className="h-3 w-20 rounded bg-muted"></div>
              </div>
              <div className="mb-3 flex gap-1">
                <div className="h-5 w-16 rounded bg-muted"></div>
                <div className="h-5 w-12 rounded bg-muted"></div>
              </div>
              <div className="h-8 rounded bg-muted"></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {models.length > 0 ? (
            models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                onDelete={onDeleteModel}
                canDelete={canDelete(model)}
                onTagClick={(tag) => {
                  onTagClick(tag)
                  onSearchChange('')
                }}
                onStatsUpdate={onStatsUpdate}
              />
            ))
          ) : (
            <div className="col-span-full py-12 text-center">
              <Package className="mx-auto mb-4 h-16 w-16 text-muted-foreground/60" />
              <h3 className="mb-2 text-xl font-semibold text-foreground">No models found</h3>
              <p className="mb-4 text-muted-foreground">
                {search.trim() 
                  ? 'No models match your search criteria.'
                  : 'Be the first to upload a custom model to the community!'}
              </p>
              <Button 
                variant="default"
                onClick={onUploadClick}
              >
                <Upload />
                Upload Model
              </Button>
            </div>
          )}
        </div>
      )}
      
      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-1">
          <button
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </button>
          
          <button
            onClick={() => onPageChange(1)}
            className={`rounded-lg px-2.5 py-1 text-sm ${
              currentPage === 1
                ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                : 'text-muted-foreground transition-colors hover:bg-accent/40'
            }`}
          >
            1
          </button>
          
          {currentPage > 4 && totalPages > 6 && (
            <span className="pointer-events-none cursor-default rounded-lg px-2.5 py-1 text-sm text-muted-foreground/70">
              ...
            </span>
          )}
          
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(pageNum => {
              if (pageNum === 1 || pageNum === totalPages) return false
              return Math.abs(pageNum - currentPage) <= 1
            })
            .map(pageNum => (
              <button
                key={pageNum}
                onClick={() => onPageChange(pageNum)}
                className={`rounded-lg px-2.5 py-1 text-sm ${
                  currentPage === pageNum
                    ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                    : 'text-muted-foreground transition-colors hover:bg-accent/40'
                }`}
              >
                {pageNum}
              </button>
            ))}
          
          {currentPage < totalPages - 3 && totalPages > 6 && (
            <span className="pointer-events-none cursor-default rounded-lg px-2.5 py-1 text-sm text-muted-foreground/70">
              ...
            </span>
          )}
          
          {totalPages > 1 && (
            <button
              onClick={() => onPageChange(totalPages)}
              className={`rounded-lg px-2.5 py-1 text-sm ${
                currentPage === totalPages
                  ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                  : 'text-muted-foreground transition-colors hover:bg-accent/40'
              }`}
            >
              {totalPages}
            </button>
          )}
          
          <button
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}



