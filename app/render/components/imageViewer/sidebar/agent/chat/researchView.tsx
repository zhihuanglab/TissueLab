/**
 * Small display pieces of the Research panel: the markdown it renders, status
 * dots, the error box, and the plain-language names it shows for internal ones.
 */
import React, { useState } from "react"
import { marked, type Token, type Tokens } from "marked"
import type { ToolCallEntry } from "./researchRunState"
import { Check, Loader2, X, ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/utils/common/twMerge"

// Parse Markdown with the existing library, then render React elements so raw
// HTML in generated findings cannot execute in the application.
export function renderMarkdown(text: string): React.ReactNode[] {
  return markdownNodes(marked.lexer(text, { gfm: true, breaks: false }))
}

function markdownNodes(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, key) => {
    const children = () => markdownNodes("tokens" in token ? token.tokens || [] : [])
    switch (token.type) {
      case "space":
      case "def": return null
      case "heading": {
        const Tag = `h${token.depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
        return <Tag key={key} className={cn("font-semibold text-foreground mt-3 mb-1 first:mt-0", token.depth === 1 ? "text-base" : token.depth === 2 ? "text-sm" : "text-xs")}>{children()}</Tag>
      }
      case "paragraph": return <p key={key} className="my-1.5 break-words">{children()}</p>
      case "text": return <React.Fragment key={key}>{token.tokens ? children() : token.text}</React.Fragment>
      case "strong": return <strong key={key} className="font-semibold">{children()}</strong>
      case "em": return <em key={key}>{children()}</em>
      case "del": return <del key={key}>{children()}</del>
      case "codespan": return <code key={key} className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-[11px] break-all">{token.text}</code>
      case "code": return <pre key={key} className="my-2 rounded-md bg-muted/50 p-2 overflow-x-auto text-[11px]"><code>{token.text}</code></pre>
      case "br": return <br key={key} />
      case "hr": return <hr key={key} className="my-3 border-border" />
      case "blockquote": return <blockquote key={key} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children()}</blockquote>
      case "list": {
        const Tag = token.ordered ? "ol" : "ul"
        return <Tag key={key} start={token.ordered ? Number(token.start) : undefined} className={cn("list-outside pl-4 space-y-0.5 my-1.5", token.ordered ? "list-decimal" : "list-disc")}>
          {token.items.map((item: Tokens.ListItem, i: number) => <li key={i}>
            {item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label={item.checked ? "Completed" : "Incomplete"} className="mr-1" />}
            {markdownNodes(item.tokens)}
          </li>)}
        </Tag>
      }
      case "table": return <div key={key} role="region" aria-label="Findings table" tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-md border border-border/60">
        <table className="w-full border-collapse text-[11px] leading-relaxed">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>{token.header.map((cell: Tokens.TableCell, i: number) => <th key={i} scope="col" style={{ textAlign: token.align[i] || "left" }} className="px-2.5 py-2 font-medium whitespace-nowrap border-b border-border/60">{markdownNodes(cell.tokens)}</th>)}</tr>
          </thead>
          <tbody>{token.rows.map((row: Tokens.TableCell[], i: number) => <tr key={i} className="even:bg-muted/20">
            {row.map((cell, j) => <td key={j} style={{ textAlign: token.align[j] || "left" }} className="px-2.5 py-2 align-top border-b border-border/40 break-words [overflow-wrap:anywhere] min-w-[5rem] max-w-[16rem] tabular-nums">{markdownNodes(cell.tokens)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      case "link": {
        let safe = false
        try { safe = ["https:", "http:", "mailto:"].includes(new URL(token.href, "https://localhost/").protocol) } catch { /* Show invalid links as text. */ }
        return safe ? <a key={key} href={token.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 break-words">{children()}</a> : <React.Fragment key={key}>{children()}</React.Fragment>
      }
      case "image": return <React.Fragment key={key}>{token.text}</React.Fragment>
      default: return <React.Fragment key={key}>{("text" in token ? token.text : undefined) || token.raw}</React.Fragment>
    }
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


export function ResearchToolStep({ entry }: { entry: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false)
  const preview = (entry.thought || entry.command || `Step ${entry.turnId}`).replace(/\s+/g, " ")
  return <div className="text-[11px] min-w-0">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 w-full text-left py-1 hover:bg-muted/40 rounded">
      <StatusDot size="sm" status={entry.status === "running" ? "running" : entry.status === "done" ? "ok" : entry.status === "stopped" ? "none" : "failed"} />
      <span className="text-foreground truncate flex-1 min-w-0">{preview}</span>
      {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
    </button>
    {expanded && <div className="ml-5 space-y-2 rounded border border-border/40 bg-background p-2">
      <pre aria-label="Full command" className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-72 overflow-auto">{entry.command || "No command recorded."}</pre>
      {entry.exitCode !== undefined && <div className={entry.exitCode ? "text-red-500" : "text-muted-foreground"}>Exit code: {entry.exitCode}</div>}
      {entry.stdout && <div><div className="text-muted-foreground">Output</div><pre className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-48 overflow-auto">{entry.stdout}</pre></div>}
      {entry.stderr && <div><div className="text-red-500">Error output</div><pre className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-48 overflow-auto">{entry.stderr}</pre></div>}
    </div>}
    {!expanded && entry.exitCode !== undefined && entry.exitCode !== 0 && <div className="pl-5 text-[10px] text-red-500">this step failed</div>}
  </div>
}
