"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/utils/twMerge";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ExpandableSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onClear?: () => void;
}

export function ExpandableSearch({
  value,
  onChange,
  placeholder = "Search...",
  disabled = false,
  onClear,
}: ExpandableSearchProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Expand when clicked
  const handleExpand = () => {
    if (disabled) return;
    setIsExpanded(true);
  };

  // Collapse when clicking outside or pressing Escape
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsExpanded(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsExpanded(false);
        if (inputRef.current) {
          inputRef.current.blur();
        }
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isExpanded]);

  // Focus input when expanded
  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  const handleClear = () => {
    onChange("");
    onClear?.();
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative overflow-hidden transition-all duration-300 ease-in-out",
        isExpanded ? "flex-1 min-w-[240px] max-w-full" : "w-9 h-9 flex-shrink-0"
      )}
    >
      {!isExpanded ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleExpand}
          disabled={disabled}
          className="h-9 w-9 rounded-[6px] border border-border bg-card px-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </Button>
      ) : (
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            disabled={disabled}
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={`h-9 rounded-[6px] border-border bg-card pl-9 pr-9 text-sm shadow-none placeholder:text-muted-foreground/40
              focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0`}
          />
          {value && onClear && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClear}
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

