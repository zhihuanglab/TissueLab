import React from 'react'

/**
 * WorkflowAnatomy
 *
 * A compact, refined UML-style illustration for the Community page:
 *
 *   - A WORKFLOW is a container, drawn as a rounded SQUARE, holding tools that
 *     branch and merge. Input fans out to Cell segmentation and a Tissue
 *     classifier; the cell branch runs a Cell classifier; both merge into
 *     Analysis, then a Report.
 *   - A TOOL / MODEL is a CIRCLE. Only intermediate tools that run a model
 *     carry a CLASSIFIER (Cell seg, Cell clf, Tissue clf). Analysis is a tool
 *     too but has no classifier, so it stays a bare circle.
 *   - A CLASSIFIER is an equilateral TRIANGLE inside a tool circle.
 *   - Input and Output are NOT tools, so they are solid rounded squares.
 *
 * The second panel shows the "one tool, many classifiers" idea: a tool maps to
 * several classifiers and the agent selects the best fit for the query (which
 * can also be chosen manually).
 *
 * The two panels are capped in size and sit side-by-side so the block stays
 * short (about half its previous height). Dependency-free: inline SVG + Tailwind.
 */

// Points of an equilateral triangle (apex up) centered at (cx, cy), side `s`.
function tri(cx: number, cy: number, s: number): string {
  const h = (s * Math.sqrt(3)) / 2
  return `${cx},${cy - (2 * h) / 3} ${cx - s / 2},${cy + h / 3} ${cx + s / 2},${cy + h / 3}`
}

type Kind = 'io' | 'tool' | 'model' // io = Input/Report, tool = circle (no classifier), model = circle + classifier
type GraphNode = { id: string; label: string; x: number; y: number; kind: Kind }

const R = 27 // circle radius / nominal node radius for edge trimming

// Branch + merge laid out to sit inside a square workflow container.
const NODES: GraphNode[] = [
  { id: 'input', label: 'Input', x: 62, y: 192, kind: 'io' },
  { id: 'seg', label: 'Cell seg', x: 142, y: 96, kind: 'model' },
  // Cell seg fans out to two cell classifiers (tumor + lymphocytes) in parallel.
  { id: 'tumor', label: 'Cell clf · Tumor', x: 228, y: 60, kind: 'model' },
  { id: 'lymph', label: 'Cell clf · Lymph', x: 228, y: 150, kind: 'model' },
  // Separate tissue-classifier branch, targeting epithelium.
  { id: 'tissue', label: 'Tissue clf · Epithelial', x: 142, y: 290, kind: 'model' },
  { id: 'analysis', label: 'Analysis', x: 320, y: 200, kind: 'tool' },
  { id: 'report', label: 'Report', x: 320, y: 306, kind: 'io' },
]

const EDGES: Array<[string, string]> = [
  ['input', 'seg'],
  ['input', 'tissue'],
  ['seg', 'tumor'],
  ['seg', 'lymph'],
  ['tumor', 'analysis'],
  ['lymph', 'analysis'],
  ['tissue', 'analysis'],
  ['analysis', 'report'],
]

const byId = (id: string) => NODES.find((n) => n.id === id) as GraphNode

// Trim an edge so it runs node-edge -> node-edge (small gap for the arrowhead).
function edge(fromId: string, toId: string) {
  const a = byId(fromId)
  const b = byId(toId)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy) || 1
  const ux = dx / d
  const uy = dy / d
  return {
    x1: a.x + (R + 3) * ux,
    y1: a.y + (R + 3) * uy,
    x2: b.x - (R + 10) * ux,
    y2: b.y - (R + 10) * uy,
  }
}

function NodeShape({ n }: { n: GraphNode }) {
  if (n.kind === 'io') {
    return (
      <g filter="url(#wa-softShadow)">
        <rect
          x={n.x - 33}
          y={n.y - 19}
          width={66}
          height={38}
          rx={12}
          className="fill-slate-100 stroke-slate-300/70 dark:fill-gray-700 dark:stroke-gray-600/70"
          strokeWidth={1}
        />
        <text
          x={n.x}
          y={n.y + 5}
          textAnchor="middle"
          className="fill-slate-600 text-[14px] font-medium dark:fill-gray-200"
        >
          {n.label}
        </text>
      </g>
    )
  }

  return (
    <g>
      <circle
        cx={n.x}
        cy={n.y}
        r={R}
        filter="url(#wa-softShadow)"
        className="fill-white stroke-gray-200/80 dark:fill-gray-800 dark:stroke-gray-700"
        strokeWidth={1}
      />
      {n.kind === 'model' && (
        <polygon
          points={tri(n.x, n.y + 1, R * 0.86)}
          className="fill-none stroke-gray-500 dark:stroke-gray-400"
          strokeWidth={1.25}
          strokeLinejoin="round"
        />
      )}
      <text
        x={n.x}
        y={n.y + R + 18}
        textAnchor="middle"
        className="fill-gray-500 text-[14px] font-medium dark:fill-gray-400"
      >
        {n.label}
      </text>
    </g>
  )
}

// Panel 2: one tool maps to several candidate classifiers; for this query the
// agent suggests two of the five — the tumor and lymphocyte cell classifiers.
const CANDIDATES = [40, 86, 132, 178, 224]
const SUGGESTED: { index: number; label: string }[] = [
  { index: 1, label: 'Tumor' },
  { index: 3, label: 'Lymph' },
]
const isSuggested = (i: number) => SUGGESTED.some((s) => s.index === i)

export default function WorkflowAnatomy() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-linear-to-b from-white to-gray-50/60 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_28px_-18px_rgba(15,23,42,0.18)] dark:border-white/[0.08] dark:from-gray-900 dark:to-gray-950 md:p-5">
      {/* soft ambient accent glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 -z-0 h-40 w-[34rem] -translate-x-1/2 rounded-full bg-indigo-400/10 blur-3xl dark:bg-indigo-500/10"
      />

      {/* Heading */}
      <div className="relative mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
          <h3 className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-50">
            How a study fits together
          </h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          A workflow holds tools; some tools run a classifier — branching and merging into a report.
        </p>
      </div>

      <div className="relative grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1.4fr_1fr]">
        {/* ---- Panel 1: UML workflow graph inside a SQUARE container ---- */}
        <figure className="flex flex-col rounded-xl border border-black/[0.05] bg-white/70 p-2.5 backdrop-blur-sm dark:border-white/[0.06] dark:bg-white/[0.02]">
          <figcaption className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
            The workflow
          </figcaption>
          <div className="flex flex-1 items-center justify-center">
            <svg
              viewBox="0 0 380 384"
              className="h-auto w-full max-w-[320px]"
              role="img"
              aria-label="A square workflow container: an input feeds cell segmentation, which fans out to two cell classifiers (tumor cells and lymphocytes) in parallel; a separate tissue classifier targets epithelium; all branches merge into analysis, then a report. Classifier tools carry a triangle; input and output are rounded squares."
            >
              <defs>
                <filter id="wa-softShadow" x="-40%" y="-40%" width="180%" height="180%">
                  <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#0f172a" floodOpacity="0.12" />
                </filter>
                <linearGradient id="wa-square" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity="0.07" />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity="0.015" />
                </linearGradient>
                <marker
                  id="wa-arrow"
                  viewBox="0 0 10 10"
                  refX="7.5"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 1 1.5 L 8 5 L 1 8.5"
                    className="fill-none stroke-gray-400 dark:stroke-gray-500"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </marker>
              </defs>

              {/* WORKFLOW -> rounded square container */}
              <rect
                x={20}
                y={22}
                width={340}
                height={340}
                rx={28}
                fill="url(#wa-square)"
                className="stroke-indigo-400/55 dark:stroke-indigo-400/40"
                strokeWidth={1.25}
              />
              <g>
                <rect
                  x={34}
                  y={34}
                  width={104}
                  height={22}
                  rx={11}
                  className="fill-indigo-500/10 dark:fill-indigo-400/15"
                />
                <text
                  x={86}
                  y={49}
                  textAnchor="middle"
                  className="fill-indigo-600 text-[10px] font-semibold uppercase tracking-[0.18em] dark:fill-indigo-300"
                >
                  Workflow
                </text>
              </g>

              {/* edges */}
              {EDGES.map(([f, t]) => {
                const e = edge(f, t)
                return (
                  <line
                    key={`${f}-${t}`}
                    x1={e.x1}
                    y1={e.y1}
                    x2={e.x2}
                    y2={e.y2}
                    className="stroke-gray-300 dark:stroke-gray-600"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    markerEnd="url(#wa-arrow)"
                  />
                )
              })}

              {/* nodes */}
              {NODES.map((n) => (
                <NodeShape key={n.id} n={n} />
              ))}
            </svg>
          </div>
        </figure>

        {/* ---- Panel 2: one tool -> many classifiers, agent-selected ---- */}
        <figure className="flex flex-col rounded-xl border border-black/[0.05] bg-white/70 p-2.5 backdrop-blur-sm dark:border-white/[0.06] dark:bg-white/[0.02]">
          <figcaption className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Agentic selection
          </figcaption>
          <div className="flex flex-1 items-center justify-center">
            <svg
              viewBox="0 0 264 196"
              className="h-auto w-full max-w-[260px]"
              role="img"
              aria-label="One tool links to many candidate classifiers; for this query the agent suggests two of five — the tumor and lymphocyte cell classifiers — and you can adjust manually."
            >
              <defs>
                <filter id="wa-softShadow2" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="2" stdDeviation="2.6" floodColor="#0f172a" floodOpacity="0.12" />
                </filter>
              </defs>

              {CANDIDATES.map((cx, i) => (
                <line
                  key={`lnk-${i}`}
                  x1={132}
                  y1={68}
                  x2={cx}
                  y2={138}
                  className={
                    isSuggested(i)
                      ? 'stroke-indigo-400 dark:stroke-indigo-400'
                      : 'stroke-gray-300 dark:stroke-gray-600'
                  }
                  strokeWidth={isSuggested(i) ? 1.75 : 1}
                  strokeLinecap="round"
                  strokeDasharray={isSuggested(i) ? undefined : '2.5 3.5'}
                />
              ))}

              <circle
                cx={132}
                cy={42}
                r={25}
                filter="url(#wa-softShadow2)"
                className="fill-white stroke-gray-200/80 dark:fill-gray-800 dark:stroke-gray-700"
                strokeWidth={1}
              />
              <text
                x={132}
                y={46}
                textAnchor="middle"
                className="fill-gray-500 text-[10px] font-semibold uppercase tracking-wider dark:fill-gray-400"
              >
                Tool
              </text>

              {CANDIDATES.map((cx, i) => (
                <g key={`cand-${i}`}>
                  {isSuggested(i) && (
                    <circle
                      cx={cx}
                      cy={156}
                      r={19}
                      className="fill-indigo-500/5 stroke-indigo-400"
                      strokeWidth={1.4}
                      strokeDasharray="2.5 2.5"
                    />
                  )}
                  <polygon
                    points={tri(cx, 159, 22)}
                    className={
                      isSuggested(i)
                        ? 'fill-none stroke-gray-600 dark:stroke-gray-300'
                        : 'fill-none stroke-gray-400/60 dark:stroke-gray-500/60'
                    }
                    strokeWidth={isSuggested(i) ? 1.4 : 1}
                    strokeLinejoin="round"
                  />
                </g>
              ))}

              {SUGGESTED.map((s) => (
                <g key={`sug-${s.index}`}>
                  <rect
                    x={CANDIDATES[s.index] - 26}
                    y={182}
                    width={52}
                    height={14}
                    rx={7}
                    className="fill-indigo-500/10 dark:fill-indigo-400/15"
                  />
                  <text
                    x={CANDIDATES[s.index]}
                    y={192}
                    textAnchor="middle"
                    className="fill-indigo-600 text-[8.5px] font-semibold uppercase tracking-wider dark:fill-indigo-300"
                  >
                    {s.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <p className="px-1 pt-2 text-center text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            A tool can map to many classifiers — for this query the agent suggests two of five (the tumor and
            lymphocyte cell classifiers), and you can adjust manually.
          </p>
        </figure>
      </div>

      {/* legend */}
      <div className="relative mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-black/[0.05] pt-3 text-xs text-gray-500 dark:border-white/[0.06] dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-[4px] border border-indigo-400/70 bg-indigo-500/10 dark:border-indigo-400/60" />
          <span className="font-medium text-gray-600 dark:text-gray-300">Workflow</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-[4px] border border-slate-300 bg-slate-100 shadow-sm dark:border-gray-600 dark:bg-gray-700" />
          <span className="font-medium text-gray-600 dark:text-gray-300">Input / Output</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-full border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800" />
          <span className="font-medium text-gray-600 dark:text-gray-300">Tool / Model</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="13" height="11" viewBox="0 0 13 11" aria-hidden className="shrink-0">
            <polygon
              points="6.5,1 1,10 12,10"
              className="fill-none stroke-gray-500 dark:stroke-gray-400"
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-medium text-gray-600 dark:text-gray-300">Classifier</span>
        </span>
      </div>
    </div>
  )
}
