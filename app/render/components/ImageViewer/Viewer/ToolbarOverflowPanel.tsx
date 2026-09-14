"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoreVertical } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  computeToolbarLayout,
  TOOLBAR_GAP,
  TOOLBAR_MORE_BTN_WIDTH,
  type ToolbarItemMeta,
} from "./toolbarOverflowLayout";

/** Props bag passed to overflow item components. */
export type OverflowItemProps = Record<string, unknown>;

export interface OverflowItemDef {
  key: string;
  Component: React.ElementType;
  props?: OverflowItemProps;
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

const GAP = TOOLBAR_GAP; // gap-3 = 12px, must match the gap-3 class on the visible-items div
export { GAP as TOOLBAR_SECTION_GAP };
const FALLBACK_MORE_BTN_WIDTH = TOOLBAR_MORE_BTN_WIDTH;

interface ComputedLayout {
  visibleCount: number;
  hasOverflow: boolean;
}

/** Renders a memoized overflow item — shared by ghost, visible row, and overflow panel. */
const OverflowItemView = React.memo(function OverflowItemView({
  Component,
  props,
}: {
  Component: React.ElementType;
  props?: OverflowItemProps;
}) {
  return <Component {...(props ?? {})} />;
});

const MORE_BTN_CLASS =
  "flex shrink-0 items-center justify-center rounded-[4px] border-none p-1.5 text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground";

/**
 * A toolbar section that moves rightmost items into a floating overflow panel
 * when the container is too narrow.  The "…" trigger is always right-aligned
 * (pushed by a flex spacer) so it sits flush against whatever follows the
 * section in the parent layout.
 */
export function OverflowToolbarSection({
  items,
  className = "",
}: {
  items: OverflowItemDef[];
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const moreButtonGhostRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const moreBtnWidthRef = useRef(FALLBACK_MORE_BTN_WIDTH);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [visibleCount, setVisibleCount] = useState(items.length);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number; maxWidth: number } | null>(null);

  const lastContainerWidthRef = useRef(-1);
  const lastAppliedLayoutRef = useRef<ComputedLayout | null>(null);

  const computeLayout = useCallback((): ComputedLayout | null => {
    const container = containerRef.current;
    const ghost = ghostRef.current;
    if (!container || !ghost) return null;

    const measuredMoreWidth = moreButtonGhostRef.current?.offsetWidth;
    if (measuredMoreWidth && measuredMoreWidth > 0) {
      moreBtnWidthRef.current = measuredMoreWidth;
    }

    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return null;

    lastContainerWidthRef.current = containerWidth;

    const ghostChildren = Array.from(ghost.children) as HTMLElement[];
    if (ghostChildren.length === 0) return null;

    const itemMeta: ToolbarItemMeta[] = ghostChildren.map((el, i) => ({
      width: el.offsetWidth,
      isSpacer: itemsRef.current[i]?.isSpacer,
      skipInOverflow: itemsRef.current[i]?.skipInOverflow,
    }));

    return computeToolbarLayout(containerWidth, itemMeta, moreBtnWidthRef.current, GAP);
  }, []);

  const applyLayout = useCallback((layout: ComputedLayout) => {
    const prev = lastAppliedLayoutRef.current;
    if (
      prev &&
      prev.visibleCount === layout.visibleCount &&
      prev.hasOverflow === layout.hasOverflow
    ) {
      return;
    }
    lastAppliedLayoutRef.current = layout;
    setVisibleCount((v) => (v === layout.visibleCount ? v : layout.visibleCount));
  }, []);

  const recalculate = useCallback(() => {
    const layout = computeLayout();
    if (layout) applyLayout(layout);
  }, [applyLayout, computeLayout]);

  useLayoutEffect(() => {
    recalculate();
  }, [items.length, recalculate]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const ghost = ghostRef.current;
    const moreGhost = moreButtonGhostRef.current;
    if (!container && !ghost && !moreGhost) return;

    const ro = new ResizeObserver((entries) => {
      let shouldRecalc = false;
      for (const entry of entries) {
        if (entry.target === container) {
          const w = container!.clientWidth;
          if (w !== lastContainerWidthRef.current) {
            shouldRecalc = true;
          }
        } else {
          shouldRecalc = true;
        }
      }
      if (shouldRecalc) recalculate();
    });
    if (container) ro.observe(container);
    if (ghost) ro.observe(ghost);
    if (moreGhost) ro.observe(moreGhost);
    return () => ro.disconnect();
  }, [recalculate]);

  useEffect(() => {
    setPanelOpen(false);
  }, [visibleCount]);

  useEffect(() => {
    if (!panelOpen) return;
    const btn = moreButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      maxWidth: rect.right - 8,
    });
  }, [panelOpen]);

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
      ) {
        return;
      }
      setPanelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [panelOpen]);

  const overflowItems = useMemo(
    () => items.slice(visibleCount).filter((item) => !item.skipInOverflow && !item.isSpacer),
    [items, visibleCount],
  );
  const showMoreButton = overflowItems.length > 0;

  const renderItem = (item: OverflowItemDef) => (
    <OverflowItemView Component={item.Component} props={item.props} />
  );

  return (
    <>
      <div
        className="pointer-events-none fixed flex gap-3"
        style={{ top: -9999, left: -9999, visibility: "hidden" }}
        aria-hidden="true"
      >
        <div ref={ghostRef} className="flex">
          {items.map((item) => (
            <div key={item.key} style={{ flexShrink: 0 }}>
              {item.isSpacer ? null : renderItem(item)}
            </div>
          ))}
        </div>
        <button
          ref={moreButtonGhostRef}
          type="button"
          tabIndex={-1}
          className={MORE_BTN_CLASS}
          aria-hidden="true"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={containerRef}
        className={`relative flex min-h-0 min-w-0 items-center gap-3 overflow-visible ${className}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {items.slice(0, visibleCount).map((item) =>
            item.isSpacer ? (
              <React.Fragment key={item.key}>{renderItem(item)}</React.Fragment>
            ) : (
              <div key={item.key} className="shrink-0">
                {renderItem(item)}
              </div>
            ),
          )}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={moreButtonRef}
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              style={{ display: showMoreButton ? undefined : "none" }}
              className={MORE_BTN_CLASS}
              aria-label="More toolbar options"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">More</TooltipContent>
        </Tooltip>

        {panelOpen && showMoreButton && panelPos &&
          createPortal(
            <div
              ref={panelRef}
              style={{
                position: "fixed",
                top: panelPos.top,
                right: panelPos.right,
                maxWidth: panelPos.maxWidth,
                zIndex: 9999,
              }}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted px-2 py-1.5 shadow-md"
            >
              {overflowItems.map((item) => (
                <React.Fragment key={item.key}>{renderItem(item)}</React.Fragment>
              ))}
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
