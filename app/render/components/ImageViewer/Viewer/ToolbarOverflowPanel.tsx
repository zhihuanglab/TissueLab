"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoreVertical } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface OverflowItemDef {
  key: string;
  render: () => React.ReactNode;
  /**
   * Dividers / separators: included in width measurement but NOT shown in the
   * overflow panel. Trailing visible separators are also trimmed automatically.
   */
  skipInOverflow?: boolean;
  /**
   * Flexible spacer: renders as flex-1, consumes zero width in budget
   * calculation, and is NEVER moved to overflow — it stays visible so the
   * items after it remain right-aligned.
   */
  isSpacer?: boolean;
}

const GAP = 12; // gap-3 = 12px, must match the gap-3 class on the visible-items div
const MORE_BTN_WIDTH = 28; // p-1.5 (6px×2) + 16px icon

/**
 * A toolbar section that moves rightmost items into a floating overflow panel
 * when the container is too narrow.  The "…" trigger is always right-aligned
 * (pushed by a flex spacer) so it sits flush against whatever follows the
 * section in the parent layout — typically the Navigator button.
 *
 * The overflow panel is rendered via a portal directly into document.body so it
 * is never clipped by ancestor overflow or stacking-context constraints.
 */
export function OverflowToolbarSection({
  items,
  className = "",
  onOverflowChange,
}: {
  items: OverflowItemDef[];
  className?: string;
  /** Called whenever overflow state changes, so parent can react (e.g. hide adjacent divider) */
  onOverflowChange?: (hasOverflow: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Keep a stable ref so recalculate doesn't need items in its dep array
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [visibleCount, setVisibleCount] = useState(items.length);
  const [panelOpen, setPanelOpen] = useState(false);
  // Panel position derived from the "…" button's bounding rect
  const [panelPos, setPanelPos] = useState<{ top: number; right: number; maxWidth: number } | null>(null);

  const recalculate = useCallback(() => {
    const container = containerRef.current;
    const ghost = ghostRef.current;
    if (!container || !ghost) return;

    const containerWidth = container.clientWidth;
    const ghostChildren = Array.from(ghost.children) as HTMLElement[];
    const n = ghostChildren.length;
    if (n === 0) return;

    const totalAllWidth = ghostChildren.reduce(
      (sum, el, i) => sum + el.offsetWidth + (i > 0 ? GAP : 0),
      0,
    );

    if (totalAllWidth <= containerWidth) {
      setVisibleCount(n);
      return;
    }

    // Reserve space for "…" button (plus a minimum gap so it doesn't crowd items)
    const budget = containerWidth - MORE_BTN_WIDTH - GAP;
    let usedWidth = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const item = itemsRef.current[i];
      if (item?.isSpacer) {
        // Spacers consume no width but are always kept in the visible set
        count++;
        continue;
      }
      const w = ghostChildren[i].offsetWidth;
      const gapBefore = count > 0 ? GAP : 0;
      if (usedWidth + gapBefore + w <= budget) {
        usedWidth += gapBefore + w;
        count++;
      } else {
        break;
      }
    }

    // Don't leave a trailing separator as the last visible item (spacers are exempt)
    while (count > 0 && itemsRef.current[count - 1]?.skipInOverflow && !itemsRef.current[count - 1]?.isSpacer) {
      count--;
    }

    setVisibleCount(count);
  }, []); // stable — reads items via itemsRef

  // Re-run when item count changes (e.g. conditional items appear/disappear)
  useLayoutEffect(() => {
    recalculate();
  }, [items.length, recalculate]);

  // Watch container size changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(recalculate);
    ro.observe(container);
    return () => ro.disconnect();
  }, [recalculate]);

  // Compute panel position from the "…" button whenever the panel opens
  useEffect(() => {
    if (!panelOpen) return;
    const btn = moreButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      // Panel extends leftward from the button; cap it so it never bleeds off screen
      maxWidth: rect.right - 8,
    });
  }, [panelOpen]);

  // Close panel on outside click (Radix portals are excluded)
  useEffect(() => {
    if (!panelOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideRadixPortal = !!(target as Element)?.closest(
        "[data-radix-popper-content-wrapper]",
      );
      if (
        panelRef.current?.contains(target) ||
        moreButtonRef.current?.contains(target) ||
        insideRadixPortal
      )
        return;
      setPanelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [panelOpen]);

  const overflowItems = items.slice(visibleCount).filter((item) => !item.skipInOverflow && !item.isSpacer);
  const showMoreButton = overflowItems.length > 0;

  // Notify parent when overflow state changes (e.g. to hide the adjacent divider)
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;
  useEffect(() => {
    onOverflowChangeRef.current?.(showMoreButton);
  }, [showMoreButton]);

  return (
    <div
      ref={containerRef}
      className={`relative flex min-h-0 min-w-0 items-center overflow-visible ${className}`}
    >
      {/* Off-screen ghost — renders every item so we can measure intrinsic widths.
          Spacers are suppressed here (they are flex-1 and have no intrinsic width). */}
      <div
        ref={ghostRef}
        className="fixed flex pointer-events-none"
        style={{ top: -9999, left: -9999, visibility: "hidden" }}
        aria-hidden="true"
      >
        {items.map((item) => (
          <div key={item.key} style={{ flexShrink: 0 }}>
            {item.isSpacer ? null : item.render()}
          </div>
        ))}
      </div>

      {/* Visible items — flex-1 so internal spacer items (flex-1) can expand.
          Non-spacer items get shrink-0 so they can't be compressed when flex
          runs out of space (guards against residual measurement drift). */}
      <div className="flex flex-1 items-center gap-3 min-w-0">
        {items.slice(0, visibleCount).map((item) =>
          item.isSpacer ? (
            <React.Fragment key={item.key}>{item.render()}</React.Fragment>
          ) : (
            <div key={item.key} className="shrink-0">
              {item.render()}
            </div>
          )
        )}
      </div>

      {/* "…" overflow trigger — always right-aligned, hidden when nothing overflows */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            style={{ display: showMoreButton ? undefined : "none" }}
            className="flex shrink-0 items-center justify-center p-1.5 rounded-[4px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors border-none outline-none"
            aria-label="More toolbar options"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">More</TooltipContent>
      </Tooltip>

      {/* Overflow panel — portaled to document.body so it is never clipped by
          ancestor overflow or stacking contexts. Position is fixed, derived from
          the "…" button's bounding rect. */}
      {panelOpen && showMoreButton && panelPos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: panelPos.top, right: panelPos.right, maxWidth: panelPos.maxWidth, zIndex: 9999 }}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted px-2 py-1.5 shadow-md"
          >
            {overflowItems.map((item) => (
              <React.Fragment key={item.key}>{item.render()}</React.Fragment>
            ))}
          </div>,
          document.body,
        )
      }
    </div>
  );
}
