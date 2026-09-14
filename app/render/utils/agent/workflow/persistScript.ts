// The Coding Agent's generated script is intentionally SESSION-ONLY.
//
// It lives in the in-memory workflow store (`panel.content` key
// `generated_script`) and is therefore gone after a full page refresh. We no
// longer mirror it to localStorage: reopening a slide and finding a stale old
// script sitting there was confusing and made it look like a hardcoded default.
//
// These functions are kept (as no-ops) so existing call sites keep compiling.

import type { AppDispatch } from "@/store";
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";

const _LEGACY_KEY_PREFIX = "tl_coding_generated_script:";

// One-time cleanup: drop any scripts a previous build cached in localStorage so
// users who already have residue don't keep seeing it.
(function purgeLegacyCachedScripts() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(_LEGACY_KEY_PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* private mode / quota — ignore */
  }
})();

/** No-op: the generated script is session-only (in the workflow store), not persisted. */
export function persistCodingAgentGeneratedScript(_zarrPath: string, _script: string): void {
  /* intentionally not persisted — see file header */
}

/** Always returns "" — nothing survives a refresh anymore. */
export function loadCodingAgentGeneratedScript(_zarrPath: string): string {
  return "";
}

/** No-op: Coding Agent panels are no longer pre-filled from a cache. */
export function hydrateCodingAgentPanelsIfEmpty(
  _dispatch: AppDispatch,
  _panels: WorkflowPanel[],
  _slideOrZarrPath: string,
): void {
  /* intentionally a no-op — see file header */
}
