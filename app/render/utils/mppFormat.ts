/** Round to 4 fractional digits, then drop trailing zeros (no fixed padding). */
export function formatMppDisplay(mpp: number): string {
  if (!Number.isFinite(mpp) || mpp <= 0) return "";
  const r = Math.round(mpp * 10000) / 10000;
  return r.toFixed(4).replace(/\.?0+$/, "");
}
