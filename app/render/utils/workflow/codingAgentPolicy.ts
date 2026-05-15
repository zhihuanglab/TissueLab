import { panelMap } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants";
import type { ContentItem } from "@/store/slices/chat/workflowSlice";

export const SCRIPT_RUN_POLICY_KEY = "script_run_policy";
export const SCRIPT_LAST_RUN_DIGEST_KEY = "script_last_run_digest";
/** Persist summary text sent to Bot chat (Run tab — summary output). */
export const SCRIPT_LAST_RUN_OUTPUT_KEY = "script_last_run_output";
/** Persist execute_script payload stringified (Run tab — raw output). */
export const SCRIPT_LAST_RUN_RAW_OUTPUT_KEY = "script_last_run_raw";

export type ScriptRunPolicy = "auto_bypass" | "require_approval";

export function digestScriptSource(code: string): string {
  const t = (code || "").trim();
  if (!t) return "";
  return `${t.length}:${t.slice(0, 64)}`;
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
  const merged = [...content];
  for (const d of defaults) {
    if (d.key && !keys.has(d.key)) merged.push({ ...d } as ContentItem);
  }
  return merged;
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
  const digest = digestScriptSource(scriptSource);

  if (executeInFlight) return "Running…";

  if (workflowRunning && gptBackendStatus === 1) {
    return "Generating code";
  }

  if (hasGeneratedScript && digest && lastRunDigest !== digest) {
    if (policy === "require_approval") return "Pending for approval";
    // auto_bypass: auto-run is triggered asynchronously; show Running only while executeInFlight (handled above).
  }

  return null;
}
