import { panelMap } from "@/constants/workflow.constants";
import type { ContentItem } from "@/store/slices/chat/workflowSlice";

export const SCRIPT_RUN_POLICY_KEY = "script_run_policy";
export const SCRIPT_LAST_RUN_DIGEST_KEY = "script_last_run_digest";
/** Persist summary text sent to Bot chat (Run tab — summary output). */
export const SCRIPT_LAST_RUN_OUTPUT_KEY = "script_last_run_output";
/** Persist execute_script payload stringified (Run tab — raw output). */
export const SCRIPT_LAST_RUN_RAW_OUTPUT_KEY = "script_last_run_raw";

export type ScriptRunPolicy = "auto_bypass" | "require_approval";

/**
 * Fingerprint of a script (length + FNV-1a 32-bit hash over the whole trimmed
 * text), so any edit — including a same-length one deep in the body — counts
 * as a new script that has not been run yet.
 */
export function digestScriptSource(code: string): string {
  const t = (code || "").trim();
  if (!t) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${t.length}:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Whether `stored` (a saved last-run digest) is the digest of `code`. Also
 * accepts the older `length:first-64-chars` format, so scripts that already ran
 * before the format change are not treated as new (and auto-run again).
 */
export function scriptDigestMatches(stored: string | undefined, code: string): boolean {
  if (!stored) return false;
  const t = (code || "").trim();
  if (!t) return false;
  return stored === digestScriptSource(t) || stored === `${t.length}:${t.slice(0, 64)}`;
}

export function getScriptRunPolicy(content: ContentItem[] | undefined): ScriptRunPolicy {
  const item = content?.find((c) => c.key === SCRIPT_RUN_POLICY_KEY);
  const v = item?.value;
  if (v === "require_approval") return "require_approval";
  return "auto_bypass";
}

/** Merge missing keys from panelMap defaults (single source for new CodingAgent fields). */
export function mergePanelContentWithFactoryDefaults(
  content: ContentItem[],
  factory: keyof typeof panelMap | string
): ContentItem[] {
  const cfg = (panelMap as Record<string, { defaultContent?: ContentItem[] }>)[factory as string];
  const defaults = cfg?.defaultContent;
  if (!defaults?.length) return content;
  const keys = new Set(content.map((c) => c.key).filter(Boolean) as string[]);
  const missing = defaults.filter((d) => d.key && !keys.has(d.key));
  if (missing.length === 0) return content;
  return [...content, ...missing.map((d) => ({ ...d } as ContentItem))];
}

export function getCodingAgentCardBadge(args: {
  hasGeneratedScript: boolean;
  scriptSource: string;
  policy: ScriptRunPolicy;
  /** Backend node status for GPT-4o Agent: 0 idle, 1 running, 2 done */
  gptBackendStatus: number;
  workflowRunning: boolean;
  /** Local: execute_script + summary in flight from UI */
  executeInFlight: boolean;
  lastRunDigest: string;
}): string | null {
  const {
    hasGeneratedScript,
    scriptSource,
    policy,
    gptBackendStatus,
    workflowRunning,
    executeInFlight,
    lastRunDigest,
  } = args;
  if (executeInFlight) return "Running…";

  if (workflowRunning && gptBackendStatus === 1) {
    return "Generating code";
  }

  if (hasGeneratedScript && scriptSource.trim() && !scriptDigestMatches(lastRunDigest, scriptSource)) {
    if (policy === "require_approval") return "Pending for approval";
    // auto_bypass: auto-run is triggered asynchronously; show Running only while executeInFlight (handled above).
  }

  return null;
}
