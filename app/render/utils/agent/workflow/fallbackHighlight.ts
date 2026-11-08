/**
 * Offline syntax highlighter used when highlight.js (loaded from cdnjs) is
 * unavailable. Strings, numbers and keywords are matched in ONE pass over the
 * raw source, so a later rule never re-matches the markup an earlier one
 * inserted (which used to garble code into `class="text-amber-300">0.5`).
 * Everything is HTML-escaped; the result is safe for dangerouslySetInnerHTML.
 */
export type FallbackHighlightClasses = { string: string; number: string; keyword: string };

const TOKEN =
  /(["'])(?:\\.|(?!\1).)*\1|\b\d+(?:\.\d+)?\b|\b(?:def|return|import|from|as|if|elif|else|for|while|with|try|except|class)\b/g;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function fallbackHighlight(src: string, classes: FallbackHighlightClasses): string {
  const text = src || "";
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const tok = m[0];
    const cls = m[1] ? classes.string : /^\d/.test(tok) ? classes.number : classes.keyword;
    out += escapeHtml(text.slice(last, start)) + `<span class="${cls}">${escapeHtml(tok)}</span>`;
    last = start + tok.length;
  }
  return out + escapeHtml(text.slice(last));
}
