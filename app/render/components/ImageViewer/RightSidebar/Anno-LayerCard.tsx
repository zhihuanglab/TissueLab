"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableHeader,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/utils/twMerge";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download } from "lucide-react";
import React, { useEffect, useState } from "react";

// AnnoActionButtons Component
interface AnnoActionButtonsProps {
  onDownload?: () => void;
  downloadOptions?: Array<{
    label: string;
    onSelect: () => void | Promise<void>;
  }>;
  onExpand?: () => void;
  isExpanded?: boolean;
  downloadTooltip?: string;
  expandTooltip?: string;
  showDownload?: boolean;
  showExpand?: boolean;
}

export const AnnoActionButtons: React.FC<AnnoActionButtonsProps> = ({
  onDownload,
  downloadOptions,
  onExpand,
  isExpanded = false,
  downloadTooltip = "Download",
  expandTooltip,
  showDownload = true,
  showExpand = true,
}) => {
  const defaultExpandTooltip = isExpanded ? "Hide details" : "View details";

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDownload?.();
  };

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onExpand?.();
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
        {showDownload && (
          downloadOptions && downloadOptions.length > 0 ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{downloadTooltip}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-36">
                {downloadOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.label}
                    onSelect={(event) => {
                      event.preventDefault();
                      option.onSelect();
                    }}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : onDownload ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={handleDownloadClick}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{downloadTooltip}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className="h-7 w-7 flex items-center justify-center text-muted-foreground">
              <Download className="h-4 w-4" />
            </div>
          )
        )}
        {showExpand && (
          onExpand ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-7 w-7 rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-muted",
                    isExpanded ? "bg-primary/10 text-primary" : undefined,
                  )}
                  onClick={handleExpandClick}
                >
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{expandTooltip || defaultExpandTooltip}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className="h-7 w-7 flex items-center justify-center text-muted-foreground">
              <ChevronDown className="h-4 w-4" />
            </div>
          )
        )}
      </div>
    </TooltipProvider>
  );
};

// AnnoTableCard Component
interface AnnoTableCardProps {
  headers: React.ReactNode;
  children: React.ReactNode;
  paginator?: React.ReactNode;
}

export const AnnoTableCard: React.FC<AnnoTableCardProps> = ({
  headers,
  children,
  paginator,
}) => {
  const content = (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="max-h-52 overflow-auto">
        <Table className="min-w-full text-xs">
          <TableHeader className="sticky top-0 z-10">
            {headers}
          </TableHeader>
          <TableBody>
            {children}
          </TableBody>
        </Table>
      </div>
    </div>
  );

  if (paginator) {
    return (
      <div className="space-y-0">
        {content}
        <div className="flex flex-col items-end gap-1.5 pt-1">
          {paginator}
        </div>
      </div>
    );
  }

  return content;
};

// SidebarPagination Component
interface SidebarPaginationProps {
  current: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export const SidebarPagination: React.FC<SidebarPaginationProps> = ({
  current,
  totalPages,
  onPageChange,
  className = "",
}) => {
  const [inputValue, setInputValue] = useState<string | number>(current);

  useEffect(() => {
    setInputValue(current);
  }, [current]);

  const handleJump = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const value = Number(inputValue);
      if (!isNaN(value)) {
        const page = Math.min(Math.max(1, value), totalPages);
        onPageChange(page);
      }
    }
  };

  return (
    <div
      className={`mt-0 flex items-center justify-center gap-2 text-xs text-muted-foreground ${className}`}
    >
      {/* Prev */}
      <button
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-accent/30 transition-colors disabled:opacity-40"
        onClick={() => onPageChange(current - 1)}
        disabled={current === 1}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {/* Page Input */}
      <div className="flex items-center gap-1">
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleJump}
          className="h-6 w-10 rounded border border-border bg-background text-center text-xs outline-none"
        />
        <span>/ {totalPages}</span>
      </div>

      {/* Next */}
      <button
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-accent/30 transition-colors disabled:opacity-40"
        onClick={() => onPageChange(current + 1)}
        disabled={current === totalPages}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
};

// AnnoLayerCard Component
interface AnnoLayerCardProps {
  title: string;
  latestUpdate: string;
  isExpanded: boolean;
  onToggle: () => void;
  onDownload: () => void;
  downloadOptions?: Array<{
    label: string;
    onSelect: () => void | Promise<void>;
  }>;
  children: React.ReactNode;
  downloadTooltip?: string;
  showDownload?: boolean;
}

export const AnnoLayerCard: React.FC<AnnoLayerCardProps> = ({
  title,
  latestUpdate,
  isExpanded,
  onToggle,
  onDownload,
  downloadOptions,
  children,
  downloadTooltip = "Download",
  showDownload = true,
}) => {
  return (
    <div className="rounded-md border border-border/50 bg-card shadow-sm">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-t-md bg-muted/60 px-2.5 py-1.5 text-left transition-colors hover:bg-muted",
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          !isExpanded && "border-b-0",
          isExpanded && "border-b border-border"
        )}
      >
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground truncate">{title}</p>
          <p className="text-[10px] text-muted-foreground">
            Updated: {latestUpdate}
          </p>
        </div>
        <AnnoActionButtons
          onDownload={onDownload}
          downloadOptions={downloadOptions}
          onExpand={onToggle}
          isExpanded={isExpanded}
          downloadTooltip={downloadTooltip}
          showDownload={showDownload}
        />
      </div>
      {isExpanded && (
        <div className="space-y-2 px-2.5 py-2">
          {children}
        </div>
      )}
    </div>
  );
};
