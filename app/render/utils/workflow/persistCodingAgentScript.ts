import { panelMap } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants";
import type { AppDispatch } from "@/store";
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { updatePanel } from "@/store/slices/chat/workflowSlice";
import { formatPath } from "@/utils/pathUtils";

function toZarrKey(path: string): string {
  const p = formatPath(path).trim();
  if (!p) return "";
  return p.endsWith(".zarr") ? p : `${p}.zarr`;
}

function localStorageKey(zarrKey: string): string {
  return `tl_coding_generated_script:${encodeURIComponent(zarrKey)}`;
}

/** Persist last generated Python script for this slide (survives full page reload). */
export function persistCodingAgentGeneratedScript(zarrPath: string, script: string): void {
  if (typeof window === "undefined") return;
  const z = toZarrKey(zarrPath);
  const body = (script ?? "").trim();
  if (!z || !body) return;
  try {
    localStorage.setItem(localStorageKey(z), script);
  } catch {
    /* quota / private mode */
  }
}

export function loadCodingAgentGeneratedScript(zarrPath: string): string {
  if (typeof window === "undefined") return "";
  const z = toZarrKey(zarrPath);
  if (!z) return "";
  try {
    return localStorage.getItem(localStorageKey(z)) ?? "";
  } catch {
    return "";
  }
}

/** After workflow panels are created, fill empty Coding Agent nodes from localStorage. */
export function hydrateCodingAgentPanelsIfEmpty(
  dispatch: AppDispatch,
  panels: WorkflowPanel[],
  slideOrZarrPath: string,
): void {
  const cached = loadCodingAgentGeneratedScript(slideOrZarrPath).trim();
  if (!cached) return;
  const codingType = panelMap.CodingAgent.defaultType;
  for (const panel of panels) {
    if (panel.type !== codingType) continue;
    const scriptItem = panel.content.find((c) => c.key === "generated_script");
    const existing = typeof scriptItem?.value === "string" ? scriptItem.value.trim() : "";
    if (existing) continue;
    dispatch(
      updatePanel({
        id: panel.id,
        updatedPanel: {
          ...panel,
          content: [
            ...panel.content.filter((c) => c.key !== "generated_script"),
            { key: "generated_script", type: "text", value: cached } as (typeof panel.content)[number],
          ],
        },
      }),
    );
  }
}
