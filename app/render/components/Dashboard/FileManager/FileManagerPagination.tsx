"use client";
import React, { useEffect, useState } from 'react';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface PaginationState {
  offset: number;
  limit: number | null;
  total: number;
  hasMore: boolean;
}

export interface FileManagerPaginationProps {
  pagination: PaginationState;
  isLoading?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSizeChange: (limit: number | null) => void;
  onPageClick: (page: number) => void;
}

/**
 * Reusable pagination component for file managers
 * Handles pagination UI and page number generation
 */
export const FileManagerPagination: React.FC<FileManagerPaginationProps> = ({
  pagination,
  isLoading = false,
  onPrevious,
  onNext,
  onPageSizeChange,
  onPageClick,
}) => {
  // Container-width tracking for the pagination row. Same pattern as the
  // file table above: when the panel is narrow, drop the secondary affordances
  // (showing-text first, then items-per-page) so prev/next + page numbers
  // — the only things you can't replicate elsewhere — always survive.
  //
  // Approximate widths reserved per piece, used to compose thresholds so the
  // numbers stay maintainable instead of magic.
  const RESERVED_PAGINATION = 280;        // prev + ~5 page links + next
  const RESERVED_PERPAGE = 170;           // "Items per page:" + select
  const RESERVED_SHOWING = 180;           // "Showing 1-25 of 1234 items"
  const SHOW_PERPAGE_WIDTH = RESERVED_PAGINATION + RESERVED_PERPAGE;
  const SHOW_SHOWING_WIDTH = SHOW_PERPAGE_WIDTH + RESERVED_SHOWING;

  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(SHOW_SHOWING_WIDTH);
  useEffect(() => {
    if (!containerEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl]);
  const showShowing = containerWidth >= SHOW_SHOWING_WIDTH;
  const showPerPage = containerWidth >= SHOW_PERPAGE_WIDTH;

  // Don't show pagination if total is 0
  if (pagination.total === 0) {
    return null;
  }

  const isAll = pagination.limit === null;
  const limit = isAll ? (pagination.total || 1) : pagination.limit!;

  const currentPage = isAll ? 1 : Math.floor(pagination.offset / limit) + 1;
  const totalPages = isAll ? 1 : Math.ceil(pagination.total / limit);
  const startItem = pagination.total > 0 ? (isAll ? 1 : pagination.offset + 1) : 0;
  const endItem = isAll ? pagination.total : Math.min(pagination.offset + limit, pagination.total);

  // Generate page numbers to display
  const getPageNumbers = (): (number | 'ellipsis')[] => {
    const pages: (number | 'ellipsis')[] = [];
    const maxVisiblePages = 5;
    
    if (totalPages <= maxVisiblePages) {
      // Show all pages if total pages is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);
      
      if (currentPage > 3) {
        pages.push('ellipsis');
      }
      
      // Show pages around current page
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      
      for (let i = start; i <= end; i++) {
        if (i !== 1 && i !== totalPages) {
          pages.push(i);
        }
      }
      
      if (currentPage < totalPages - 2) {
        pages.push('ellipsis');
      }
      
      // Always show last page
      if (totalPages > 1) {
        pages.push(totalPages);
      }
    }
    
    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <div
      ref={setContainerEl}
      className="flex flex-col sm:flex-row items-center justify-between gap-2 px-3 py-2 bg-card"
    >
      {showShowing ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Showing <span className='font-semibold'>{startItem}-{endItem}</span> of <span className='font-semibold'>{pagination.total}</span>
          </span>
        </div>
      ) : (
        // Empty spacer keeps `justify-between` working when "Showing…" is
        // hidden: pagination stays right-aligned instead of jumping center.
        <span aria-hidden />
      )}
      <div className="flex items-center gap-3">
        {showPerPage && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Per page:</span>
            <Select
              value={pagination.limit === null ? 'all' : pagination.limit.toString()}
              onValueChange={(value) => {
                if (value === 'all') {
                  onPageSizeChange(null);
                } else {
                  onPageSizeChange(parseInt(value, 10));
                }
              }}
            >
              <SelectTrigger className="h-7 w-[72px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <Pagination>
          <PaginationContent className="m-0">
            <PaginationItem>
              <PaginationPrevious
                onClick={() => {
                  if (pagination.offset > 0 && !isLoading) {
                    onPrevious();
                  }
                }}
                disabled={pagination.offset === 0 || isLoading}
              />
            </PaginationItem>
            {pageNumbers.map((page, index) => (
              <PaginationItem key={index}>
                {page === 'ellipsis' ? (
                  <PaginationEllipsis />
                ) : (
                  <PaginationLink
                    onClick={() => {
                      if (page !== currentPage && !isLoading) {
                        onPageClick(page);
                      }
                    }}
                    isActive={page === currentPage}
                    disabled={isLoading}
                  >
                    {page}
                  </PaginationLink>
                )}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext
                onClick={() => {
                  if (pagination.hasMore && !isLoading) {
                    onNext();
                  }
                }}
                disabled={!pagination.hasMore || isLoading}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
};

