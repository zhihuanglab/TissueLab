/**
 * Tissue-mask RGBA expansion, split out of MaskOverlay so it can be cached and
 * tested.
 *
 * The overlay redraws inside OSD's `update-viewport` rAF, and it re-rendered on
 * every parent state change too — including the `mousePos` update the viewer
 * fires on every mouse move. Each of those repeats rebuilt the full RGBA buffer
 * pixel by pixel and re-uploaded it to a scratch canvas, for a mask that had not
 * changed. The bitmap only depends on the mask, its colour and the alpha, so it
 * is keyed on exactly those and reused until one of them changes.
 *
 * Kept dependency-free (no DOM): the per-pixel loop and the hit-test are pure
 * arithmetic, and keeping them out of the component means a mask redraw does not
 * drag canvas/context concerns through the hot path.
 */

export type MaskBitmapKey = {
  /** Identity of the mask buffer — masks are replaced, never mutated in place. */
  data: ArrayLike<number>;
  width: number;
  height: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
};

export function maskBitmapKeyEquals(
  a: MaskBitmapKey | null,
  b: MaskBitmapKey | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.data === b.data &&
    a.width === b.width &&
    a.height === b.height &&
    a.r === b.r &&
    a.g === b.g &&
    a.b === b.b &&
    a.alpha === b.alpha
  );
}

/**
 * Paint `mask` into `target` as flat RGBA: the colour everywhere, opaque where
 * the mask is set and fully transparent where it is not.
 *
 * `target` is the `data` of an ImageData of width*height, so it is written in
 * place — no allocation per frame. Pixels beyond the mask's length are left
 * transparent, matching the previous `Math.min` clamp.
 */
export function fillMaskRgba(
  target: Uint8ClampedArray,
  mask: ArrayLike<number>,
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  alpha: number,
): void {
  const pixelCount = Math.min(mask.length, width * height);
  const [r, g, b] = rgb;
  const opaque = Math.round(255 * alpha);

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    target[idx] = r;
    target[idx + 1] = g;
    target[idx + 2] = b;
    target[idx + 3] = mask[i] > 0 ? opaque : 0;
  }
}

/** Parse "#RRGGBB" (or "RRGGBB") to [r,g,b]; null when the string is not one. */
export function hexToRgb(hex?: string | null): [number, number, number] | null {
  if (!hex) return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Is the mask set at this image-space point?
 *
 * Answer it from the mask in memory, never with `ctx.getImageData` — sampling
 * even one pixel forces a GPU→CPU readback and flushes the pipeline, and this
 * runs on every mouse move.
 *
 * The offsets describe where the mask sits in image space; the grid itself is
 * `width` x `height`, so the two may differ in scale.
 */
export function isMaskSetAtImagePoint(opts: {
  mask: ArrayLike<number>;
  /** Mask grid dimensions. */
  width: number;
  height: number;
  /** Top-left of the mask in image coordinates. */
  offsetX: number;
  offsetY: number;
  /** Extent of the mask in image coordinates. */
  spanX: number;
  spanY: number;
  imageX: number;
  imageY: number;
}): boolean {
  const { mask, width, height, offsetX, offsetY, spanX, spanY, imageX, imageY } = opts;
  if (width <= 0 || height <= 0 || spanX <= 0 || spanY <= 0) return false;

  const u = (imageX - offsetX) / spanX;
  const v = (imageY - offsetY) / spanY;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;

  const col = Math.floor(u * width);
  const row = Math.floor(v * height);
  const index = row * width + col;
  if (index < 0 || index >= mask.length) return false;
  return mask[index] > 0;
}

/** Case- and separator-insensitive tissue-name match ("Foo_Bar" ≡ "foo bar"). */
function normaliseTissueName(value?: string | null): string {
  return (value || '').toLowerCase().replace(/_/g, ' ').trim();
}

/** Index of `tissue` in `classNames` under {@link normaliseTissueName}; -1 if absent. */
export function findTissueColorIndex(
  classNames: readonly string[],
  tissue?: string | null,
): number {
  const target = normaliseTissueName(tissue);
  return classNames.findIndex((name) => normaliseTissueName(name) === target);
}

// ─── Mask selection ──────────────────────────────────────────────────────────

/**
 * `selectedMaskKey` is one global viewer setting, but the masks a slide has are
 * per-slide, and the backend does not fall back for a key it cannot find: only
 * "" / "mask" resolve to the default (or sole) tissue, anything else returns
 * `success: false`. A key chosen on another slide would leave the Tissue Overlay
 * toggle enabled while nothing paints and nothing reports an error.
 */
export type MaskOptionLike = { key: string };

/**
 * Key to use given the masks a slide actually has.
 * Returns `''` — "let the backend pick the default" — when the current
 * selection is not among them.
 */
export function reconcileMaskKey(
  current: string | null | undefined,
  options: readonly MaskOptionLike[],
): string {
  const key = (current ?? '').trim();
  // "" and "mask" already mean "default"; the backend resolves them.
  if (!key || key === 'mask') return '';
  if (options.some((o) => o.key === key)) return key;
  return '';
}
