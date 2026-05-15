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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PresenceUser } from "@/hooks/viewer/usePresence";
import { useShortcuts } from '@/hooks/viewer/useShortcuts';
import { useViewerSettings } from '@/hooks/viewer/useViewerSettings';
import { RootState } from '@/store';
import { setIsMinimized } from '@/store/slices/fileManagerSlice';
import { setRoiRecommendType } from '@/store/slices/viewer/viewerSettingsSlice';
import { ChevronDown, ChevronUp, Compass, Filter, Folder, FolderOpen, PictureInPicture2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { FiMove } from "react-icons/fi";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { LuRuler } from "react-icons/lu";
import { PiRectangle } from "react-icons/pi";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "sonner";
import { PresenceAvatars } from "./PresenceAvatar";
import { OverflowItemDef, OverflowToolbarSection } from "./ToolbarOverflowPanel";

/** Vertical rule between toolbar groups — wider stroke, higher contrast. */
function ToolbarDivider() {
  return (
    <div
      className="h-4 w-px shrink-0 rounded-full bg-muted-foreground/45 "
      aria-hidden
    />
  );
}

interface ViewerToolbarProps {
  currentTool: string;
  onToolClick: (tool: string | undefined) => void;

  showBackendAnnotations: boolean;
  setShowBackendAnnotations: React.Dispatch<React.SetStateAction<boolean>>;
  keydownUpdate: (prev: boolean, newVal: boolean) => void;

  showPatches: boolean;
  setShowPatches: React.Dispatch<React.SetStateAction<boolean>>;
  keydownUpdatePatches: (prev: boolean, newVal: boolean) => void;

  showMask: boolean;
  setShowMask: React.Dispatch<React.SetStateAction<boolean>>;
  maskOptions?: { key: string; label: string }[];
  selectedMaskKey?: string;
  onSelectMaskKey?: (key: string) => void;

  nucleiModeAvailable?: boolean;
  patchModeAvailable?: boolean;
  maskModeAvailable?: boolean;

  onGoToRecommended?: (roiType: 'nuclei' | 'tissue', targetClass: number) => void | Promise<void>;

  onlineUsers?: PresenceUser[];
}

interface ModeButtonProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
  tooltip: string;
  shortcut?: string;
}

function ModeButton({
  label,
  isActive,
  onClick,
  disabled = false,
  tooltip,
  shortcut,
}: ModeButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={`flex items-center justify-center px-2 py-1 rounded-[4px] transition-colors relative z-0 border-none outline-none w-[86px] ${
            isActive
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          } ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
        >
          <span
            className={`text-xs font-sm whitespace-nowrap ${isActive ? "font-medium" : ""}`}
          >
            {label}
          </span>
          {shortcut && (
            <span className="absolute -top-1.5 -right-1 z-[100] rounded min-w-[16px] h-[12px] px-1 flex items-center justify-center font-semibold text-[10px] pointer-events-none shadow-sm leading-tight border-none bg-muted-foreground/20 text-muted-foreground">
              {shortcut}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export default function ViewerToolbar({
  currentTool,
  onToolClick,
  showBackendAnnotations,
  setShowBackendAnnotations,
  keydownUpdate,
  showPatches,
  setShowPatches,
  keydownUpdatePatches,
  showMask,
  setShowMask,
  maskOptions = [],
  selectedMaskKey = '',
  onSelectMaskKey,
  nucleiModeAvailable = true,
  patchModeAvailable = true,
  maskModeAvailable = true,
  onGoToRecommended,
  onlineUsers = [],
}: ViewerToolbarProps) {
  const { bindings } = useShortcuts();
  const { showNavigator, toggleShowNavigator } = useViewerSettings();
  const dispatch = useDispatch();
  const isMinimized = useSelector(
    (state: RootState) => state.fileManager.isMinimized,
  );
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const patchClassificationData = useSelector((state: RootState) => state.annotations.patchClassificationData);
  const roiRecommendType = useSelector((state: RootState) => state.viewerSettings.roiRecommendType);

  const [toolbarHasOverflow, setToolbarHasOverflow] = useState(false);

  const maskOptionsWithoutDefault = useMemo(
    () => maskOptions.filter((o) => o.key !== "mask"),
    [maskOptions],
  );

  const toggleFileBrowser = () => {
    dispatch(setIsMinimized(!isMinimized));
  };

  const renderIconButton = (
    onClick: () => void,
    isActive: boolean,
    icon: React.ReactNode,
    tooltip: string,
    shortcut?: string,
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={`flex items-center px-1 py-1 rounded-[4px] transition-colors hover:bg-foreground/10 hover:text-foreground relative z-0 ${
            isActive ? "bg-foreground/10 text-foreground" : "text-muted-foreground"
          }`}
        >
          {icon}
          {shortcut && (
            <span className="absolute -top-1 -right-2 z-[100] rounded min-w-[16px] h-[12px] px-1 flex items-center justify-center font-semibold text-[10px] pointer-events-none shadow-sm leading-tight bg-muted-foreground/20 text-muted-foreground">
              {shortcut.length > 5 ? shortcut.slice(0, 4) + ".." : shortcut}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );

  // All items that can overflow — ordered left-to-right; rightmost items overflow first.
  // Dividers use skipInOverflow: true so they don't appear inside the overflow panel
  // and trailing dividers are trimmed automatically.
  const allOverflowItems: OverflowItemDef[] = [
    // ── Tool group ────────────────────────────────────────────────────────────
    {
      key: "tool-move",
      render: () => renderIconButton(() => onToolClick("move"), currentTool === "move", <FiMove size={20} strokeWidth={1.5} />, "Move", bindings["tool.move"]),
    },
    {
      key: "tool-polygon",
      render: () => renderIconButton(() => onToolClick("polygon"), currentTool === "polygon", <LiaDrawPolygonSolid size={20} />, "Polygon", bindings["tool.polygon"]),
    },
    {
      key: "tool-rectangle",
      render: () => renderIconButton(() => onToolClick("rectangle"), currentTool === "rectangle", <PiRectangle size={20} />, "Rectangle", bindings["tool.rectangle"]),
    },
    {
      key: "tool-line",
      render: () => renderIconButton(() => onToolClick("line"), currentTool === "line", <LuRuler size={20} />, "Ruler", bindings["tool.line"]),
    },
    {
      key: "tool-filter",
      render: () => renderIconButton(() => onToolClick("filter"), currentTool === "filter", <Filter size={20} strokeWidth={1.5} />, "Filter", bindings["tool.filter"]),
    },
    ...(onGoToRecommended
      ? [
          {
            key: "tool-compass",
            render: () => (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex items-center px-1 py-1 rounded-[4px] transition-colors hover:bg-foreground/10 hover:text-foreground text-muted-foreground"
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
                  <DropdownMenuLabel className="cursor-default text-muted-foreground font-normal">
                    ROIs
                  </DropdownMenuLabel>
                  <div className="flex gap-0.5 p-1.5 pb-2 border-b border-border/60">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); dispatch(setRoiRecommendType("nuclei")); }}
                      className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${roiRecommendType === "nuclei" ? "bg-foreground/15 text-foreground" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"}`}
                    >
                      Nuclei
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); dispatch(setRoiRecommendType("tissue")); }}
                      className={`flex-1 px-2 py-1 rounded text-xs font-medium transition-colors ${roiRecommendType === "tissue" ? "bg-foreground/15 text-foreground" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"}`}
                    >
                      Tissue
                    </button>
                  </div>
                  {roiRecommendType === "nuclei" ? (
                    nucleiClasses?.length > 0 ? (
                      nucleiClasses.map((c, index) => (
                        <DropdownMenuItem
                          key={`nuclei-${index}`}
                          onSelect={(e) => { e.preventDefault(); onGoToRecommended("nuclei", index); }}
                          className="flex items-center gap-2"
                        >
                          <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                          <span className="truncate">{c.name}</span>
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <div className="px-2 py-2 text-xs text-muted-foreground">No nuclei classes</div>
                    )
                  ) : patchClassificationData?.class_name?.length ? (
                    patchClassificationData.class_name.map((name, index) => (
                      <DropdownMenuItem
                        key={`tissue-${index}`}
                        onSelect={(e) => { e.preventDefault(); onGoToRecommended("tissue", index); }}
                        className="flex items-center gap-2"
                      >
                        <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: patchClassificationData.class_hex_color?.[index] ?? "#888" }} />
                        <span className="truncate">{name}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No tissue classes</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          } satisfies OverflowItemDef,
        ]
      : []),

    // ── Divider: tools → overlays ─────────────────────────────────────────────
    { key: "sep-tools-overlays", render: () => <ToolbarDivider />, skipInOverflow: true },

    // ── Overlay group ─────────────────────────────────────────────────────────
    {
      key: "overlay-cell",
      render: () => (
        <ModeButton
          label="Cell Overlay"
          isActive={showBackendAnnotations}
          disabled={!nucleiModeAvailable}
          tooltip={nucleiModeAvailable ? "Toggle Nuclei Annotations" : "Currently unavailable"}
          shortcut={bindings["toggleNuclei"]}
          onClick={() => {
            if (!nucleiModeAvailable) {
              toast("Nuclei mode is unavailable for this image.");
              return;
            }
            const prev = showBackendAnnotations;
            const next = !prev;
            setShowBackendAnnotations(next);
            keydownUpdate(prev, next);
          }}
        />
      ),
    },
    {
      key: "overlay-patch",
      render: () => (
        <ModeButton
          label="Patch Overlay"
          isActive={showPatches}
          disabled={!patchModeAvailable}
          tooltip={patchModeAvailable ? "Toggle Patch Annotations" : "Currently unavailable"}
          shortcut={bindings["togglePatches"]}
          onClick={() => {
            if (!patchModeAvailable) {
              toast("Patch mode is unavailable for this image.");
              return;
            }
            const prev = showPatches;
            const next = !prev;
            setShowPatches(next);
            keydownUpdatePatches(prev, next);
          }}
        />
      ),
    },
    {
      key: "overlay-mask",
      render: () => (
        <ModeButton
          label="Mask Overlay"
          isActive={showMask}
          disabled={!maskModeAvailable}
          tooltip={maskModeAvailable ? "Toggle Segmentation Mask Overlay" : "Currently unavailable"}
          shortcut={bindings["toggleMask"]}
          onClick={() => {
            if (!maskModeAvailable) {
              toast("Mask overlay is unavailable for this image.");
              return;
            }
            setShowMask(!showMask);
          }}
        />
      ),
    },
    ...(maskOptionsWithoutDefault.length > 0
      ? [
          {
            key: "overlay-mask-select",
            render: () => (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex min-w-0">
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex items-center justify-center px-1.5 py-1 rounded-[4px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors border-none outline-none min-w-0"
                          aria-label="Select mask"
                        >
                          <span className="text-xs truncate max-w-[72px]">
                            {maskOptionsWithoutDefault.find((o) => o.key === selectedMaskKey)?.label
                              ?? (selectedMaskKey === "" || selectedMaskKey === "mask"
                                ? "Mask"
                                : maskOptionsWithoutDefault[0]?.label ?? "Mask")}
                          </span>
                          <ChevronDown className="h-3 w-3 ml-0.5 shrink-0" />
                        </button>
                      </DropdownMenuTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Select which mask to show</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" side="bottom" className="w-[180px] p-1">
                  {maskOptionsWithoutDefault.map((opt) => (
                    <DropdownMenuItem
                      key={opt.key}
                      className="pl-4 pr-2 py-1.5"
                      onSelect={(e) => { e.preventDefault(); onSelectMaskKey?.(opt.key); }}
                    >
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 mr-2 ${
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
            ),
          } satisfies OverflowItemDef,
        ]
      : []),

    // ── Spacer + presence / user slots (conditional) ──────────────────────────
    // The spacer is always visible and flex-1 so presence stays right-aligned.
    // No divider between overlays and presence — the spacer provides the separation.
    {
      key: "spacer-overlays-presence",
      isSpacer: true,
      skipInOverflow: true,
      render: () => <div className="flex-1 min-w-0" />,
    } satisfies OverflowItemDef,
    ...(onlineUsers?.length
      ? [
          {
            key: "presence",
            render: () => (
              <div className="flex h-6 items-center">
                <PresenceAvatars users={onlineUsers} />
              </div>
            ),
          } satisfies OverflowItemDef,
        ]
      : []),
  ];

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex w-full min-w-0 min-h-10 items-center gap-3 overflow-visible border-l border-border/60 bg-muted px-4 py-1.5">

        {/* Files button — always visible, left anchor */}
        <div className="flex shrink-0 items-center">
          {renderIconButton(
            toggleFileBrowser,
            !isMinimized,
            isMinimized ? <Folder className="h-5 w-5" strokeWidth={1.5} /> : <FolderOpen className="h-5 w-5" strokeWidth={1.5} />,
            "File Browser",
          )}
        </div>

        <ToolbarDivider />

        {/*
          All overflowable items (tools, overlays, presence) in a single section.
          flex-1 + min-w-0 gives it all remaining space.
          The "…" button lives at the right edge of this section (via internal spacer),
          so it naturally sits flush against the Navigator button below.
        */}
        <OverflowToolbarSection
          items={allOverflowItems}
          className="flex-1 min-w-0"
          onOverflowChange={setToolbarHasOverflow}
        />

        {!toolbarHasOverflow && <ToolbarDivider />}

        {/* Navigator — always visible, right anchor */}
        <button
          type="button"
          onClick={toggleShowNavigator}
          className="flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <div className="flex items-center gap-0.5 rounded-[4px] p-1 hover:bg-foreground/10">
            <PictureInPicture2 className="h-4 w-4 text-muted-foreground" />
            {showNavigator ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </div>
        </button>

      </div>
    </TooltipProvider>
  );
}
