/**
 * Classifiers Section Component
 * Displays the classifiers grid with search, sort, and pagination
 */

import { ClassifierCard } from '@/components/community'
import { ClassifiersHeader } from '@/components/community/Classifiers-Header'
import { Button } from "@/components/ui/button"
import type { ClassifierData, SortOption } from '@/types/community.types'
import { ChevronLeft, ChevronRight, Database, Upload } from "lucide-react"

interface ClassifiersSectionProps {
  classifiers: ClassifierData[]
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
  onDeleteClassifier: (id: string) => void
  canDelete: (classifier: ClassifierData) => boolean
  onStatsUpdate: (id: string, stats: { downloads?: number; stars?: number }) => void
  userInfo?: any
  firebaseClassifiers: any[]
  userUploadedClassifiers: ClassifierData[]
}

export function ClassifiersSection({
  classifiers,
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
  onDeleteClassifier,
  canDelete,
  onStatsUpdate,
  userInfo,
  firebaseClassifiers,
  userUploadedClassifiers,
}: ClassifiersSectionProps) {
  return (
    <div>
      <ClassifiersHeader
        title="Classifiers"
        titleIcon={Database}
        search={search}
        onSearchChange={onSearchChange}
        selectedTags={selectedTags}
        onTagClick={onTagClick}
        classifiers={classifiers}
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
          {classifiers.length > 0 ? (
            classifiers.map((classifier) => (
              <ClassifierCard
                key={classifier.id}
                classifier={classifier}
                onDelete={onDeleteClassifier}
                canDelete={canDelete(classifier)}
                onTagClick={(tag) => {
                  onTagClick(tag)
                  onSearchChange('')
                }}
                onStatsUpdate={onStatsUpdate}
              />
            ))
          ) : (
            <div className="col-span-full py-12 text-center">
              <Database className="mx-auto mb-4 h-16 w-16 text-muted-foreground/60" />
              <h3 className="mb-2 text-xl font-semibold text-foreground">No classifiers found</h3>
              <p className="mb-4 text-muted-foreground">
                {search.trim() 
                  ? 'No classifiers match your search criteria.'
                  : 'Be the first to upload a classifier to the community!'}
              </p>
              <Button 
                variant="default"
                onClick={onUploadClick}
              >
                <Upload />
                Upload Classifier
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

