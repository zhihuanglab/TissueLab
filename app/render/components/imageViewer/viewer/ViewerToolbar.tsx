"use client";

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
import { ChevronDown, ChevronUp, Folder, FolderOpen, PictureInPicture2 } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { PresenceAvatars } from "./PresenceAvatar";
import { OverflowItemDef, OverflowToolbarSection } from "./ToolbarOverflowPanel";
import {
  CompassRecommendItem,
  MaskSelectItem,
  OverlayModeItem,
  ToolbarDividerItem,
  ToolbarIconButtonItem,
  overlayUnavailableToast,
} from "./viewerToolbarOverflowItems";

import { toast } from "sonner";
import type { OverlayPendingRequest } from "@/utils/viewer/overlayRequestNotify";
import { getRestrictedAccessMode } from "@/utils/common/pathAccess.utils";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
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
  showBackendAnnotationsRef: React.MutableRefObject<boolean>;

  showPatches: boolean;
  setShowPatches: React.Dispatch<React.SetStateAction<boolean>>;
  keydownUpdatePatches: (prev: boolean, newVal: boolean) => void;
  showPatchesRef: React.MutableRefObject<boolean>;

  pendingRequest: OverlayPendingRequest;
  setPendingRequest: React.Dispatch<React.SetStateAction<OverlayPendingRequest>>;
  socket: WebSocket | null;

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

export default function ViewerToolbar({
  currentTool,
  onToolClick,
  showBackendAnnotations,
  setShowBackendAnnotations,
  keydownUpdate,
  showBackendAnnotationsRef,
  showPatches,
  setShowPatches,
  keydownUpdatePatches,
  showPatchesRef,
  pendingRequest,
  setPendingRequest,
  socket,
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
  const slidePath = useActiveSlidePath();
  const accessMode = getRestrictedAccessMode(slidePath);
  const isViewerShare = accessMode === "viewer";
  const isSamplesReadOnly = accessMode === "samples";

  const maskOptionsWithoutDefault = useMemo(
    () => maskOptions.filter((o) => o.key !== "mask"),
    [maskOptions],
  );

  const tissueClassNames = patchClassificationData?.class_name ?? [];
  const tissueClassColors = patchClassificationData?.class_hex_color ?? [];

  const handleSelectRoiType = useCallback(
    (type: "nuclei" | "tissue") => dispatch(setRoiRecommendType(type)),
    [dispatch],
  );

  const toggleFileBrowser = useCallback(
    () => dispatch(setIsMinimized(!isMinimized)),
    [dispatch, isMinimized],
  );

  // Memoized so overflow measurement ghosts aren't rebuilt every parent render.
  const allOverflowItems: OverflowItemDef[] = useMemo(
    () => [
    // ── Tool group ────────────────────────────────────────────────────────────
    {
        key: "tool-move",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("move"),
          isActive: currentTool === "move",
          tool: "move",
          tooltip: "Move",
          shortcut: bindings["tool.move"],
        },
      },
      {
        key: "tool-lasso",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("lasso"),
          isActive: currentTool === "lasso",
          tool: "lasso",
          tooltip: "Lasso",
          shortcut: bindings["tool.lasso"],
        },
      },
      {
        key: "tool-rectangle",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("rectangle"),
          isActive: currentTool === "rectangle",
          tool: "rectangle",
          tooltip: "Rectangle",
          shortcut: bindings["tool.rectangle"],
        },
      },
      {
        key: "tool-polygon",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("polygon"),
          isActive: currentTool === "polygon",
          tool: "polygon",
          tooltip: "Polygon",
          shortcut: bindings["tool.polygon"],
        },
      },
      {
        key: "tool-line",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("line"),
          isActive: currentTool === "line",
          tool: "line",
          tooltip: "Ruler",
          shortcut: bindings["tool.line"],
        },
      },
      {
        key: "tool-filter",
        Component: ToolbarIconButtonItem,
        props: {
          onClick: () => onToolClick("filter"),
          isActive: currentTool === "filter",
          tool: "filter",
          tooltip: "Filter",
          shortcut: bindings["tool.filter"],
        },
      },
      ...(onGoToRecommended
        ? [
            {
              key: "tool-compass",
              Component: CompassRecommendItem,
              props: {
                roiRecommendType,
                nucleiClasses: nucleiClasses ?? [],
                tissueClassNames,
                tissueClassColors,
                onSelectRoiType: handleSelectRoiType,
                onGoToRecommended,
              },
            },
          ]
        : []),
      // ── Divider: tools → overlays ─────────────────────────────────────────────
      {
        key: "sep-tools-overlays",
        Component: ToolbarDividerItem,
        skipInOverflow: true,
      },
      // ── Overlay group ─────────────────────────────────────────────────────────
      {
        key: "overlay-cell",
        Component: OverlayModeItem,
        props: {
          label: "Cell Overlay",
          isActive: showBackendAnnotations,
          disabled: !nucleiModeAvailable,
          tooltip: nucleiModeAvailable ? "Toggle Nuclei Annotations" : "Currently unavailable",
          shortcut: bindings["toggleNuclei"],
          onClick: () => {
            if (!nucleiModeAvailable) {
              overlayUnavailableToast.nuclei();
              return;
            }
            const prev = showBackendAnnotations;
            const next = !prev;
            showBackendAnnotationsRef.current = next;

            if (pendingRequest.nuclei) {
              if (next) {
                toast("It's loading, please wait...");
                showBackendAnnotationsRef.current = prev;
                return;
              }
              setPendingRequest((p) => ({ ...p, nuclei: false }));
              setShowBackendAnnotations(false);
              keydownUpdate(true, false);
              return;
            }

            if (next && (!socket || socket.readyState !== WebSocket.OPEN)) {
              toast.error(
                "Nuclei overlay requires an open WebSocket connection. Please check your connection and try again.",
              );
              showBackendAnnotationsRef.current = prev;
              return;
            }

            setPendingRequest((p) => ({ ...p, nuclei: next }));
            setShowBackendAnnotations(next);
            keydownUpdate(prev, next);
          },
        },
      },
      {
        key: "overlay-patch",
        Component: OverlayModeItem,
        props: {
          label: "Patch Overlay",
          isActive: showPatches,
          disabled: !patchModeAvailable,
          tooltip: patchModeAvailable ? "Toggle Patch Annotations" : "Currently unavailable",
          shortcut: bindings["togglePatches"],
          onClick: () => {
            if (!patchModeAvailable) {
              overlayUnavailableToast.patch();
              return;
            }
            const prev = showPatches;
            const next = !prev;
            showPatchesRef.current = next;

            if (pendingRequest.patches) {
              if (next) {
                toast("It's loading, please wait...");
                showPatchesRef.current = prev;
                return;
              }
              setPendingRequest((p) => ({ ...p, patches: false }));
              setShowPatches(false);
              keydownUpdatePatches(true, false);
              return;
            }

            if (next && (!socket || socket.readyState !== WebSocket.OPEN)) {
              toast.error(
                "Patch overlay requires an open WebSocket connection. Please check your connection and try again.",
              );
              showPatchesRef.current = prev;
              return;
            }

            setPendingRequest((p) => ({ ...p, patches: next }));
            setShowPatches(next);
            keydownUpdatePatches(prev, next);
          },
        },
      },
      {
        key: "overlay-mask",
        Component: OverlayModeItem,
        props: {
          label: "Tissue Overlay",
          isActive: showMask,
          disabled: !maskModeAvailable,
          tooltip: maskModeAvailable ? "Toggle Tissue Segmentation Overlay" : "Currently unavailable",
          shortcut: bindings["toggleMask"],
          onClick: () => {
            if (!maskModeAvailable) {
              overlayUnavailableToast.mask();
              return;
            }
            setShowMask(!showMask);
          },
        },
      },
      ...(maskOptionsWithoutDefault.length > 0
        ? [
            {
              key: "overlay-mask-select",
              Component: MaskSelectItem,
              props: {
                options: maskOptionsWithoutDefault,
                selectedMaskKey,
                onSelectMaskKey,
              },
            },
          ]
        : []),
    ],
    [
      bindings,
      currentTool,
      handleSelectRoiType,
      keydownUpdate,
      keydownUpdatePatches,
      maskModeAvailable,
      maskOptionsWithoutDefault,
      nucleiClasses,
      nucleiModeAvailable,
      onGoToRecommended,
      onSelectMaskKey,
      onToolClick,
      patchModeAvailable,
      pendingRequest,
      roiRecommendType,
      selectedMaskKey,
      setPendingRequest,
      setShowBackendAnnotations,
      setShowMask,
      setShowPatches,
      showBackendAnnotations,
      showBackendAnnotationsRef,
      showMask,
      showPatches,
      showPatchesRef,
      socket,
      tissueClassColors,
      tissueClassNames,
    ],
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex w-full min-w-0 min-h-10 items-center gap-3 overflow-visible border-l border-border/60 bg-muted px-4 pb-1.5 pt-2.5">
        {/* Files button — always visible, left anchor */}
        <div className="flex shrink-0 items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleFileBrowser}
                className={`relative z-0 flex items-center rounded-[4px] px-1 py-1 transition-colors hover:bg-foreground/10 hover:text-foreground ${
                  !isMinimized ? "bg-foreground/10 text-foreground" : "text-muted-foreground"
                }`}
              >
                {isMinimized ? (
                  <Folder className="h-5 w-5" strokeWidth={1.5} />
                ) : (
                  <FolderOpen className="h-5 w-5" strokeWidth={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">File Browser</TooltipContent>
          </Tooltip>
          <ToolbarDivider />
        </div>

        {/*
          Overflowable toolbar items (tools, overlays). Presence avatars are
          fixed on the right — they do not participate in overflow layout.
        */}
        <OverflowToolbarSection
          items={allOverflowItems}
          className="flex-1 min-w-0"
        />

        <div className="flex shrink-0 items-center gap-3">
          {isViewerShare ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex shrink-0 items-center rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium tracking-wide text-sky-700 dark:text-sky-300"
                  aria-label="Viewer"
                >
                  Viewer
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Shared with you as Viewer. You can see this slide and overlays, but cannot annotate or run workflows.
              </TooltipContent>
            </Tooltip>
          ) : isSamplesReadOnly ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex shrink-0 items-center rounded border border-muted-foreground/30 bg-muted/60 px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground"
                  aria-label="Read-only"
                >
                  Read-only
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Public Samples folder. Browse freely, but annotate and workflows require a copy in your Personal workspace.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {onlineUsers.length > 0 && (
            <>
              <PresenceAvatars users={onlineUsers} />
              <ToolbarDivider />
            </>
          )}

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
      </div>
    </TooltipProvider>
  );
}
