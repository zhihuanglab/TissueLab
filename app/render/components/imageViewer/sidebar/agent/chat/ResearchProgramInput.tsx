import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, RefreshCw, Sparkles } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/utils/common/twMerge"
import { CTRL_SERVICE_API_ENDPOINT } from "@/config/api.config"

/**
 * The research program: one free-text box, as the panel always had. The judge
 * still has to know which cohort column to predict and which to adjust for, so
 * the service reads them off the text (/discovery/problem/resolve: the cohort's
 * column names, or the model given the names only) and the line under the box
 * shows what it found, to confirm or change. What is submitted is problem.md:
 * that header plus the text. A text that already starts with a `---` header is
 * problem.md itself and goes as written.
 */

const API = () => `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery`
const RESOLVE_DELAY_MS = 700

// ProblemSpec defaults (discovery/problem.py): left out of the header.
const DEFAULTS = { cohort_file: "training_cohort.csv", id_column: "donor_id", slide_column: "slide_name", mpp_column: "mpp" }

type Column = { name: string; numeric: boolean; missing: number; unique: number; examples: string[]; min?: number; max?: number }
type Cohort = {
  file: string
  rows: number
  columns: Column[]
  id_column: string | null
  slide_column: string | null
  mpp_column: string | null
  slides_found: number
  outcome_candidates: string[]
  covariate_candidates: string[]
}
type ProblemFields = {
  outcome: string
  question: string
  covariates: string[]
  cohort_file: string
  id_column: string
  slide_column: string
  mpp_column: string
}
type Setup = {
  problem: { found: boolean; content: string; fields: ProblemFields | null; error: string | null }
  cohorts: Cohort[]
}
type Resolved = {
  mode: "text" | "header"
  fields: ProblemFields | null
  detected_by: "text" | "model" | "header" | null
  covariates_by?: "text" | "model" | null
  error: string | null
}
type AuthedFetch = (url: string, options: RequestInit) => Promise<{ ok: boolean; status: number; data: any }>

const yamlString = (value: string) => (/^[A-Za-z0-9_.\-/]+$/.test(value) ? value : JSON.stringify(value))
const yamlList = (values: string[]) => `[${values.map(yamlString).join(", ")}]`

/** problem.md: only what differs from the defaults goes in the header. */
export function composeProblem(f: ProblemFields): string {
  const lines = [`outcome: ${yamlString(f.outcome)}`]
  if (f.covariates.length) lines.push(`covariates: ${yamlList(f.covariates)}`)
  if (f.cohort_file && f.cohort_file !== DEFAULTS.cohort_file) lines.push(`cohort_file: ${yamlString(f.cohort_file)}`)
  if (f.id_column && f.id_column !== DEFAULTS.id_column) lines.push(`id_column: ${yamlString(f.id_column)}`)
  if (f.slide_column && f.slide_column !== DEFAULTS.slide_column) lines.push(`slide_column: ${yamlString(f.slide_column)}`)
  if (f.mpp_column && f.mpp_column !== DEFAULTS.mpp_column) lines.push(`mpp_column: ${yamlString(f.mpp_column)}`)
  return `---\n${lines.join("\n")}\n---\n${f.question.trim()}\n`
}

const fmt = (n?: number) => (n === undefined ? "" : Number.isInteger(n) ? String(n) : n.toPrecision(3))

const Hint: React.FC<{ tone?: "muted" | "warn"; children: React.ReactNode }> = ({ tone = "muted", children }) => (
  <div className={cn("text-[10px] mt-1", tone === "warn" ? "text-amber-600" : "text-muted-foreground")}>{children}</div>
)

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">{children}</label>
)

export interface ResearchProgramInputProps {
  workspaceDir: string
  authedFetch: AuthedFetch
  /** Bump to start over from the workspace's problem.md (the last run's problem: starting saves it). */
  resetKey: number
  /** The problem.md to submit, and whether it is complete enough to. */
  onChange: (text: string, ready: boolean) => void
}

export const ResearchProgramInput: React.FC<ResearchProgramInputProps> = ({ workspaceDir, authedFetch, resetKey, onChange }) => {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState("")
  // Typed since the last reset: a (slow) workspace load must not overwrite it.
  const typedRef = useRef(false)
  // The header of the problem.md last saved here: what the text does not settle.
  const [saved, setSaved] = useState<Partial<ProblemFields>>({})
  // What the user picked under "Change": always wins.
  const [picked, setPicked] = useState<Partial<ProblemFields>>({})
  // The service's reading of the text, tagged with the input it answers.
  const [result, setResult] = useState<{ key: string; value: Resolved | null } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceDir) {
      setSetup(null)
      return
    }
    setLoading(true)
    try {
      const res = await authedFetch(`${API()}/setup?data_dir=${encodeURIComponent(workspaceDir)}`, { method: "GET" })
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Could not read the workspace")
      const next = res.data.data as Setup
      setSetup(next)
      setPicked({})
      setShowDetails(false)
      setNotice(null)
      if (next.problem.fields) {
        const { question, ...header } = next.problem.fields
        if (!typedRef.current) setText(question)
        setSaved(header)
      } else {
        // A problem.md the service cannot read stays as written (header and all).
        if (!typedRef.current) setText(next.problem.found ? next.problem.content : "")
        setSaved({})
      }
    } catch (e: any) {
      setNotice(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [authedFetch, workspaceDir])

  useEffect(() => {
    typedRef.current = false
    load()
  }, [load, resetKey])

  // Read the text against the cohort once typing pauses.
  const cohortChoice = picked.cohort_file ?? saved.cohort_file
  const active = Boolean(workspaceDir && text.trim() && (setup?.cohorts.length || text.trimStart().startsWith("---")))
  const key = JSON.stringify([workspaceDir, text, cohortChoice ?? null, setup?.cohorts.map((c) => c.file) ?? []])
  const resolving = active && result?.key !== key
  const resolved = active && result?.key === key ? result.value : null
  useEffect(() => {
    if (!active) return
    let stale = false
    const timer = setTimeout(async () => {
      let value: Resolved | null = null
      try {
        const res = await authedFetch(`${API()}/problem/resolve`, {
          method: "POST",
          body: JSON.stringify({ data_dir: workspaceDir, text, cohort_file: cohortChoice ?? null }),
        })
        if (res.data?.code === 0) value = res.data.data as Resolved
      } catch { /* shown as unresolved */ }
      if (!stale) setResult({ key, value })
    }, RESOLVE_DELAY_MS)
    return () => { stale = true; clearTimeout(timer) }
  }, [authedFetch, active, key]) // eslint-disable-line react-hooks/exhaustive-deps

  const isHeader = resolved?.mode === "header"
  const detected = !isHeader ? resolved?.fields ?? null : null
  const cohort = setup?.cohorts.find((c) => c.file === (cohortChoice ?? detected?.cohort_file)) ?? setup?.cohorts[0] ?? null

  // The problem as it will run: the user's picks, then what the text says, then the saved header.
  const effective: ProblemFields | null = useMemo(() => {
    if (!detected) return null
    const sameCohort = (saved.cohort_file ?? detected.cohort_file) === detected.cohort_file
    const fromSaved = sameCohort ? saved : {}
    const outcome = picked.outcome ?? (detected.outcome || fromSaved.outcome || "")
    const covariates = picked.covariates ?? (detected.covariates.length ? detected.covariates : fromSaved.covariates ?? [])
    return {
      ...detected,
      id_column: picked.id_column ?? fromSaved.id_column ?? detected.id_column,
      slide_column: picked.slide_column ?? fromSaved.slide_column ?? detected.slide_column,
      mpp_column: picked.mpp_column ?? fromSaved.mpp_column ?? detected.mpp_column,
      outcome,
      // the outcome is never also adjusted for (e.g. after picking a former covariate)
      covariates: covariates.filter((c) => c !== outcome),
      question: text.trim(),
    }
  }, [detected, saved, picked, text])

  const outcomeSource =
    picked.outcome ? "your choice"
      : detected?.outcome ? (resolved?.detected_by === "model" ? "chosen by AI" : "named in your text")
        : effective?.outcome ? "from the last saved problem.md"
          : null

  const task = isHeader ? text : effective ? composeProblem(effective) : ""
  const ready = !resolving && (isHeader ? Boolean(resolved?.fields) : Boolean(effective?.outcome && text.trim()))
  useEffect(() => { onChange(task, ready) }, [task, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (patch: Partial<ProblemFields>) => setPicked((prev) => ({ ...prev, ...patch }))
  // The text stays (typed, or problem.md's again); so do the picks.
  const rescan = async () => {
    const keep = picked
    await load()
    setPicked(keep)
  }

  const outcomeLabel = (name: string) => {
    const col = cohort?.columns.find((c) => c.name === name)
    return col?.numeric ? `${name}  (${fmt(col.min)} – ${fmt(col.max)})` : name
  }
  const example = cohort?.outcome_candidates[0] ?? "the outcome"
  const covariateCandidates = (cohort?.covariate_candidates ?? []).filter((c) => c !== effective?.outcome)
  const needsOutcome = Boolean(!isHeader && text.trim() && !resolving && resolved && !effective?.outcome && cohort)
  const detailsOpen = showDetails || needsOutcome

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-semibold text-foreground" htmlFor="research-program">Research Program</label>
        {workspaceDir && (
          <button
            type="button"
            aria-label="Rescan workspace"
            title="Rescan the workspace (after editing the cohort file)"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={loading}
            onClick={rescan}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <Textarea
        id="research-program"
        value={text}
        onChange={(e) => {
          typedRef.current = true
          setText(e.target.value)
        }}
        placeholder={"Describe the research program: what to look for in these slides.\nNo need to name the outcome or covariates; they are chosen from the cohort table and shown below."}
        className="min-h-[150px] text-[13px] leading-relaxed resize-none border-border/60 focus:border-primary/50 focus:ring-primary/20 bg-background"
      />

      {/* What the text amounts to on this folder's data (nothing to show: no box) */}
      {(!workspaceDir || isHeader || cohort) && (
      <div className="mt-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px] space-y-2" data-testid="program-summary">
        {!workspaceDir && (
          <div className="text-muted-foreground">Open a slide first: its folder is the workspace, which holds the cohort table and the analysed slides.</div>
        )}

        {isHeader && (
          resolved?.fields
            ? <div className="text-muted-foreground">Using the problem.md header as written: predict <b className="text-foreground">{resolved.fields.outcome}</b>.</div>
            : <div className="text-amber-600">{resolved?.error}</div>
        )}

        {!isHeader && cohort && (
          <>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0 text-muted-foreground">
                {resolving ? (
                  <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Reading your program…</span>
                ) : effective?.outcome ? (
                  <>
                    Predict <b className="text-foreground">{effective.outcome}</b>
                    {effective.covariates.length > 0 && <> · adjust for <span className="text-foreground">{effective.covariates.join(", ")}</span></>}
                    {outcomeSource && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-[10px]">
                        {resolved?.detected_by === "model" && !picked.outcome && <Sparkles className="h-2.5 w-2.5" />}({outcomeSource})
                      </span>
                    )}
                  </>
                ) : (
                  <span>Could not choose a column to predict: pick one below, or name it in the program (e.g. &quot;predict {example}&quot;).</span>
                )}
                <div className="text-[10px] mt-0.5">
                  {cohort.file} · {cohort.rows} patients · {cohort.slides_found} slides found
                  {cohort.slides_found < cohort.rows && <span className="text-amber-600"> — check the other slide paths</span>}
                </div>
              </div>
              {!needsOutcome && (
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline shrink-0"
                  onClick={() => setShowDetails((v) => !v)}
                >
                  {showDetails ? "Done" : "Change"}
                </button>
              )}
            </div>

            {detailsOpen && (
              <div className="space-y-2 border-t border-border/60 pt-2">
                {needsOutcome && <div className="text-amber-600">Which column should it predict?</div>}
                <div>
                  <FieldLabel>Predict (outcome)</FieldLabel>
                  <Select value={effective?.outcome || undefined} onValueChange={(v) => pick({ outcome: v })}>
                    <SelectTrigger aria-label="Outcome" className="h-8 text-xs"><SelectValue placeholder="Choose the column to predict" /></SelectTrigger>
                    <SelectContent>
                      {cohort.outcome_candidates.map((c) => <SelectItem key={c} value={c} className="text-xs">{outcomeLabel(c)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {cohort.outcome_candidates.length === 0 && (
                    <Hint tone="warn">No column can be predicted yet: it must be numeric with a value in every row. Fill one in {cohort.file}, then Rescan.</Hint>
                  )}
                </div>
                {covariateCandidates.length > 0 && (
                  <div>
                    <FieldLabel>Adjust for (optional)</FieldLabel>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Covariates">
                      {covariateCandidates.map((c) => {
                        const current = effective?.covariates ?? []
                        const on = current.includes(c)
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={on}
                            onClick={() => pick({ covariates: on ? current.filter((x) => x !== c) : [...current, c] })}
                            className={cn(
                              "px-2 py-0.5 rounded-full border text-[11px] transition-colors",
                              on ? "bg-primary/10 border-primary/40 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                            )}
                          >
                            {c}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      )}

      {notice && <Hint tone="warn">{notice}</Hint>}
      <Hint>
        Saved as <span className="font-mono">problem.md</span> in your workspace. The agents get this text and the
        column names — never the values to predict.
      </Hint>
    </div>
  )
}

export default ResearchProgramInput
