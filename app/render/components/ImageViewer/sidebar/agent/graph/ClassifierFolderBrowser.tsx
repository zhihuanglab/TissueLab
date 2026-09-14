"use client"

import React from "react"
import { ChevronRight, CornerLeftUp, FileCog, Folder, Globe, HardDrive, Loader2 } from "lucide-react"
import { getConfig, listFiles } from "@/services/fileManager.service"
import { getClassifierModelNames } from "@/services/classifier/storage"
import { classifierMatchesNode, folderClassifierOptionsFromFileList } from "@/utils/agent/graph/classifiers"
import { isZarr } from "@/utils/dashboard/fileType.utils"
import type { FolderClassifierOption, GraphNode } from "@/types/graph.types"

/** One listing entry, normalized across web / desktop sources. */
type BrowserEntry = { name: string; path: string; is_dir: boolean }

/** Same batch size the dashboard uses, so a big folder isn't silently cut short. */
const LIST_LIMIT = 1000

const toPosix = (p: string) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "")

/**
 * One tight list row. The picker is a file list, not a gallery — a card per
 * entry made even a handful of classifiers fill the dialog, and the path line
 * only repeated what the breadcrumb already says.
 */
const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs leading-5 text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"

/**
 * Absolute-ish path for a listing entry. Samples come back with `path` relative
 * to the listed folder (`CMU-files`, not `samples/CMU-files`), so anything that
 * is not already under `base` is re-joined onto it — otherwise drilling into a
 * Samples folder would list a path the backend can't resolve.
 */
const resolveEntryPath = (entry: BrowserEntry, base: string, isWebMode: boolean): string => {
  const raw = isWebMode ? toPosix(entry.path || "") : (entry.path || "").replace(/[/\\]+$/, "")
  const root = isWebMode ? toPosix(base) : (base || "").replace(/[/\\]+$/, "")
  if (!root) return raw || entry.name
  const sep = !isWebMode && root.includes("\\") ? "\\" : "/"
  if (raw && (raw === root || raw.startsWith(`${root}${sep}`))) return raw
  return `${root}${sep}${entry.name}`
}

/** Parent of a storage-relative path; "" once we're at a single segment. */
const parentOf = (p: string, isWebMode: boolean): string => {
  const raw = (p || "").trim()
  if (!raw) return ""
  const sep = !isWebMode && raw.includes("\\") ? "\\" : "/"
  const trimmed = raw.replace(/[/\\]+$/, "")
  const idx = trimmed.lastIndexOf(sep)
  if (idx <= 0) return ""
  return trimmed.slice(0, idx)
}

export interface ClassifierFolderBrowserProps {
  isWebMode: boolean
  /** Folder the dialog opens on — the file manager's current listing. */
  initialPath: string
  /**
   * `.tlcls` already known for `initialPath` (from the redux listing). Painted
   * immediately so opening the dialog on the current folder costs no wait; the
   * fetch replaces them as soon as it lands.
   */
  seedOptions: FolderClassifierOption[]
  /** Search text from the dialog's input — filters the current listing. */
  query: string
  /** Node the classifier will be loaded into; drives the model-compat filter. */
  node?: GraphNode | null
  /** A community download is in flight — freeze the rows. */
  disabled: boolean
  /** Bumped by the dialog's Refresh button to force a re-list. */
  refreshToken: number
  onPick: (option: FolderClassifierOption) => void
}

/**
 * Multi-level `.tlcls` picker for the Load Classifier dialog.
 *
 * The dialog used to show only what the file manager happened to be listing, so
 * loading a classifier from anywhere else meant navigating the sidebar first
 * and reopening. This browses on its own: workspace roots (Personal / Samples
 * in web mode), folder drill-down, and breadcrumb back-out.
 */
const ClassifierFolderBrowser: React.FC<ClassifierFolderBrowserProps> = ({
  isWebMode,
  initialPath,
  seedOptions,
  query,
  node,
  disabled,
  refreshToken,
  onPick,
}) => {
  const [path, setPath] = React.useState<string>(() => (isWebMode ? toPosix(initialPath) : initialPath))
  const [entries, setEntries] = React.useState<BrowserEntry[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [personalRoot, setPersonalRoot] = React.useState<string>("")

  // Reopening the dialog on a different folder should start there again.
  React.useEffect(() => {
    setPath(isWebMode ? toPosix(initialPath) : initialPath)
  }, [initialPath, isWebMode])

  React.useEffect(() => {
    if (!isWebMode) return
    let cancelled = false
    getConfig()
      .then((cfg: { defaultPath?: string } | null) => {
        if (!cancelled) setPersonalRoot(toPosix(cfg?.defaultPath || ""))
      })
      .catch(() => {
        /* roots chip just stays hidden */
      })
    return () => {
      cancelled = true
    }
  }, [isWebMode])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async (): Promise<BrowserEntry[]> => {
      if (isWebMode) {
        const result = await listFiles(path, 0, LIST_LIMIT)
        const items = (Array.isArray(result) ? result : result?.items || []) as BrowserEntry[]
        return items.map((e) => ({ ...e, path: resolveEntryPath(e, path, true) }))
      }
      const electron = (window as unknown as { electron?: { listLocalFiles?: (p: string) => Promise<BrowserEntry[]> } })
        .electron
      if (!electron?.listLocalFiles) return []
      const local = (await electron.listLocalFiles(path)) || []
      return local.map((e) => ({ ...e, path: resolveEntryPath(e, path, false) }))
    }

    load()
      .then((rows) => {
        if (!cancelled) setEntries(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([])
          setError("Couldn't list this folder.")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [path, isWebMode, refreshToken])

  const atInitialPath = (isWebMode ? toPosix(initialPath) : initialPath) === path
  /** Seed rows keep the dialog populated during the very first fetch. */
  const classifierOptions = React.useMemo<FolderClassifierOption[]>(() => {
    if (entries === null) return atInitialPath ? seedOptions : []
    return folderClassifierOptionsFromFileList(entries, path, isWebMode)
  }, [entries, path, isWebMode, atInitialPath, seedOptions])

  const folderRows = React.useMemo<BrowserEntry[]>(() => {
    if (!entries) return []
    return entries
      // `.zarr` stores are directories on disk but never hold classifiers —
      // they'd be dead ends in the picker.
      .filter((e) => e.is_dir && e.name !== ".." && !isZarr(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  }, [entries])

  // `.tlcls` files carry no model info in a listing, so read each one's tag and
  // hide the ones trained for a different model (untagged → shown everywhere).
  const [modelMap, setModelMap] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    if (!node?.modelId) {
      setModelMap({})
      return
    }
    const paths = classifierOptions.map((c) => c.path).filter(Boolean)
    if (!paths.length) {
      setModelMap({})
      return
    }
    let cancelled = false
    getClassifierModelNames(paths).then((m) => {
      if (!cancelled) setModelMap(m)
    })
    return () => {
      cancelled = true
    }
  }, [classifierOptions, node])

  const q = query.trim().toLowerCase()
  const visibleClassifiers = classifierOptions.filter((c) => {
    const matchesQ = !q || c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)
    const matchesModel = classifierMatchesNode({ modelId: modelMap[c.path] || "", factory: undefined }, node)
    return matchesQ && matchesModel
  })
  const visibleFolders = folderRows.filter((f) => !q || f.name.toLowerCase().includes(q))

  const parent = parentOf(path, isWebMode)
  // In web mode `users/<uid>` is the top of the personal tree — don't offer to
  // step above it into `users`, which lists nothing the user can read.
  const canGoUp =
    !!parent &&
    !(isWebMode && personalRoot && toPosix(path) === personalRoot) &&
    !(isWebMode && /^users$/i.test(parent))

  const roots: Array<{ key: string; label: string; path: string; icon: React.ElementType }> = isWebMode
    ? [
        ...(personalRoot ? [{ key: "personal", label: "Personal", path: personalRoot, icon: HardDrive }] : []),
        { key: "samples", label: "Samples", path: "samples", icon: Globe },
      ]
    : []

  const crumbs = React.useMemo<Array<{ label: string; path: string }>>(() => {
    const norm = isWebMode ? toPosix(path) : path
    if (!norm) return []
    // Collapse `users/<uid>` into one "Personal" crumb — the uid is noise.
    if (isWebMode && personalRoot && (norm === personalRoot || norm.startsWith(`${personalRoot}/`))) {
      const rest = norm.slice(personalRoot.length).replace(/^\/+/, "")
      const out = [{ label: "Personal", path: personalRoot }]
      let acc = personalRoot
      for (const seg of rest ? rest.split("/") : []) {
        acc = `${acc}/${seg}`
        out.push({ label: seg, path: acc })
      }
      return out
    }
    const sep = !isWebMode && norm.includes("\\") ? "\\" : "/"
    const segs = norm.split(sep).filter(Boolean)
    let acc = ""
    return segs.map((seg, i) => {
      acc = i === 0 ? seg : `${acc}${sep}${seg}`
      return { label: seg, path: acc }
    })
  }, [path, isWebMode, personalRoot])

  return (
    <div className="min-w-0 space-y-2">
      {roots.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-1">
          {roots.map((r) => {
            const Icon = r.icon
            const active = path === r.path || toPosix(path).startsWith(`${r.path}/`)
            return (
              <button
                key={r.key}
                type="button"
                disabled={disabled}
                onClick={() => setPath(r.path)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  active
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                <Icon className="h-3 w-3" />
                {r.label}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 pb-0.5 text-[10px] text-muted-foreground">
        {crumbs.length === 0 ? (
          <span className="font-mono opacity-70">/</span>
        ) : (
          crumbs.map((c, i) => (
            <React.Fragment key={`${c.path}-${i}`}>
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />}
              <button
                type="button"
                disabled={disabled || i === crumbs.length - 1}
                onClick={() => setPath(c.path)}
                className="max-w-[12rem] shrink-0 truncate rounded px-1 py-0.5 font-mono transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default disabled:font-semibold disabled:text-foreground"
                title={c.path}
              >
                {c.label}
              </button>
            </React.Fragment>
          ))
        )}
        {loading && <Loader2 className="ml-1 h-3 w-3 shrink-0 animate-spin opacity-70" />}
      </div>

      <div className="flex flex-col">
        {canGoUp && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPath(parent)}
            className={ROW_CLASS}
          >
            <CornerLeftUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">..</span>
          </button>
        )}

        {visibleFolders.map((f) => (
          <button
            key={`dir:${f.path}`}
            type="button"
            disabled={disabled}
            onClick={() => setPath(f.path)}
            className={ROW_CLASS}
            title={f.path}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}

        {visibleClassifiers.map((c) => (
          <button
            key={c.path}
            type="button"
            disabled={disabled}
            onClick={() => onPick(c)}
            className={ROW_CLASS}
            title={c.path}
          >
            <FileCog className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{c.name}</span>
          </button>
        ))}
      </div>

      {!loading && visibleFolders.length === 0 && visibleClassifiers.length === 0 && (
        <div className="px-1 py-2 text-xs text-muted-foreground">
          {error
            ? error
            : q
              ? "Nothing here matches your search."
              : "No .tlcls or subfolders here. Use the breadcrumb or the workspace chips above to look elsewhere."}
        </div>
      )}
    </div>
  )
}

export default ClassifierFolderBrowser
