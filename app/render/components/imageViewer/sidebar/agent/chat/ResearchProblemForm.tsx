import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileText, Loader2, RefreshCw, TableProperties } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/utils/common/twMerge"
import { CTRL_SERVICE_API_ENDPOINT } from "@/config/api.config"

/**
 * The research problem, picked instead of typed: the service scans the workspace
 * for cohort CSVs and sorts their columns into id / slide / outcome / covariate
 * candidates (/discovery/setup); the form writes problem.md's header from the
 * choices, and the user only writes the question. "Edit as text" shows the
 * problem.md itself for anything the form does not cover.
 */

const API = () => `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery`

// ProblemSpec defaults (discovery/problem.py): left out of the header.
const DEFAULTS = { cohort_file: "training_cohort.csv", id_column: "donor_id", slide_column: "slide_name", mpp_column: "mpp" }
const NONE = "__none__"

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
  excluded_classes: string[]
  exclude_only_classes: string[]
}
type Setup = {
  problem: { found: boolean; content: string; fields: ProblemFields | null; error: string | null }
  cohorts: Cohort[]
  slides: string[]
}
type AuthedFetch = (url: string, options: RequestInit) => Promise<{ ok: boolean; status: number; data: any }>

const yamlString = (value: string) => (/^[A-Za-z0-9_.\-/]+$/.test(value) ? value : JSON.stringify(value))
const yamlList = (values: string[]) => `[${values.map(yamlString).join(", ")}]`

/** problem.md from the form: only what differs from the defaults goes in the header. */
export function composeProblem(f: ProblemFields): string {
  const lines = [`outcome: ${yamlString(f.outcome)}`]
  if (f.covariates.length) lines.push(`covariates: ${yamlList(f.covariates)}`)
  if (f.cohort_file && f.cohort_file !== DEFAULTS.cohort_file) lines.push(`cohort_file: ${yamlString(f.cohort_file)}`)
  if (f.id_column && f.id_column !== DEFAULTS.id_column) lines.push(`id_column: ${yamlString(f.id_column)}`)
  if (f.slide_column && f.slide_column !== DEFAULTS.slide_column) lines.push(`slide_column: ${yamlString(f.slide_column)}`)
  if (f.mpp_column && f.mpp_column !== DEFAULTS.mpp_column) lines.push(`mpp_column: ${yamlString(f.mpp_column)}`)
  if (f.excluded_classes.length) lines.push(`excluded_classes: ${yamlList(f.excluded_classes)}`)
  if (f.exclude_only_classes.length) lines.push(`exclude_only_classes: ${yamlList(f.exclude_only_classes)}`)
  return `---\n${lines.join("\n")}\n---\n${f.question.trim()}\n`
}

const emptyFields = (): ProblemFields => ({
  outcome: "", question: "", covariates: [], ...DEFAULTS, excluded_classes: [], exclude_only_classes: [],
})

/** A cohort's detected layout, keeping the choices that still fit it. */
function fitToCohort(prev: ProblemFields, cohort: Cohort): ProblemFields {
  return {
    ...prev,
    cohort_file: cohort.file,
    id_column: cohort.id_column ?? prev.id_column,
    slide_column: cohort.slide_column ?? prev.slide_column,
    mpp_column: cohort.mpp_column ?? DEFAULTS.mpp_column,
    outcome: cohort.outcome_candidates.includes(prev.outcome) ? prev.outcome : "",
    covariates: prev.covariates.filter((c) => cohort.covariate_candidates.includes(c)),
  }
}

const fmt = (n?: number) => (n === undefined ? "" : Number.isInteger(n) ? String(n) : n.toPrecision(3))

const Hint: React.FC<{ tone?: "muted" | "warn"; children: React.ReactNode }> = ({ tone = "muted", children }) => (
  <div className={cn("text-[10px] mt-1", tone === "warn" ? "text-amber-600" : "text-muted-foreground")}>{children}</div>
)

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">{children}</label>
)

export interface ResearchProblemFormProps {
  workspaceDir: string
  authedFetch: AuthedFetch
  /** Bump to start over from the workspace's problem.md (the last run's problem: starting saves it). */
  resetKey: number
  /** The problem.md to submit, and whether it is complete enough to. */
  onChange: (text: string, ready: boolean) => void
}

export const ResearchProblemForm: React.FC<ResearchProblemFormProps> = ({ workspaceDir, authedFetch, resetKey, onChange }) => {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [fields, setFields] = useState<ProblemFields>(emptyFields)
  const [mode, setMode] = useState<"form" | "text">("form")
  const [rawText, setRawText] = useState("")
  const [creating, setCreating] = useState(false)
  // The user changed something: a rescan must not throw it away.
  const touchedRef = useRef(false)

  const cohort = setup?.cohorts.find((c) => c.file === fields.cohort_file) ?? null

  const load = useCallback(async (opts: { keepChoices: boolean }) => {
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
      if (opts.keepChoices && touchedRef.current) {
        setFields((prev) => {
          const same = next.cohorts.find((c) => c.file === prev.cohort_file)
          return same ? fitToCohort(prev, same) : prev
        })
        return
      }
      touchedRef.current = false
      if (next.problem.fields) {
        setMode("form")
        setFields(next.problem.fields)
        setNotice(null)
      } else if (next.problem.found && next.problem.content.trim()) {
        // A problem.md the form cannot hold: show it as it is.
        setMode("text")
        setRawText(next.problem.content)
        setNotice(`problem.md is shown as text: ${next.problem.error}`)
      } else {
        setMode("form")
        setFields(next.cohorts[0] ? fitToCohort(emptyFields(), next.cohorts[0]) : emptyFields())
        setNotice(null)
      }
    } catch (e: any) {
      setNotice(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [authedFetch, workspaceDir])

  useEffect(() => { load({ keepChoices: false }) }, [load, resetKey])

  const text = mode === "text" ? rawText : composeProblem(fields)
  const ready = mode === "text" ? rawText.trim().length > 0 : Boolean(fields.outcome && fields.question.trim())
  useEffect(() => { onChange(text, ready) }, [text, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch: Partial<ProblemFields>) => {
    touchedRef.current = true
    setFields((prev) => ({ ...prev, ...patch }))
  }

  const toText = () => {
    setRawText(composeProblem(fields))
    setNotice(null)
    setMode("text")
  }

  const toForm = async () => {
    const res = await authedFetch(`${API()}/problem/parse`, { method: "POST", body: JSON.stringify({ text: rawText }) })
    const parsed = res.data?.data
    if (parsed?.fields) {
      touchedRef.current = true
      setFields(parsed.fields as ProblemFields)
      setNotice(null)
      setMode("form")
    } else {
      setNotice(parsed?.error || "problem.md does not parse")
    }
  }

  const createCohort = async () => {
    setCreating(true)
    try {
      const res = await authedFetch(`${API()}/cohort/template`, { method: "POST", body: JSON.stringify({ data_dir: workspaceDir }) })
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Could not create the cohort file")
      await load({ keepChoices: false })
      setNotice(`Created ${res.data.data.file}: fill in the outcome column (one value per slide), then press Rescan.`)
    } catch (e: any) {
      setNotice(e?.message ?? String(e))
    } finally {
      setCreating(false)
    }
  }

  const columnOptions = useMemo(() => cohort?.columns.map((c) => c.name) ?? [], [cohort])
  const outcomeLabel = (name: string) => {
    const col = cohort?.columns.find((c) => c.name === name)
    return col?.numeric ? `${name}  (${fmt(col.min)} – ${fmt(col.max)})` : name
  }

  // ─── Text mode ─────────────────────────────────────────────────────────
  if (mode === "text") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-foreground">Research Problem (problem.md)</label>
          <button type="button" className="text-[11px] text-primary hover:underline flex items-center gap-1" onClick={toForm}>
            <TableProperties className="h-3 w-3" /> Use the form
          </button>
        </div>
        <Textarea
          aria-label="problem.md"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={"---\noutcome: <cohort column to predict>\n---\nThe research question..."}
          className="min-h-[180px] font-mono text-[13px] leading-relaxed resize-none border-border/60 bg-background"
        />
        {notice && <Hint tone="warn">{notice}</Hint>}
        <Hint>
          Header keys: outcome (required), covariates, cohort_file, id_column, slide_column, mpp_column,
          excluded_classes, exclude_only_classes. The text below the header is the question.
        </Hint>
      </div>
    )
  }

  // ─── Form mode ─────────────────────────────────────────────────────────
  const cohorts = setup?.cohorts ?? []
  const outcomeCandidates = cohort?.outcome_candidates ?? []
  const covariateCandidates = (cohort?.covariate_candidates ?? []).filter((c) => c !== fields.outcome)

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">Data</span>
          <button
            type="button"
            aria-label="Rescan workspace"
            title="Rescan the workspace (after editing the cohort file)"
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={!workspaceDir || loading}
            onClick={() => load({ keepChoices: true })}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>

        {!workspaceDir && (
          <Hint>Open a slide first: its folder is the workspace, which holds the cohort CSV and the analysed slides.</Hint>
        )}

        {workspaceDir && setup && cohorts.length === 0 && (
          <div className="space-y-2">
            <Hint tone="warn">
              No cohort CSV in this folder. Research needs one table with a row per patient: an ID, the path of
              that patient&apos;s analysed slide (.zarr), and the value to predict.
            </Hint>
            {setup.slides.length > 0 ? (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={creating} onClick={createCohort}>
                {creating && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Create {DEFAULTS.cohort_file} from the {setup.slides.length} slide{setup.slides.length > 1 ? "s" : ""} here
              </Button>
            ) : (
              <Hint>No analysed slides (.zarr) here either: run segmentation / classification on the slides first.</Hint>
            )}
          </div>
        )}

        {cohorts.length > 0 && (
          <>
            <div>
              <FieldLabel>Cohort table</FieldLabel>
              <Select
                value={cohort ? cohort.file : undefined}
                onValueChange={(file) => {
                  const next = cohorts.find((c) => c.file === file)
                  if (next) { touchedRef.current = true; setFields((prev) => fitToCohort(prev, next)) }
                }}
              >
                <SelectTrigger aria-label="Cohort table" className="h-8 text-xs"><SelectValue placeholder={`${fields.cohort_file} (not in this folder)`} /></SelectTrigger>
                <SelectContent>
                  {cohorts.map((c) => <SelectItem key={c.file} value={c.file} className="text-xs">{c.file}</SelectItem>)}
                </SelectContent>
              </Select>
              {cohort && (
                <Hint tone={cohort.slides_found < cohort.rows ? "warn" : "muted"}>
                  {cohort.rows} rows · {cohort.slides_found}/{cohort.rows} slides found in this folder
                  {cohort.slides_found < cohort.rows && " — check the slide paths of the others"}
                </Hint>
              )}
            </div>

            {cohort && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <FieldLabel>Patient ID column</FieldLabel>
                  <Select value={fields.id_column} onValueChange={(v) => update({ id_column: v })}>
                    <SelectTrigger aria-label="Patient ID column" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {columnOptions.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <FieldLabel>Slide column</FieldLabel>
                  <Select value={fields.slide_column} onValueChange={(v) => update({ slide_column: v })}>
                    <SelectTrigger aria-label="Slide column" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {columnOptions.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {cohort && (
              <div>
                <FieldLabel>Predict (outcome)</FieldLabel>
                <Select value={fields.outcome || undefined} onValueChange={(v) => update({ outcome: v })}>
                  <SelectTrigger aria-label="Outcome" className="h-8 text-xs"><SelectValue placeholder="Choose the column to predict" /></SelectTrigger>
                  <SelectContent>
                    {outcomeCandidates.map((c) => <SelectItem key={c} value={c} className="text-xs">{outcomeLabel(c)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {outcomeCandidates.length === 0 && (
                  <Hint tone="warn">
                    No column to predict yet: it must be numeric with a value in every row. Fill one in {cohort.file},
                    then press Rescan.
                  </Hint>
                )}
              </div>
            )}

            {cohort && covariateCandidates.length > 0 && (
              <div>
                <FieldLabel>Adjust for (optional)</FieldLabel>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Covariates">
                  {covariateCandidates.map((c) => {
                    const on = fields.covariates.includes(c)
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        onClick={() => update({ covariates: on ? fields.covariates.filter((x) => x !== c) : [...fields.covariates, c] })}
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
                <Hint>Confounders every comparison controls for, e.g. age or sex.</Hint>
              </div>
            )}
          </>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor="research-question">Research question</label>
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={toText}>
            <FileText className="h-3 w-3" /> Edit as text
          </button>
        </div>
        <Textarea
          id="research-question"
          value={fields.question}
          onChange={(e) => update({ question: e.target.value })}
          placeholder="e.g. Which tissue and cell-composition measurements predict the outcome?"
          className="min-h-[90px] text-[13px] leading-relaxed resize-none border-border/60 bg-background"
        />
        {notice && <Hint tone="warn">{notice}</Hint>}
        <Hint>
          Saved as <span className="font-mono">problem.md</span> in the workspace. The agents get the question and the
          column names — never the outcome or covariate values.
        </Hint>
      </div>
    </div>
  )
}

export default ResearchProblemForm
