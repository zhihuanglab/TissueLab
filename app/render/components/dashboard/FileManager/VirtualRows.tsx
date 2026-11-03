"use client";
import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const DESKTOP_QUERY = '(min-width: 768px)'; // Tailwind `md`

const subscribeDesktop = (onChange: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * True at Tailwind's `md` breakpoint and up. File lists used to render both the
 * desktop table and the mobile cards and hide one with CSS — twice the DOM for
 * every row. Picking one in JS renders only the layout on screen.
 */
export const useIsDesktopLayout = (): boolean =>
  useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );

export interface VirtualRowsProps {
  /**
   * Every row of the list, in order. Each must be a keyed element that renders
   * exactly one DOM node (a `<tr>`, a `<div>`) and forwards its ref to it —
   * that node is what gets measured. Building the elements is cheap; only the
   * ones near the viewport are ever rendered.
   */
  rows: React.ReactElement[];
  /** The element that actually scrolls. The list may start anywhere inside it. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Typical row height in px, margins included. Measured rows replace it. */
  estimateSize: number;
  /**
   * An empty placeholder of the given height, of the same kind as the rows
   * (a `<tr>` inside a table body). Must forward `ref` when one is passed.
   */
  renderSpacer: (height: number, key: string, ref?: React.Ref<HTMLElement>) => React.ReactElement;
  overscan?: number;
}

/** Height plus vertical margins — card rows space themselves with `mb-2`. */
const measureWithMargins = (el: Element): number => {
  const style = window.getComputedStyle(el);
  return el.getBoundingClientRect().height
    + (parseFloat(style.marginTop) || 0)
    + (parseFloat(style.marginBottom) || 0);
};

/**
 * Renders only the rows near the viewport, with spacers standing in for the
 * rest so the scrollbar still covers the whole list.
 *
 * Spacers rather than absolute positioning, so the rows stay in normal flow:
 * table rows keep sharing column widths with the header, and the drop zone,
 * sentinel and banners around the list need no changes.
 *
 * Row CSS that counts siblings (`even:` striping) would flip as the first
 * rendered row moves, because the top spacer shifts every row's position by
 * one. An extra zero-height spacer whenever that first index is odd keeps each
 * row's child position matching its real index.
 */
export const VirtualRows: React.FC<VirtualRowsProps> = ({
  rows,
  scrollRef,
  estimateSize,
  renderSpacer,
  overscan = 8,
}) => {
  // The top spacer's top edge is where the list starts inside the scroller.
  const anchorRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    scrollMargin,
    getItemKey: (index) => rows[index]?.key ?? index,
    measureElement: measureWithMargins,
  });

  // Headers, banners and the toolbar above the list can change height, which
  // moves where the list starts; re-read it after every render.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    const anchor = anchorRef.current;
    if (!scrollEl || !anchor) return;
    const next = anchor.getBoundingClientRect().top
      - scrollEl.getBoundingClientRect().top
      + scrollEl.scrollTop;
    if (Math.abs(next - scrollMargin) > 0.5) setScrollMargin(next);
  });

  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  // Virtual starts include the scroll margin; the total size does not.
  const topHeight = first ? first.start - scrollMargin : 0;
  const bottomHeight = last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0;

  return (
    <>
      {renderSpacer(Math.max(0, topHeight), 'virtual-rows:top', anchorRef)}
      {first && first.index % 2 === 1 && renderSpacer(0, 'virtual-rows:parity')}
      {items.map((item) =>
        React.cloneElement(rows[item.index] as React.ReactElement<any>, {
          ref: virtualizer.measureElement,
          'data-index': item.index,
        }),
      )}
      {/* Only while rows remain below, so `last:` row styles still apply at the end. */}
      {bottomHeight > 0.5 && renderSpacer(bottomHeight, 'virtual-rows:bottom')}
    </>
  );
};

/** Spacer for rows inside a `<tbody>`. */
export const renderTableSpacer: VirtualRowsProps['renderSpacer'] = (height, key, ref) => (
  <tr key={key} ref={ref as React.Ref<HTMLTableRowElement>} aria-hidden style={{ height, border: 0 }}>
    <td colSpan={99} style={{ padding: 0, border: 0 }} />
  </tr>
);

/** Spacer for rows that are block elements. */
export const renderBlockSpacer: VirtualRowsProps['renderSpacer'] = (height, key, ref) => (
  <div key={key} ref={ref as React.Ref<HTMLDivElement>} aria-hidden style={{ height, border: 0, margin: 0 }} />
);
