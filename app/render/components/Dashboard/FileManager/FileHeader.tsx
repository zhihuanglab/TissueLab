"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/twMerge";
import {
  ChevronLeft,
  Eye,
  EyeOff,
  Grid2x2,
  List,
  RefreshCw,
} from "lucide-react";
import { ExpandableSearch } from "../../ui/ExpandableSearch";

interface Props {
  title?: string;
  viewMode: "tree" | "table";
  setViewMode: (m: "tree" | "table") => void;

  showNonImageFiles: boolean;
  setShowNonImageFiles: (b: boolean) => void;

  onRefresh: () => void;
  onNewFolder: () => void;
  onOpenFolder?: () => void;
  onGoUp?: () => void;

  canGoUp: boolean;
  breadcrumb?: React.ReactNode;

  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  onClearSearch?: () => void;
  searchDisabled?: boolean;

  showViewToggle?: boolean;
  showNonImageToggle?: boolean;
  showNewFolder?: boolean;
  showOpenFolder?: boolean;
  showRefresh?: boolean;

  disableNewFolder?: boolean;
  disableRefresh?: boolean;
  disableOpenFolder?: boolean;

  extraActions?: React.ReactNode;
}

export function FileHeader({
  title = "Local File Manager",
  viewMode,
  setViewMode,
  showNonImageFiles,
  setShowNonImageFiles,
  onRefresh,
  onNewFolder,
  onOpenFolder,
  onGoUp,
  canGoUp,
  breadcrumb,
  searchPlaceholder = "Search",
  searchValue = "",
  onSearchChange,
  onClearSearch,
  searchDisabled = true,
  showViewToggle = true,
  showNonImageToggle = true,
  showNewFolder = true,
  showOpenFolder = true,
  showRefresh = true,
  disableNewFolder = false,
  disableRefresh = false,
  disableOpenFolder = false,
  extraActions,
}: Props) {

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <div className="flex flex-col gap-4 pb-0 pt-2">
        {/* ─── Title + Actions ───────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold text-foreground">
            {title}
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {showNewFolder && (
              <Button
                variant="outline"
                size="sm"
                onClick={onNewFolder}
                disabled={disableNewFolder}
                className="h-9 w-28 px-4 text-sm"
              >
                New Folder
              </Button>
            )}

            {showOpenFolder && onOpenFolder && (
              <Button
                onClick={onOpenFolder}
                disabled={disableOpenFolder}
                className="h-9 w-28 px-3 text-sm"
              >
                Open Folder
              </Button>
            )}

            {extraActions}
          </div>
        </div>

        {/* ─── Breadcrumb + Back + Search ───────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!canGoUp}
                onClick={onGoUp}
                aria-label="Go up"
                className="h-7 w-7 rounded-[6px] border border-border px-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Go Up
            </TooltipContent>
          </Tooltip>

          {breadcrumb}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {showRefresh && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onRefresh}
                aria-label="Refresh"
                disabled={disableRefresh}
                className="h-9 w-9 rounded-[6px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <RefreshCw className={cn("h-4 w-4", disableRefresh && "animate-spin")} />
              </Button>
            )}

            {showViewToggle && (
              <div className="flex h-9 items-center gap-0.5 rounded-[6px] border border-border bg-card px-[3px]">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode("tree")}
                      aria-label="List view"
                      className={cn(
                        "h-7 w-7 rounded-[4px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                        viewMode === "tree" && "bg-foreground/10 text-foreground"
                      )}
                    >
                      <List className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    List View
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode("table")}
                      aria-label="Table view"
                      className={cn(
                        "h-7 w-7 rounded-[4px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                        viewMode === "table" && "bg-foreground/10 text-foreground"
                      )}
                    >
                      <Grid2x2 className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Table View
                  </TooltipContent>
                </Tooltip>

                {showNonImageToggle && (
                  <>
                    <div className="mx-1 h-5 w-px bg-border" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Toggle non-image files"
                          onClick={() => setShowNonImageFiles(!showNonImageFiles)}
                          className={cn(
                            "h-7 w-7 rounded-[4px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
                            showNonImageFiles && "bg-foreground/10 text-foreground"
                          )}
                        >
                          {showNonImageFiles ? (
                            <Eye className="h-3 w-3" />
                          ) : (
                            <EyeOff className="h-3 w-3" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        Toggle Non-Image Files
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            )}

            {onSearchChange && (
              <ExpandableSearch
                value={searchValue || ""}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                disabled={searchDisabled}
                onClear={onClearSearch}
              />
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
