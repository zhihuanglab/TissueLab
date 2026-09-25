"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Globe } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { getConfig } from "@/services/fileManager.service";
import { useSelector } from "react-redux";
import type { RootState } from "@/store";
import { cn } from "@/utils/common/twMerge";
import WebFileManager from "./WebFileManager";

type FolderCategory = "personal" | "samples";

// ─── localStorage persistence ────────────────────────────────────────────────
// Just the last-seen path. Which CARD is active is derived from the path
// each render — there is no separately-persisted "active folder" anymore.
const ACTIVE_PATH_STORAGE_KEY = "tl_dashboard_active_path";

const readSavedPath = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ACTIVE_PATH_STORAGE_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
};

const writeSavedPath = (path: string) => {
  if (typeof window === "undefined" || !path) return;
  try {
    window.localStorage.setItem(ACTIVE_PATH_STORAGE_KEY, path);
  } catch {
    /* ignore */
  }
};
// ─────────────────────────────────────────────────────────────────────────────

interface FolderCardDef {
  key: FolderCategory;
  label: string;
  description: string;
  icon: React.ElementType;
}

const FOLDER_CARDS: FolderCardDef[] = [
  {
    key: "personal",
    label: "Personal",
    description: "Your private files and uploads",
    icon: Folder,
  },
  {
    key: "samples",
    label: "Public Samples",
    description: "Browse example datasets",
    icon: Globe,
  },
];

const StorageFolderCards: React.FC = () => {
  // Observe (NEVER write) WebFileManager's currentDirectory so we can keep the
  // localStorage path snapshot fresh as the user drills around inside the file
  // browser. The previous version of this component dispatched into Redux from
  // here as well, which fought with WebFileManager's own dispatches and caused
  // bounces between Personal and the saved path. Read-only avoids that.
  const reduxCurrentDirectory = useSelector(
    (s: RootState) => s.fileManager.currentDirectory
  );

  // `requestedNav` is the user's explicit "navigate here" signal — set by
  // card clicks and by the open-personal event. The `key` field changes on
  // every click so clicking the same card twice (e.g. after a stale state)
  // still triggers a fresh fetch via the WebFileManager remount key.
  //
  // Which CARD is highlighted is computed from `reduxCurrentDirectory`
  // (single source of truth) — NOT from this state — so the active card
  // always matches whatever the file panel is actually showing. When auth
  // or permission fails inside the panel and it falls back to "samples",
  // the highlight follows automatically.
  const [requestedNav, setRequestedNav] = useState<{ path: string; key: number } | null>(null);
  const [personalPath, setPersonalPath] = useState<string>("");
  // Read the deep path ONCE at mount. After WebFileManager takes over it owns
  // currentDirectory; we don't want to keep recomputing initialPath as it
  // changes (that would steal navigation focus from the user).
  const initialSavedPathRef = useRef<string | null>(readSavedPath());

  // Track container width to swap between compact (horizontal: icon + text
  // side-by-side) and comfortable (vertical: icon stacked on top, modestly
  // larger). Same callback-ref + ResizeObserver pattern used by WebFileManager.
  //
  // Threshold is intentionally high so the comfortable layout only appears
  // when the dashboard panel itself is wide — i.e. when the Cortex sidebar
  // on the right is at or near its minimum width and the file-browser area
  // has lots of room. At narrower content sizes the compact horizontal
  // layout uses the space better.
  const COMFORTABLE_LAYOUT_WIDTH = 900;
  const [cardsContainer, setCardsContainer] = useState<HTMLDivElement | null>(null);
  const [cardsWidth, setCardsWidth] = useState<number>(COMFORTABLE_LAYOUT_WIDTH);
  useEffect(() => {
    if (!cardsContainer || typeof ResizeObserver === "undefined") return;
    // RAF-coalesced so dragging the dashboard / Cortex resizer doesn't
    // trigger a setState per pixel — only the breakpoint outcome matters.
    let rafId: number | null = null;
    let latestWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w <= 0) return;
      latestWidth = w;
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setCardsWidth(latestWidth);
      });
    });
    ro.observe(cardsContainer);
    return () => {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [cardsContainer]);
  const comfortable = cardsWidth >= COMFORTABLE_LAYOUT_WIDTH;

  const defaultFolder: FolderCategory = "personal";

  // Fetch the local user's personal path from /v1/config.
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => {
        if (!cancelled && cfg?.defaultPath) {
          setPersonalPath(cfg.defaultPath.replace(/\\/g, "/"));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const getPathForFolder = useCallback(
    (folder: FolderCategory): string => {
      switch (folder) {
        case "personal":
          return personalPath;
        case "samples":
          return "samples";
      }
    },
    [personalPath]
  );

  // Infer which tab a given path belongs to. Used to keep the active-card
  // highlight in sync when WebFileManager navigates via breadcrumb / clicks,
  // and to validate that a persisted deep path still belongs to the active
  // tab.
  const folderForPath = useCallback(
    (path: string): FolderCategory | null => {
      if (!path) return null;
      const p = path.replace(/\\/g, "/");
      if (p === "samples" || p.startsWith("samples/")) return "samples";
      if (personalPath && (p === personalPath || p.startsWith(`${personalPath}/`)))
        return "personal";
      return null;
    },
    [personalPath]
  );

  // Highlight follows the path, but only updates when the path actually
  // resolves to a known folder. During transitions (mid-fetch, etc.) the inferred folder briefly
  // becomes null — when that happens we hold the last known good value so
  // the highlight doesn't flicker to the default and back.
  const inferredFolder = folderForPath(reduxCurrentDirectory);
  const lastValidFolderRef = useRef<FolderCategory | null>(null);
  useEffect(() => {
    if (inferredFolder) lastValidFolderRef.current = inferredFolder;
  }, [inferredFolder]);
  const activeFolder: FolderCategory =
    inferredFolder ?? lastValidFolderRef.current ?? defaultFolder;

  // Persist the actual displayed path so the next visit lands here.
  useEffect(() => {
    const next = (reduxCurrentDirectory || "").trim();
    if (!next || next.startsWith("__")) return; // skip sentinels
    writeSavedPath(next);
  }, [reduxCurrentDirectory]);

  // The path we want WebFileManager to fetch on its next (re)mount:
  //   1. An explicit nav request (card click / open-personal event) wins.
  //   2. Otherwise the deep path restored from localStorage at mount, if it
  //      still matches one of the known folders.
  //   3. Otherwise the root of the default folder (Personal).
  const resolvedInitialPath = (() => {
    if (requestedNav?.path) return requestedNav.path;
    const saved = initialSavedPathRef.current;
    if (saved && folderForPath(saved)) return saved;
    return getPathForFolder(defaultFolder);
  })();

  const handleCardClick = useCallback(
    (folder: FolderCategory) => {
      const target = getPathForFolder(folder);
      if (!target) return; // personalPath not loaded yet — wait for getConfig
      // Always stamp a fresh key so clicking the same card twice still
      // triggers a remount + refetch (useful when the previous fetch
      // failed and the user wants to retry).
      setRequestedNav({ path: target, key: (requestedNav?.key ?? 0) + 1 });
      initialSavedPathRef.current = null;
    },
    [getPathForFolder, requestedNav?.key]
  );

  // Cortex "open this study" — same machinery as a card click, just with a
  // specific subfolder under Personal.
  useEffect(() => {
    const openPersonal = (e: Event) => {
      const detail = (e as CustomEvent).detail as { folderPath?: string } | undefined;
      const target = detail?.folderPath
        ? detail.folderPath.replace(/\\/g, "/")
        : personalPath;
      if (!target) return;
      setRequestedNav((prev) => ({ path: target, key: (prev?.key ?? 0) + 1 }));
      initialSavedPathRef.current = null;
    };
    window.addEventListener("tl-dashboard-open-personal", openPersonal);
    return () => window.removeEventListener("tl-dashboard-open-personal", openPersonal);
  }, [personalPath]);

  // Don't mount WebFileManager until we actually have a path to give it.
  // For Personal that means waiting on getConfig(); for Samples the root is
  // a literal so `ready` flips true immediately.
  const ready = resolvedInitialPath !== "";

  return (
    <div ref={setCardsContainer} className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Folder cards — always visible, horizontal 50/50.
          Layout swaps at COMFORTABLE_LAYOUT_WIDTH: wide containers get
          the original vertical icon-on-top look (more breathing room);
          narrow gets the compact horizontal row used everywhere else. */}
      <div className={cn("grid grid-cols-2 shrink-0", comfortable ? "gap-3" : "gap-2")}>
        {FOLDER_CARDS.map((card) => {
          const Icon = card.icon;
          const isActive = activeFolder === card.key;
          return (
            <Card
              key={card.key}
              className={cn(
                "cursor-pointer transition-all duration-150",
                isActive
                  ? "border-primary/70 bg-primary/5 shadow-sm"
                  : "border-border/40 hover:border-primary/40 hover:bg-accent/40"
              )}
              onClick={() => handleCardClick(card.key)}
            >
              {comfortable ? (
                <CardContent className="flex flex-col items-center gap-1.5 p-3 text-center">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors",
                      isActive ? "bg-primary/15" : "bg-primary/8"
                    )}
                  >
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-sm font-semibold leading-tight">
                      {card.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {card.description}
                    </div>
                  </div>
                </CardContent>
              ) : (
                <CardContent className="flex items-center gap-3 p-3 text-left">
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
                      isActive ? "bg-primary/15" : "bg-primary/8"
                    )}
                  >
                    <Icon className="h-[18px] w-[18px] text-primary" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="truncate text-sm font-semibold leading-none">
                      {card.label}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground leading-snug">
                      {card.description}
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      {/* File browser below the cards */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm">
        {/* During the brief ready=false window (typically <200ms while
            /v1/files/config resolves), render a skeleton that mirrors the
            shape WebFileManager will land in. A blank card felt like a flash
            of broken empty state; a two-row "Loading…" chip felt like the
            user had to wait twice. The animated skeleton is the third
            option: it tells the user something is coming AND it's already
            shaped like the final layout, so the swap to the real file list
            is barely perceptible. */}
        {ready ? (
          <WebFileManager key={requestedNav?.key ?? 0} initialPath={resolvedInitialPath} />
        ) : (
          <FileManagerSkeleton />
        )}
      </div>
    </div>
  );
};

/**
 * Lightweight skeleton shown while the dashboard is still resolving its
 * landing path (config round-trip on Personal). Visually mirrors what
 * WebFileManager will mount into so the swap is barely perceptible:
 *   - a thin header row (back chevron, breadcrumb pills, action buttons)
 *   - a few file rows underneath
 * Uses Tailwind's `animate-pulse` for the shimmer; no external dep needed.
 */
const FileManagerSkeleton: React.FC = () => (
  <div
    className="flex h-full min-h-0 w-full animate-pulse flex-col p-4"
    aria-hidden
    role="presentation"
  >
    {/* Header row — chevron + breadcrumb + actions */}
    <div className="flex items-center gap-3">
      <div className="h-7 w-7 rounded-md bg-muted/70" />
      <div className="h-4 w-32 rounded bg-muted/70" />
      <div className="ml-auto flex items-center gap-2">
        <div className="h-9 w-24 rounded-md bg-muted/70" />
        <div className="h-9 w-24 rounded-md bg-muted/70" />
        <div className="h-9 w-9 rounded-md bg-muted/70" />
      </div>
    </div>

    {/* Spacer + file list rows */}
    <div className="mt-6 flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-5 w-5 rounded bg-muted/70" />
          <div className="h-4 flex-1 rounded bg-muted/60" style={{ maxWidth: `${65 - i * 7}%` }} />
          <div className="h-4 w-14 rounded bg-muted/40" />
          <div className="h-4 w-20 rounded bg-muted/40" />
        </div>
      ))}
    </div>
  </div>
);

export default StorageFolderCards;
