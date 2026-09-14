/** First finite numeric value in a list (e.g. runtime status map values). */
export function firstNumericRuntimeValue(vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * SSE / Redux payloads sometimes nest maps under `node_status` / `node_progress`, sometimes flatten.
 */
export function normalizeWorkflowRuntimeMap(
  raw: unknown,
  nestedKey: "node_status" | "node_progress"
): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const nested = (raw as Record<string, unknown>)[nestedKey]
    if (nested && typeof nested === "object") return nested as Record<string, unknown>
    return raw as Record<string, unknown>
  }
  return {}
}

/**
 * Live SSE must never be Math.max'd against a previous run's 100%.
 * - status 2 → complete
 * - status 1 → live value
 * - active run but not started → 0
 * - idle → keep previous (terminal heal may snap later)
 */
export function resolveLiveOrStickyProgress(opts: {
  status: number | undefined;
  runtimeIsActive: boolean;
  liveProgress: number;
  previousProgress: number;
}): number {
  const { status, runtimeIsActive, liveProgress, previousProgress } = opts;
  if (status === 2) return 100;
  if (status === 1) return liveProgress;
  if (runtimeIsActive) return 0;
  return previousProgress;
}

/**
 * After successful workflow_complete, snap participants to done (2/100).
 * Includes status 0 — fast .tlcls runs often never leave a 1/running tick.
 */
export function markParticipatingNodesDone(
  nodeStatus: Record<string, number>,
  nodeProgress: Record<string, number>
) {
  const nextStatus = { ...nodeStatus };
  const nextProgress = { ...nodeProgress };
  let statusChanged = false;
  let progressChanged = false;
  const keys = new Set<string>();
  for (const [key, status] of Object.entries(nextStatus)) {
    if (key.startsWith("_") || status === -1) continue;
    keys.add(key);
  }
  for (const [key, progress] of Object.entries(nextProgress)) {
    if (key.startsWith("_") || nextStatus[key] === -1) continue;
    if (typeof progress === "number" && progress > 0) keys.add(key);
  }
  for (const key of keys) {
    if (nextStatus[key] !== 2) {
      nextStatus[key] = 2;
      statusChanged = true;
    }
    if (nextProgress[key] !== 100) {
      nextProgress[key] = 100;
      progressChanged = true;
    }
  }
  return { nodeStatus: nextStatus, nodeProgress: nextProgress, statusChanged, progressChanged };
}

export type PreProcessedStageDef = {
  key: string;
  label?: string;
  preProcessed?: boolean;
};

export type PreProcessedSubStage = {
  key: string;
  label: string;
  progress: number;
};

/**
 * Idle zarr stage refresh: only lift `preProcessed` bars from the API.
 * Keep classification / rerunnable progress from previous local state so a
 * finished .tlcls run is not wiped back to Pending.
 */
export function mergePreProcessedSubstages(options: {
  template: PreProcessedStageDef[];
  fresh: PreProcessedSubStage[];
  previous: PreProcessedSubStage[] | undefined;
  breakdown: Record<string, number> | undefined;
  nodeTerminalDone: boolean;
}): PreProcessedSubStage[] | null {
  const { template, fresh, previous, breakdown, nodeTerminalDone } = options;
  if (!fresh.length) return null;

  if (!breakdown || Object.keys(breakdown).length === 0) {
    if (nodeTerminalDone && previous?.length) {
      return previous.map((s) => ({ ...s, progress: 100 }));
    }
    return previous?.length ? previous : null;
  }

  return fresh.map((s, idx) => {
    const def = template[idx];
    if (!def?.preProcessed) {
      if (nodeTerminalDone) return { ...s, progress: 100 };
      const prevProg = previous?.[idx]?.progress;
      if (typeof prevProg === "number" && Number.isFinite(prevProg)) {
        return { ...s, progress: Math.max(0, Math.min(100, prevProg)) };
      }
      return s;
    }
    // A node that just completed (status 2 / progress 100) necessarily had its
    // prerequisites in place — keep those bars Done even if the zarr-derived
    // breakdown lags behind (attrs not yet visible, shared slot re-read, …).
    if (nodeTerminalDone) return { ...s, progress: 100 };
    const raw = breakdown[def.key] ?? breakdown[s.key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value) && value >= 100) return { ...s, progress: 100 };
    return s;
  });
}
