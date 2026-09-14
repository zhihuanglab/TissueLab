"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Compass, ChevronDown, Filter, Lasso } from "lucide-react";
import React from "react";
import { FiMove } from "react-icons/fi";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { LuRuler } from "react-icons/lu";
import { PiRectangle } from "react-icons/pi";
import { toast } from "sonner";

/** Toolbar badge label — compact names for special keys. */
export function formatShortcutBadge(shortcut: string): string {
  if (shortcut === "Escape") return "Esc";
  if (shortcut.length > 5) return `${shortcut.slice(0, 4)}..`;
  return shortcut;
}

export function ToolbarDividerItem() {
  return (
    <div
      className="h-4 w-px shrink-0 rounded-full bg-muted-foreground/45"
      aria-hidden
    />
  );
}

export interface ToolbarIconButtonItemProps {
  onClick: () => void;
  isActive: boolean;
  tool: "move" | "lasso" | "rectangle" | "polygon" | "line" | "filter";
  tooltip: string;
  shortcut?: string;
}

const TOOL_ICONS: Record<ToolbarIconButtonItemProps["tool"], React.ReactNode> = {
  move: <FiMove size={20} strokeWidth={1.5} />,
  lasso: <Lasso size={20} strokeWidth={1.5} />,
  rectangle: <PiRectangle size={20} />,
  polygon: <LiaDrawPolygonSolid size={20} />,
  line: <LuRuler size={20} />,
  filter: <Filter size={20} strokeWidth={1.5} />,
};

export const ToolbarIconButtonItem = React.memo(function ToolbarIconButtonItem({
  onClick,
  isActive,
  tool,
  tooltip,
  shortcut,
}: ToolbarIconButtonItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={`relative z-0 flex items-center rounded-[4px] px-1 py-1 transition-colors hover:bg-foreground/10 hover:text-foreground ${
            isActive ? "bg-foreground/10 text-foreground" : "text-muted-foreground"
          }`}
        >
          {TOOL_ICONS[tool]}
          {shortcut && (
            <span className="pointer-events-none absolute -top-1 -right-2 z-[100] flex h-[12px] min-w-[16px] items-center justify-center rounded border-none bg-muted-foreground/20 px-1 text-[10px] font-semibold leading-tight text-muted-foreground shadow-sm">
              {formatShortcutBadge(shortcut)}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});

export interface OverlayModeItemProps {
  label: string;
  isActive: boolean;
  disabled: boolean;
  tooltip: string;
  shortcut?: string;
  onClick: () => void;
}

export const OverlayModeItem = React.memo(function OverlayModeItem({
  label,
  isActive,
  disabled,
  tooltip,
  shortcut,
  onClick,
}: OverlayModeItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={`relative z-0 flex w-[86px] items-center justify-center rounded-[4px] border-none px-2 py-1 outline-none transition-colors ${
            isActive
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          } ${disabled ? "cursor-not-allowed opacity-30" : ""}`}
        >
          <span
            className={`whitespace-nowrap text-xs font-sm ${isActive ? "font-medium" : ""}`}
          >
            {label}
          </span>
          {shortcut && (
            <span className="pointer-events-none absolute -top-1.5 -right-1 z-[100] flex h-[12px] min-w-[16px] items-center justify-center rounded border-none bg-muted-foreground/20 px-1 text-[10px] font-semibold leading-tight text-muted-foreground shadow-sm">
              {formatShortcutBadge(shortcut)}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});

export interface CompassRecommendItemProps {
  roiRecommendType: "nuclei" | "tissue";
  nucleiClasses: Array<{ name: string; color: string }>;
  tissueClassNames: string[];
  tissueClassColors: string[];
  onSelectRoiType: (type: "nuclei" | "tissue") => void;
  onGoToRecommended: (roiType: "nuclei" | "tissue", targetClass: number) => void;
}

export const CompassRecommendItem = React.memo(function CompassRecommendItem({
  roiRecommendType,
  nucleiClasses,
  tissueClassNames,
  tissueClassColors,
  onSelectRoiType,
  onGoToRecommended,
}: CompassRecommendItemProps) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center rounded-[4px] px-1 py-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="Go to recommended region"
              >
                <Compass size={20} strokeWidth={1.5} />
              </button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Go to recommended</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="center" side="bottom" className="min-w-[200px]">
        <DropdownMenuLabel className="cursor-default font-normal text-muted-foreground">
          ROIs
        </DropdownMenuLabel>
        <div className="flex gap-0.5 border-b border-border/60 p-1.5 pb-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectRoiType("nuclei");
            }}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              roiRecommendType === "nuclei"
                ? "bg-foreground/15 text-foreground"
                : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            }`}
          >
            Nuclei
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectRoiType("tissue");
            }}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              roiRecommendType === "tissue"
                ? "bg-foreground/15 text-foreground"
                : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            }`}
          >
            Tissue
          </button>
        </div>
        {roiRecommendType === "nuclei" ? (
          nucleiClasses.length > 0 ? (
            nucleiClasses.map((c, index) => (
              <DropdownMenuItem
                key={`nuclei-${index}`}
                onSelect={(e) => {
                  e.preventDefault();
                  onGoToRecommended("nuclei", index);
                }}
                className="flex items-center gap-2"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                <span className="truncate">{c.name}</span>
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">No nuclei classes</div>
          )
        ) : tissueClassNames.length > 0 ? (
          tissueClassNames.map((name, index) => (
            <DropdownMenuItem
              key={`tissue-${index}`}
              onSelect={(e) => {
                e.preventDefault();
                onGoToRecommended("tissue", index);
              }}
              className="flex items-center gap-2"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: tissueClassColors[index] ?? "#888" }}
              />
              <span className="truncate">{name}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <div className="px-2 py-2 text-xs text-muted-foreground">No tissue classes</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export interface MaskSelectItemProps {
  options: Array<{ key: string; label: string }>;
  selectedMaskKey: string;
  onSelectMaskKey?: (key: string) => void;
}

export const MaskSelectItem = React.memo(function MaskSelectItem({
  options,
  selectedMaskKey,
  onSelectMaskKey,
}: MaskSelectItemProps) {
  const label =
    options.find((o) => o.key === selectedMaskKey)?.label ??
    (selectedMaskKey === "" || selectedMaskKey === "mask"
      ? "Tissue"
      : options[0]?.label ?? "Tissue");

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 items-center justify-center rounded-[4px] border-none px-1.5 py-1 text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="Select tissue"
              >
                <span className="max-w-[72px] truncate text-xs">{label}</span>
                <ChevronDown className="ml-0.5 h-3 w-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Select which tissue to show</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="w-[180px] p-1">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.key}
            className="py-1.5 pl-4 pr-2"
            onSelect={(e) => {
              e.preventDefault();
              onSelectMaskKey?.(opt.key);
            }}
          >
            <span
              className={`mr-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                selectedMaskKey === opt.key ? "bg-primary" : "bg-transparent"
              }`}
              aria-hidden
            />
            <span className={selectedMaskKey === opt.key ? "font-medium" : ""}>
              {opt.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Stable toast helpers referenced from memoized overlay items. */
export const overlayUnavailableToast = {
  nuclei: () => toast("Nuclei mode is unavailable for this image."),
  patch: () => toast("Patch mode is unavailable for this image."),
  mask: () => toast("Tissue overlay is unavailable for this image."),
};
