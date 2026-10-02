/**
 * Small display pieces of the Research panel: the markdown it renders, status
 * dots, the error box, and the plain-language names it shows for internal ones.
 */
import React from "react"
import { Check, Loader2, X } from "lucide-react"
import { cn } from "@/utils/common/twMerge"

// ─── Lightweight markdown renderer ───────────────────────────────────────────

export function renderMarkdown(text: string): React.ReactNode[] {
  const elements: React.ReactNode[] = []
  const lines = text.split("\n")
  let bullets: string[] = []
  let key = 0

  const flush = () => {
    if (bullets.length === 0) return
    elements.push(
      <ul key={key++} className="list-disc list-outside pl-4 space-y-0.5 my-1">
        {bullets.map((b, i) => <li key={i}>{inlineFormat(b)}</li>)}
      </ul>
    )
    bullets = []
  }

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("## ")) {
      flush()
      elements.push(<h2 key={key++} className="text-sm font-bold text-foreground mt-3 mb-1 first:mt-0">{inlineFormat(t.slice(3))}</h2>)
    } else if (t.startsWith("# ")) {
      flush()
      elements.push(<h1 key={key++} className="text-base font-bold text-foreground mt-3 mb-1 first:mt-0">{inlineFormat(t.slice(2))}</h1>)
    } else if (t.startsWith("### ")) {
      flush()
      elements.push(<h3 key={key++} className="text-xs font-semibold text-foreground mt-2 mb-0.5">{inlineFormat(t.slice(4))}</h3>)
    } else if (t.startsWith("- ") || t.startsWith("* ")) {
      bullets.push(t.slice(2))
    } else if (t === "---") {
      flush()
      elements.push(<hr key={key++} className="my-2 border-border" />)
    } else if (t.length > 0) {
      flush()
      elements.push(<p key={key++} className="my-0.5">{inlineFormat(line)}</p>)
    } else {
      flush()
    }
  }
  flush()
  return elements
}

function inlineFormat(text: string): React.ReactNode {
  // Split on inline patterns: **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((seg, i) => {
    if (seg.startsWith("**") && seg.endsWith("**"))
      return <strong key={i} className="font-semibold">{seg.slice(2, -2)}</strong>
    if (seg.startsWith("*") && seg.endsWith("*") && seg.length >= 3)
      return <em key={i}>{seg.slice(1, -1)}</em>
    if (seg.startsWith("`") && seg.endsWith("`"))
      return <code key={i} className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">{seg.slice(1, -1)}</code>
    return seg
  })
}

// ─── Status pieces ───────────────────────────────────────────────────────────

/** A row's status: spinner, check, cross, or an empty ring (stopped / not started). "sm" is a tool-call row. */
export function StatusDot({ status, size = "md" }: { status: "running" | "ok" | "failed" | "none"; size?: "md" | "sm" }) {
  const box = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"
  if (status === "running") {
    return <Loader2 className={cn(box, "animate-spin", size === "md" ? "text-primary" : "text-muted-foreground")} />
  }
  if (status === "none") return <div className={cn(box, "rounded-full border-2 border-border")} />
  const Icon = status === "ok" ? Check : X
  const bg = status === "ok"
    ? (size === "md" ? "bg-primary" : "bg-green-500/80")
    : (size === "md" ? "bg-red-500" : "bg-red-500/80")
  return (
    <div className={cn(box, "rounded-full flex items-center justify-center", bg)}>
      <Icon className={cn(size === "md" ? "h-2 w-2" : "h-1.5 w-1.5", "text-white")} strokeWidth={4} />
    </div>
  )
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{children}</div>
}

// ─── Plain-language names ────────────────────────────────────────────────────

/** "proposer" → "Planning ideas"; "round_0001_worker_2" → "Analysis 2" (a lone worker is "Analysis 1"). */
export function workerLabel(name: string): string {
  if (name === "proposer") return "Planning ideas"
  const m = name.match(/worker(?:_(\d+))?$/)
  return m ? `Analysis ${m[1] ?? 1}` : name
}

/** Elapsed milliseconds as mm:ss (h:mm:ss from an hour). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`
}
