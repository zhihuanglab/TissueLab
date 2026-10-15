/**
 * Keeps an OpenSeadragon viewer's tile Authorization header current.
 *
 * OSD requests tiles itself with the headers it was given, so a Firebase token
 * that expires mid-session (an hour in, or after the laptop sleeps) keeps
 * going out. The backend rejects it, every finer level fails, and OSD marks
 * those tiles missing for good: the slide stays on the coarse level already
 * cached until the viewer is rebuilt.
 *
 * Swap the header in place (no rebuild) whenever Firebase issues a new token,
 * the tab comes back, or a tile is refused; then revive what failed under the
 * old one. guardTileSource makes the refusals visible to OSD in the first place.
 */

import { forceRefreshAuthToken, getAuthToken, onAuthTokenChange } from "../common/authToken";
import { isTileTokenRejection } from "./tileResponse";
import { reviveFailedTiles } from "./tileRevive";

const TILE_ACCEPT = "image/jpeg,image/png,image/*,*/*";
// A burst of failed tiles shares one forced refresh. If rejections continue
// after it (the cause was not the token), back off up to the cap; a tile that
// loads resets it.
const FORCE_REFRESH_COOLDOWN_MS = 30 * 1000;
const FORCE_REFRESH_COOLDOWN_MAX_MS = 10 * 60 * 1000;

export const tileAjaxHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: TILE_ACCEPT,
});

const bearerIn = (headers: any): string | null => {
  const header: unknown = headers?.Authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : null;
};
const bearerOf = (viewer: any): string | null => bearerIn(viewer?.ajaxHeaders);

// The token each failed tile request was sent with: a refusal of a token
// already replaced says nothing about the current one.
const sentTokens = new WeakMap<XMLHttpRequest, string>();

/** Set the token on the viewer, its tiles and queued jobs, and reload what it failed. */
export function applyTileAuthToken(viewer: any, token: string): void {
  // propagate=true rewrites existing tiles and queued jobs; jobs in flight or
  // awaiting a retry pick the new header up in guardTileSource.
  viewer.setAjaxHeaders({ ...viewer.ajaxHeaders, ...tileAjaxHeaders(token) }, true);
  reviveFailedTiles(viewer);
}

// Content-Type is CORS-safelisted, so it is readable cross-origin.
const isImage = (request: XMLHttpRequest | undefined): boolean =>
  (request?.getResponseHeader?.("Content-Type") || "").startsWith("image/");

/**
 * Backend errors are HTTP 200 with a JSON envelope. OSD only checks the status,
 * so it takes the envelope as tile bytes, counts the tile loaded and never asks
 * again. Fail anything that is not an image, so OSD retries and
 * tile-load-failed fires.
 */
export function guardTileSource(source: any): void {
  if (!source || source.__tileAuthGuarded) return;
  source.__tileAuthGuarded = true;
  const download = source.downloadTileStart;
  source.downloadTileStart = function (context: any) {
    // A job keeps the headers it was created with, retries included; one in
    // flight when the token was swapped would retry with the dead token.
    if (context.tile?.loadWithAjax && context.tile.ajaxHeaders) {
      context.ajaxHeaders = context.tile.ajaxHeaders;
    }
    const sentWith = bearerIn(context.ajaxHeaders);
    // OSD retries by starting the same job again: wrap OSD's own callbacks,
    // not the wrappers of an earlier attempt.
    const fail = (context.__tileAuthFail ??= context.fail);
    const finish = (context.__tileAuthFinish ??= context.finish);
    context.fail = (message: string, request: XMLHttpRequest | undefined) => {
      if (request && sentWith) sentTokens.set(request, sentWith);
      return fail.call(context, message, request);
    };
    // No jobId: the job already timed out. finish() drops such a late reply,
    // fail() would not — it would complete the job a second time.
    context.finish = (data: any, request: XMLHttpRequest | undefined, dataType: string) =>
      context.jobId && request && !isImage(request)
        ? context.fail("[tileAuth] error envelope instead of tile image", request)
        : finish.call(context, data, request, dataType);
    return download.call(this, context);
  };
}

/**
 * Watch for stale tile tokens on `viewer`. Returns the unsubscribe.
 *
 * One refresh at a time, as a small state machine:
 *
 *   idle ──read──▶ reading ──▶ idle          token changed → applied
 *                     │
 *                     └─ unchanged, a tile was refused since the last
 *                        working token, cooldown passed ──▶ forcing ──▶ idle
 *
 * - A refusal that lands mid-flight only sets `refused`; the running step
 *   reads it when it finishes, so no escalation is lost to a busy machine.
 * - Every applied token bumps `epoch`; a step whose epoch moved on while it
 *   waited (Firebase pushed a newer token meanwhile) drops its result instead
 *   of putting an older token back.
 */
export function watchTileAuth(viewer: any, onToken?: (token: string) => void): () => void {
  let disposed = false;
  let phase: "idle" | "reading" | "forcing" = "idle";
  let epoch = 0;
  // A tile was refused and no token has worked since.
  let refused = false;
  let lastForcedAt = 0;
  let cooldownMs = FORCE_REFRESH_COOLDOWN_MS;

  const apply = (token: string | null): boolean => {
    if (disposed || !token || token === bearerOf(viewer)) return false;
    applyTileAuthToken(viewer, token);
    epoch++;
    refused = false;
    onToken?.(token);
    return true;
  };

  const forceAllowed = () => Date.now() - lastForcedAt >= cooldownMs;

  const run = async (step: "read" | "force") => {
    phase = step === "force" ? "forcing" : "reading";
    if (step === "force") {
      // Still refused after the last forced refresh: not the token. Wait longer.
      if (lastForcedAt) cooldownMs = Math.min(cooldownMs * 2, FORCE_REFRESH_COOLDOWN_MAX_MS);
      lastForcedAt = Date.now();
    }
    const startEpoch = epoch;
    let token: string | null = null;
    try {
      token = step === "force" ? await forceRefreshAuthToken() : await getAuthToken();
    } catch (error) {
      console.warn("[tileAuth] token refresh failed:", error);
    }
    if (disposed) return;
    const stale = epoch !== startEpoch;
    const changed = !stale && apply(token);
    phase = "idle";
    // The same token came back but the server refuses it (revoked, clock skew).
    if (step === "read" && !stale && !changed && refused && forceAllowed()) void run("force");
  };

  const read = () => {
    if (phase === "idle") void run("read");
  };

  const onTileFailed = (event: any) => {
    const request = event?.tileRequest;
    if (!isTileTokenRejection(request)) return;
    // Sent before the last swap: the retry (or tileRevive) uses the new token.
    const sentWith = sentTokens.get(request);
    if (sentWith && sentWith !== bearerOf(viewer)) return;
    refused = true;
    read();
  };

  // A tile loaded: the current token works.
  const onTileLoaded = () => {
    refused = false;
    lastForcedAt = 0;
    cooldownMs = FORCE_REFRESH_COOLDOWN_MS;
  };

  // Timers stall while a laptop sleeps or a tab sits in the background.
  const onVisible = () => {
    if (document.visibilityState === "visible") read();
  };

  // Channel and z-layer switches add new tiled images with new sources.
  const onAddItem = (event: any) => guardTileSource(event?.item?.source);
  for (let i = 0; i < (viewer.world?.getItemCount?.() ?? 0); i++) {
    guardTileSource(viewer.world.getItemAt(i)?.source);
  }

  viewer.world.addHandler("add-item", onAddItem);
  viewer.addHandler("tile-load-failed", onTileFailed);
  viewer.addHandler("tile-loaded", onTileLoaded);
  document.addEventListener("visibilitychange", onVisible);
  // A token pushed by Firebase is applied directly, whatever the phase.
  const unsubscribe = onAuthTokenChange(apply);

  return () => {
    disposed = true;
    unsubscribe();
    viewer.world.removeHandler("add-item", onAddItem);
    viewer.removeHandler("tile-load-failed", onTileFailed);
    viewer.removeHandler("tile-loaded", onTileLoaded);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
