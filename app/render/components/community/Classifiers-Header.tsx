/**
 * Classifiers Header Component
 * Reusable header component for classifiers sections with search, sort, tags, and actions
 */

import { Button } from "@/components/ui/button"
import { ColorTag, getTagColor } from '@/components/ui/color-tag'
import { ExpandableSearch } from '@/components/ui/ExpandableSearch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { BaseModelItem, ClassifierData, SortOption } from '@/types/community.types'
import { getFilterTagColor } from '@/utils/community.utils'
import type { LucideIcon } from "lucide-react"
import { ArrowUpDown, Upload } from "lucide-react"
import * as React from "react"

interface ClassifiersHeaderProps {
  // Title section
  title: string | React.ReactNode
  titleIcon?: LucideIcon | React.ReactNode
  
  // Search
  search: string
  onSearchChange: (value: string) => void
  
  // Tags
  selectedTags: string[]
  onTagClick: (tag: string) => void
  classifiers?: BaseModelItem[] // For getting factory name (supports both ClassifierData and ModelData)
  useSimpleTagColor?: boolean // If true, use getTagColor instead of getFilterTagColor
  
  // Sort (optional)
  sort?: SortOption | string
  onSortChange?: ((value: SortOption) => void) | ((value: string) => void)
  
  // Upload button (optional)
  onUploadClick?: () => void
  
  // Additional actions (optional)
  actions?: React.ReactNode
}

export function ClassifiersHeader({
  title,
  titleIcon: TitleIcon,
  search,
  onSearchChange,
  selectedTags,
  onTagClick,
  classifiers,
  useSimpleTagColor = false,
  sort,
  onSortChange,
  onUploadClick,
  actions,
}: ClassifiersHeaderProps) {
  // Determine tag color function
  const getTagColorFn = (tag: string) => {
    if (useSimpleTagColor) {
      return getTagColor(tag)
    }
    if (classifiers) {
      const matchingItem = classifiers.find((c) => c.node === tag)
      const factoryName = matchingItem?.factory
      return getFilterTagColor(tag, classifiers, factoryName)
    }
    return getTagColor(tag)
  }

  return (
    <div className="mb-4 space-y-3">
      {/* First Row: Title, Search, Sort, Upload */}
      <div className="flex items-center justify-between gap-3">
        {/* Title */}
        <div className="flex items-center gap-2">
          {TitleIcon && (
            React.isValidElement(TitleIcon) ? (
              TitleIcon
            ) : typeof TitleIcon === 'function' ? (
              <TitleIcon className="h-5 w-5 text-primary" />
            ) : null
          )}
          {typeof title === 'string' ? (
            <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          ) : (
            title
          )}
        </div>

        {/* Actions: Search, Sort, Upload */}
        <div className="flex items-center gap-3">
          {/* Search */}
          <ExpandableSearch
            value={search}
            onChange={onSearchChange}
            placeholder="Full-text search"
            onClear={() => onSearchChange('')}
          />

          {/* Sort */}
          {sort !== undefined && onSortChange && (
            <Select value={sort as string} onValueChange={(value) => onSortChange(value as any)}>
              <SelectTrigger className="w-48 rounded-[6px] border border-border bg-card shadow-none">
                <div className="flex items-center gap-2">
                  <ArrowUpDown className="h-4 w-4" />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="most_stars">Most Stars</SelectItem>
                <SelectItem value="most_downloads">Most Downloads</SelectItem>
                <SelectItem value="recently_upload">Recently Upload</SelectItem>
              </SelectContent>
            </Select>
          )}

          {/* Upload Button */}
          {onUploadClick && (
            <Button 
              size="sm" 
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={onUploadClick}
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          )}

          {/* Additional Actions */}
          {actions}
        </div>
      </div>

      {/* Second Row: Tags */}
      {selectedTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {selectedTags.map((tag) => {
            const tagColor = getTagColorFn(tag)
            
            return (
              <ColorTag
                key={tag}
                color={tagColor}
                className="flex items-center gap-1 whitespace-nowrap flex-shrink-0 h-6 bg-card"
              >
                <span className="text-xs">{tag}</span>
                <button
                  onClick={() => onTagClick(tag)}
                  className="hover:opacity-70 transition-opacity ml-1 h-3.5 w-3.5 flex items-center justify-center"
                  title="Remove tag filter"
                >
                  <span className="text-[10px] leading-none">✕</span>
                </button>
              </ColorTag>
            )
          })}
        </div>
      )}
    </div>
  )
}

