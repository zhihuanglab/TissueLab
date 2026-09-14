/**
 * The pointer's position in image coordinates, kept outside React.
 *
 * OpenSeadragon reports every mouse move, and a coordinate readout is not state:
 * nothing branches on it and nothing else depends on it. Routing it through
 * React re-rendered the viewer on every move, so {@link bindPointerPositionText}
 * writes the text nodes directly instead.
 *
 * Two clocks, because the consumers want different things:
 *
 *   • {@link getPointerPosition} — exact, updated on every move. The ruler
 *     tooltip needs the real position at the moment it asks.
 *   • the published snapshot subscribers see — promoted at most once per frame,
 *     which is all a readout of rounded integers can use.
 */
export type PointerPosition = { x: number; y: number };

const ORIGIN: PointerPosition = { x: 0, y: 0 };

/** Exact, updated on every move. */
let latest: PointerPosition = ORIGIN;
/** What subscribers see; promoted from `latest` at most once per frame. */
let published: PointerPosition = ORIGIN;

const listeners = new Set<() => void>();
let promotionScheduled = false;

function schedulePromotion(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function promote(): void {
  promotionScheduled = false;
  // By value, not by reference: a pointer that wanders and comes back within
  // one frame produces a new `latest` object holding the old coordinates, and
  // publishing that would re-render subscribers for no visible change.
  if (published.x === latest.x && published.y === latest.y) return;
  published = latest;
  for (const listener of listeners) listener();
}

/**
 * Publish a new pointer position. Identical positions are dropped, so a mouse
 * event that does not move the pointer costs nothing at all.
 */
export function setPointerPosition(x: number, y: number): void {
  if (latest.x === x && latest.y === y) return;
  latest = { x, y };
  if (promotionScheduled) return;
  promotionScheduled = true;
  schedulePromotion(promote);
}

/**
 * The exact current position. Stable reference until the pointer actually
 * moves. Use this for anything that reads on demand.
 */
export function getPointerPosition(): PointerPosition {
  return latest;
}

/** The frame-coalesced position React subscribers see. */
function getPublishedPointerPosition(): PointerPosition {
  return published;
}

function subscribePointerPosition(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Write the pointer position straight into two DOM nodes, bypassing React.
 *
 * Pass the elements holding the x and y text; they are written on subscribe and
 * then at most once per frame while the pointer moves.
 */
export function bindPointerPositionText(
  xNode: { textContent: string | null } | null,
  yNode: { textContent: string | null } | null,
  format: (value: number) => string = (value) => String(Math.round(value)),
): () => void {
  if (!xNode && !yNode) return () => {};

  const write = () => {
    const { x, y } = getPublishedPointerPosition();
    if (xNode) {
      const next = format(x);
      // Assigning textContent dirties layout even when the string is identical.
      if (xNode.textContent !== next) xNode.textContent = next;
    }
    if (yNode) {
      const next = format(y);
      if (yNode.textContent !== next) yNode.textContent = next;
    }
  };

  write(); // paint the current value immediately, not on the next move
  return subscribePointerPosition(write);
}
