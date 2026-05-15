import React, { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Search, ArrowUpDown, ChevronRight, ChevronLeft, Database } from "lucide-react"
import ClassifierCard from './ClassifierCard'
import type { ClassifierData } from '@/types/community.types'

interface FactoryClassifierDetailProps {
  factory: string
  node: string
  onBack: () => void
  allClassifiers: ClassifierData[]
  categoryDisplayNames: Record<string, string>
  onDeleteClassifier?: (classifierId: string) => void
  userUploadedClassifiers: ClassifierData[]
  onStatsUpdate?: (classifierId: string, stats: { downloads?: number; stars?: number }) => void
}

const MODALITY_TAGS = ['Pathology', 'Radiology', 'Spatial Transcriptomics']
const ITEMS_PER_PAGE = 8

export default function FactoryClassifierDetail({
  factory,
  node,
  onBack,
  allClassifiers,
  categoryDisplayNames,
  onDeleteClassifier,
  userUploadedClassifiers,
  onStatsUpdate
}: FactoryClassifierDetailProps) {
  // Search and filter states
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedModalityTags, setSelectedModalityTags] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<'most_stars' | 'most_downloads' | 'recently_upload'>('most_stars')
  const [currentPage, setCurrentPage] = useState(1)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)

  // Filter classifiers by factory with correct mapping
  const categoryToFactoryMap: Record<string, string> = {
    'TissueSeg': 'tissue_segmentation',
    'NucleiSeg': 'cell_segmentation',
    'NucleiClassify': 'nuclei_classification',
    'TissueClassify': 'tissue_classification',
    'Scripts': 'code_calculation'
  }

  const factoryId = categoryToFactoryMap[factory] || factory
  const factoryDisplayName = categoryDisplayNames[factory] || factory

  // Base classifiers filtered by factory/node
  const baseNodeClassifiers = allClassifiers.filter(classifier => {
    // If node is undefined/empty, fall back to factory-only matching for backward compatibility
    if (!classifier.node || classifier.node === 'undefined' || classifier.node === '') {
      return classifier.factory === factoryId
    }
    // Otherwise, require both factory and node match
    return classifier.factory === factoryId && classifier.node === node
  })

  // Apply search and tag filters
  const filteredClassifiers = baseNodeClassifiers.filter(classifier => {
    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      const matchesSearch =
        classifier.title.toLowerCase().includes(query) ||
        classifier.description.toLowerCase().includes(query) ||
        (classifier.author?.name || '').toLowerCase().includes(query)
      if (!matchesSearch) return false
    }

    // Modality tag filter
    if (selectedModalityTags.length > 0) {
      const hasMatchingTag = selectedModalityTags.some(selectedTag =>
        classifier.tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())
      )
      if (!hasMatchingTag) return false
    }

    return true
  })

  // Sort classifiers
  const sortedClassifiers = [...filteredClassifiers].sort((a, b) => {
    switch (sortBy) {
      case 'most_stars':
        return (b.stats.stars || 0) - (a.stats.stars || 0)
      case 'most_downloads':
        return (b.stats.downloads || 0) - (a.stats.downloads || 0)
      case 'recently_upload':
        return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime()
      default:
        return 0
    }
  })

  // Pagination
  const totalPages = Math.ceil(sortedClassifiers.length / ITEMS_PER_PAGE)
  const paginatedClassifiers = sortedClassifiers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  )

  // Handle tag click
  const handleTagClick = (tag: string) => {
    setSelectedModalityTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
    setCurrentPage(1)
  }

  // Handle clear filters
  const clearFilters = () => {
    setSearchQuery('')
    setSelectedModalityTags([])
    setCurrentPage(1)
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="container mx-auto max-w-7xl px-4 py-6">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground">{node}</h1>
              <div className="flex gap-2">
                <Badge className="border border-primary/30 bg-primary/10 text-primary">
                  {factoryDisplayName}
                </Badge>
              </div>
            </div>
            <Button
              onClick={onBack}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </div>
        </div>

        {/* Search and Filter Section */}
        <div className="mb-6 rounded-lg border border-border bg-muted p-4">
          {/* Search Bar */}
          <div className="mb-4 flex gap-4">
            <div className="flex-1">
              <div className="relative w-full">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Search className="h-4 w-4 text-muted-foreground" />
                </div>
                <input
                  type="text"
                  placeholder="Search classifiers..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setCurrentPage(1)
                  }}
                  className="h-9 w-full rounded-md border border-border bg-card py-1.5 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {/* Sort Dropdown */}
            <div className="relative">
              <Button
                variant="outline"
                onClick={() => setSortMenuOpen(!sortMenuOpen)}
                className="min-w-[160px] justify-between"
              >
                <div className="flex items-center">
                  <ArrowUpDown className="mr-2 h-4 w-4" />
                  {sortBy === 'most_stars' ? 'Most Stars' :
                   sortBy === 'most_downloads' ? 'Most Downloads' : 'Recently Upload'}
                </div>
                <ChevronRight className={`h-4 w-4 transition-transform ${sortMenuOpen ? 'rotate-90' : ''}`} />
              </Button>
              {sortMenuOpen && (
                <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-border bg-popover shadow-lg">
                  {[
                    { value: 'most_stars', label: 'Most Stars' },
                    { value: 'most_downloads', label: 'Most Downloads' },
                    { value: 'recently_upload', label: 'Recently Upload' }
                  ].map((option) => (
                    <button
                      key={option.value}
                      className="block w-full px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent/60"
                      onClick={() => {
                        setSortBy(option.value as any)
                        setSortMenuOpen(false)
                        setCurrentPage(1)
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Modality Tags Filter */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">Filter by modality:</span>
            {MODALITY_TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => handleTagClick(tag)}
                className={`px-3 py-1 rounded-md text-sm border transition-colors ${
                  selectedModalityTags.includes(tag)
                    ? 'border border-primary bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-muted-foreground hover:border-primary'
                }`}
              >
                {tag}
              </button>
            ))}
            {(searchQuery || selectedModalityTags.length > 0) && (
              <button
                onClick={clearFilters}
                className="px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>

        {/* Results Summary */}
        <div className="mb-4">
          <p className="text-sm text-muted-foreground">
            {filteredClassifiers.length === baseNodeClassifiers.length ? (
              `Showing all ${filteredClassifiers.length} classifiers`
            ) : (
              `Showing ${filteredClassifiers.length} of ${baseNodeClassifiers.length} classifiers`
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {paginatedClassifiers.length > 0 ? paginatedClassifiers.map((classifier) => (
            <ClassifierCard
              key={classifier.id}
              classifier={classifier}
              onDelete={onDeleteClassifier}
              canDelete={userUploadedClassifiers.some(c => c.id === classifier.id)}
              onStatsUpdate={onStatsUpdate}
              onTagClick={handleTagClick}
            />
          )) : (
            <div className="col-span-full py-12 text-center">
              <Database className="mx-auto mb-4 h-16 w-16 text-muted-foreground/60" />
              <h3 className="mb-2 text-xl font-semibold text-foreground">
                {baseNodeClassifiers.length === 0 ? 'No classifiers available' : 'No matching classifiers'}
              </h3>
              <p className="text-muted-foreground">
                {baseNodeClassifiers.length === 0
                  ? 'No classifiers have been uploaded for this node yet.'
                  : 'Try adjusting your search or filter criteria.'
                }
              </p>
              {(searchQuery || selectedModalityTags.length > 0) && (
                <Button
                  onClick={clearFilters}
                  variant="outline"
                  className="mt-4"
                >
                  Clear Filters
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-1">
            {/* Previous Button */}
            <button
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>

            {/* Page 1 */}
            <button
              onClick={() => setCurrentPage(1)}
              className={`rounded-lg px-2.5 py-1 text-sm ${
                currentPage === 1
                  ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                  : 'text-muted-foreground transition-colors hover:bg-accent/40'
              }`}
            >
              1
            </button>

            {/* Early ellipsis */}
            {currentPage > 4 && totalPages > 6 && (
              <span className="pointer-events-none cursor-default rounded-lg px-2.5 py-1 text-sm text-muted-foreground/70">
                ...
              </span>
            )}

            {/* Pages around current */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(pageNum => {
                if (pageNum === 1 || pageNum === totalPages) return false
                return Math.abs(pageNum - currentPage) <= 1
              })
              .map(pageNum => (
                <button
                  key={pageNum}
                  onClick={() => setCurrentPage(pageNum)}
                  className={`rounded-lg px-2.5 py-1 text-sm ${
                    currentPage === pageNum
                    ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                    : 'text-muted-foreground transition-colors hover:bg-accent/40'
                  }`}
                >
                  {pageNum}
                </button>
              ))}

            {/* Late ellipsis */}
            {currentPage < totalPages - 3 && totalPages > 6 && (
              <span className="pointer-events-none cursor-default rounded-lg px-2.5 py-1 text-sm text-muted-foreground/70">
                ...
              </span>
            )}

            {/* Last page */}
            {totalPages > 1 && (
              <button
                onClick={() => setCurrentPage(totalPages)}
                className={`rounded-lg px-2.5 py-1 text-sm ${
                  currentPage === totalPages
                    ? 'bg-accent/60 font-semibold ring-1 ring-inset ring-border'
                    : 'text-muted-foreground transition-colors hover:bg-accent/40'
                }`}
              >
                {totalPages}
              </button>
            )}

            {/* Next Button */}
            <button
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

