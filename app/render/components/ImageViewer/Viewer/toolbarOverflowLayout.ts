/**
 * Pure toolbar overflow layout — no DOM, testable boundary math.
 * Keep in sync with ToolbarOverflowPanel.tsx flex structure.
 */

export const TOOLBAR_GAP = 12;
export const TOOLBAR_MORE_BTN_WIDTH = 28;

export interface ToolbarItemMeta {
  width: number;
  isSpacer?: boolean;
  skipInOverflow?: boolean;
}

export interface ToolbarLayoutResult {
  visibleCount: number;
  hasOverflow: boolean;
}

export function fitToolbarItemCount(
  budget: number,
  items: ToolbarItemMeta[],
  gap = TOOLBAR_GAP,
): number {
  const n = items.length;
  let usedWidth = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item.isSpacer) {
      count++;
      continue;
    }
    const w = Math.ceil(item.width);
    const gapBefore = count > 0 ? gap : 0;
    if (usedWidth + gapBefore + w <= budget) {
      usedWidth += gapBefore + w;
      count++;
    } else {
      break;
    }
  }
  while (
    count > 0 &&
    items[count - 1]?.skipInOverflow &&
    !items[count - 1]?.isSpacer
  ) {
    count--;
  }
  return count;
}

export function totalToolbarItemsWidth(items: ToolbarItemMeta[], gap = TOOLBAR_GAP): number {
  return items.reduce(
    (sum, item, i) => sum + (item.isSpacer ? 0 : Math.ceil(item.width)) + (i > 0 ? gap : 0),
    0,
  );
}

/**
 * Two branches:
 * 1. All-fit — every item visible, no "…" button
 * 2. Overflow — partial items + "…"
 */
export function computeToolbarLayout(
  containerWidth: number,
  items: ToolbarItemMeta[],
  moreBtnWidth = TOOLBAR_MORE_BTN_WIDTH,
  gap = TOOLBAR_GAP,
): ToolbarLayoutResult | null {
  if (containerWidth <= 0 || items.length === 0) return null;

  const n = items.length;
  const totalAllWidth = totalToolbarItemsWidth(items, gap);
  if (totalAllWidth <= containerWidth) {
    return { visibleCount: n, hasOverflow: false };
  }

  const budget = containerWidth - moreBtnWidth - gap;
  const count = fitToolbarItemCount(budget, items, gap);
  return { visibleCount: count, hasOverflow: true };
}

/** Smallest container width where all items still fit (inclusive). */
export function minContainerForAllFit(items: ToolbarItemMeta[], gap = TOOLBAR_GAP): number {
  return totalToolbarItemsWidth(items, gap);
}
