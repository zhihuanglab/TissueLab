"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useSelector, useDispatch } from "react-redux"
import { RootState } from "@/store"
import { setFilterHighlightIndices } from "@/store/slices/viewer/shapeSlice"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/utils/common/apiFetch"
import { getErrorMessage } from "@/utils/common/apiResponse"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { formatPath } from "@/utils/pathUtils"
import { getDefaultOutputPath } from "@/utils/workflowUtils"
import { isPublicReadOnlyPath, getRestrictedDirectoryMessage } from "@/utils/sampleDirectoryUtils"
import { toast } from "sonner"
import EventBus from "@/utils/EventBus"
import { Save } from "lucide-react"
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices"
import type { SelectedClass, ShapeCoords } from "./FilterContent"

export type DistributionControlProps = {
  selectedClass: SelectedClass
  shapeCoords: ShapeCoords | null
  instanceId?: string | null
}

const CHART_MARGINS = { top: 8, right: 8, bottom: 20, left: 28 }
const CHART_HEIGHT = 140
const THRESHOLD_HANDLE_HIT = 12
const HISTOGRAM_BINS = 20

/** Build 20-bin histogram from raw probability list (bins [0,0.05), ..., [0.95,1]). */
function binProbsToHistogram(probs: number[], numBins = HISTOGRAM_BINS): number[] {
  const hist = new Array(numBins).fill(0)
  const step = 1 / numBins
  for (const p of probs) {
    const v = Math.max(0, Math.min(1, p))
    const i = Math.min(Math.floor(v / step), numBins - 1)
    hist[i]++
  }
  return hist
}

function getThemeColor(varName: string): string {
  if (typeof document === "undefined") return "hsl(0,0%,50%)"
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (val.startsWith("hsl")) return val
  if (val) return `hsl(${val})`
  return "hsl(0,0%,50%)"
}

function drawProbabilityCurve(
  canvas: HTMLCanvasElement,
  hist: number[],
  width: number,
  threshold: number
) {
  const ctx = canvas.getContext("2d")
  if (!ctx || hist.length === 0) return
  const height = CHART_HEIGHT
  const chartW = width - CHART_MARGINS.left - CHART_MARGINS.right
  const chartH = height - CHART_MARGINS.top - CHART_MARGINS.bottom
  if (chartW <= 0 || chartH <= 0) return

  const barFill = getThemeColor("--muted")
  const curveColor = getThemeColor("--primary")
  const axisColor = getThemeColor("--border")
  const textColor = getThemeColor("--muted-foreground")
  const thresholdColor = getThemeColor("--primary")

  ctx.clearRect(0, 0, width, height)
  const maxCount = Math.max(...hist, 1)
  const barW = chartW / hist.length

  // Bars (theme-aware fill)
  ctx.fillStyle = barFill
  for (let i = 0; i < hist.length; i++) {
    const h = (hist[i] / maxCount) * chartH
    const x = CHART_MARGINS.left + i * barW
    const y = CHART_MARGINS.top + chartH - h
    ctx.fillRect(x, y, Math.max(1, barW - 1), h)
  }

  // Smooth curve line (theme-aware)
  const points = 64
  const xs = Array.from({ length: points }, (_, i) => i / (points - 1))
  const binW = 1 / hist.length
  const smoothed = xs.map((x) => {
    const bi = Math.min(Math.floor(x / binW), hist.length - 1)
    const b0 = hist[bi] ?? 0
    const b1 = hist[Math.min(bi + 1, hist.length - 1)] ?? 0
    const t = (x / binW) % 1
    return b0 * (1 - t) + b1 * t
  })
  const maxS = Math.max(...smoothed, 1e-6)
  const pathY = smoothed.map((v) => CHART_MARGINS.top + chartH - (v / maxS) * chartH)
  const pathX = xs.map((x) => CHART_MARGINS.left + x * chartW)

  ctx.strokeStyle = curveColor
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(pathX[0], pathY[0])
  for (let i = 1; i < pathX.length; i++) {
    ctx.lineTo(pathX[i], pathY[i])
  }
  ctx.stroke()

  // Axes (theme-aware)
  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(CHART_MARGINS.left, CHART_MARGINS.top)
  ctx.lineTo(CHART_MARGINS.left, CHART_MARGINS.top + chartH)
  ctx.lineTo(CHART_MARGINS.left + chartW, CHART_MARGINS.top + chartH)
  ctx.stroke()

  // Threshold line + handle (draggable)
  const tx = CHART_MARGINS.left + Math.max(0, Math.min(1, threshold)) * chartW
  ctx.strokeStyle = thresholdColor
  ctx.lineWidth = 2
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(tx, CHART_MARGINS.top)
  ctx.lineTo(tx, CHART_MARGINS.top + chartH)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = thresholdColor
  ctx.beginPath()
  ctx.arc(tx, CHART_MARGINS.top, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = axisColor
  ctx.lineWidth = 1
  ctx.stroke()

  // X labels (theme-aware)
  ctx.fillStyle = textColor
  ctx.font = "10px sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  const labelY = CHART_MARGINS.top + chartH + 4
  ctx.fillText("0", CHART_MARGINS.left, labelY)
  ctx.fillText("0.5", CHART_MARGINS.left + chartW / 2, labelY)
  ctx.fillText("1", CHART_MARGINS.left + chartW, labelY)
}

export function chartXToThreshold(canvas: HTMLCanvasElement, clientX: number): number {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const x = (clientX - rect.left) * scaleX
  const chartW = canvas.width - CHART_MARGINS.left - CHART_MARGINS.right
  if (chartW <= 0) return 0.5
  const t = (x - CHART_MARGINS.left) / chartW
  return Math.max(0, Math.min(1, t))
}

/** Hit-test: is (clientX, clientY) near the threshold line at current threshold. */
function isNearThresholdLine(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  threshold: number
): boolean {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  const x = (clientX - rect.left) * scaleX
  const y = (clientY - rect.top) * scaleY
  const chartW = canvas.width - CHART_MARGINS.left - CHART_MARGINS.right
  const chartH = CHART_HEIGHT - CHART_MARGINS.top - CHART_MARGINS.bottom
  const tx = CHART_MARGINS.left + Math.max(0, Math.min(1, threshold)) * chartW
  const inVerticalRange = y >= CHART_MARGINS.top && y <= CHART_MARGINS.top + chartH
  return Math.abs(x - tx) <= THRESHOLD_HANDLE_HIT && inVerticalRange
}

export default function DistributionControl({
  selectedClass,
  shapeCoords,
  instanceId = null,
}: {
  selectedClass: SelectedClass
  shapeCoords: ShapeCoords | null
  instanceId?: string | null
}) {
  const dispatch = useDispatch()
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)
  const [chartWidth, setChartWidth] = useState(260)

  const [probHist, setProbHist] = useState<number[]>([])
  const [regionProbs, setRegionProbs] = useState<number[]>([])
  const [regionIndices, setRegionIndices] = useState<number[]>([])
  const [threshold, setThreshold] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateThresholdFromClientX = useCallback((clientX: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const t = chartXToThreshold(canvas, clientX)
    setThreshold(t)
  }, [])

  const [isDragging, setIsDragging] = useState(false)

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas || probHist.length === 0) return
      if (!isNearThresholdLine(canvas, e.clientX, e.clientY, threshold)) return
      isDraggingRef.current = true
      setIsDragging(true)
      updateThresholdFromClientX(e.clientX)
    },
    [threshold, probHist.length, updateThresholdFromClientX]
  )

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current) return
      updateThresholdFromClientX(e.clientX)
    },
    [updateThresholdFromClientX]
  )

  const endDrag = useCallback(() => {
    isDraggingRef.current = false
    setIsDragging(false)
  }, [])

  const handleCanvasMouseUp = useCallback(() => {
    endDrag()
  }, [endDrag])

  const handleCanvasMouseLeave = useCallback(() => {
    endDrag()
  }, [endDrag])

  // Global mouse up so dragging outside canvas still ends drag
  useEffect(() => {
    const onGlobalMouseUp = () => {
      if (isDraggingRef.current) setIsDragging(false)
      isDraggingRef.current = false
    }
    document.addEventListener("mouseup", onGlobalMouseUp)
    return () => document.removeEventListener("mouseup", onGlobalMouseUp)
  }, [])

  // Global mouse move when dragging so threshold follows cursor outside canvas
  useEffect(() => {
    if (!isDragging) return
    const onGlobalMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) updateThresholdFromClientX(e.clientX)
    }
    document.addEventListener("mousemove", onGlobalMouseMove)
    return () => document.removeEventListener("mousemove", onGlobalMouseMove)
  }, [isDragging, updateThresholdFromClientX])

  const fetchRegionProbabilityHistogram = useCallback(async () => {
    if (selectedClass.source !== "nuclei" || !shapeCoords || !currentPath) {
      setProbHist([])
      return
    }
    setLoading(true)
    setError(null)
    const formattedPath = formatPath(currentPath)
    const start_x = shapeCoords.x1
    const start_y = shapeCoords.y1
    const end_x = shapeCoords.x2
    const end_y = shapeCoords.y2
    const class_id = selectedClass.index
    try {
      const resp = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/region_probability_histogram?file_path=${encodeURIComponent(formattedPath)}&start_x=${start_x}&start_y=${start_y}&end_x=${end_x}&end_y=${end_y}&class_id=${class_id}`,
        { method: "GET", returnAxiosFormat: true }
      )
      const data = resp?.data?.data ?? resp?.data
      if (data?.probs && Array.isArray(data.probs)) {
        const probs = data.probs as number[]
        const indices = (data?.indices && Array.isArray(data.indices)) ? (data.indices as number[]) : []
        setRegionProbs(probs)
        setRegionIndices(indices.length === probs.length ? indices : [])
        setProbHist(binProbsToHistogram(probs))
      } else {
        setRegionProbs([])
        setRegionIndices([])
        setProbHist([])
      }
    } catch (e) {
      setError(getErrorMessage(e, "Failed to load probability distribution"))
      setRegionProbs([])
      setRegionIndices([])
      setProbHist([])
    } finally {
      setLoading(false)
    }
  }, [selectedClass.source, selectedClass.index, shapeCoords, currentPath])

  useEffect(() => {
    if (selectedClass.source === "nuclei" && shapeCoords && selectedClass.index >= -1) {
      void fetchRegionProbabilityHistogram()
    } else {
      setProbHist([])
      setRegionProbs([])
      setRegionIndices([])
      setError(null)
      dispatch(setFilterHighlightIndices([]))
    }
  }, [selectedClass.source, shapeCoords, fetchRegionProbabilityHistogram, dispatch])

  // Sync cell highlight to overlay: only this class + prob >= threshold get yellow highlight and contour
  useEffect(() => {
    if (regionProbs.length === 0 || regionIndices.length !== regionProbs.length) {
      dispatch(setFilterHighlightIndices([]))
      return
    }
    const highlight: number[] = []
    for (let i = 0; i < regionProbs.length; i++) {
      if (regionProbs[i] >= threshold) highlight.push(regionIndices[i])
    }
    dispatch(setFilterHighlightIndices(highlight))
  }, [threshold, regionProbs, regionIndices, dispatch])

  // Note: Clearing filterHighlightIndices to null on popup close is done by FilterContent unmount.

  const formattedPath = formatPath(currentPath ?? "")
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices()

  const saveHighlightedAsAnnotation = useCallback(async () => {
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage("save annotation"))
      return
    }
    if (!instanceId) {
      toast.error("Session not available. Cannot save annotation.")
      return
    }
    if (!shapeCoords || regionProbs.length === 0 || regionIndices.length !== regionProbs.length) {
      toast.error("No region or probability data. Cannot save.")
      return
    }
    const highlight: number[] = []
    for (let i = 0; i < regionProbs.length; i++) {
      if (regionProbs[i] >= threshold) highlight.push(regionIndices[i])
    }
    if (highlight.length === 0) {
      toast("No highlighted cells to save (try lowering the threshold).")
      return
    }
    setSaving(true)
    try {
      const payload = {
        path: getDefaultOutputPath(formattedPath),
        annotation_type: "nuclei",
        x1: shapeCoords.x1,
        y1: shapeCoords.y1,
        x2: shapeCoords.x2,
        y2: shapeCoords.y2,
        cell_indices: highlight,
      }
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "X-Instance-ID": instanceId },
        returnAxiosFormat: true,
      })
      const markedCount = resp?.data?.data?.marked_count ?? resp?.data?.marked_count ?? 0
      if (markedCount > 0) {
        toast.success(`Saved ${markedCount} annotation(s) as ground truth`)
        EventBus.emit("refresh-annotations")
        EventBus.emit("refresh-websocket-path", { path: formattedPath, forceReload: true })
        refreshGtHighlightIndices()
      } else {
        toast("No new annotations saved (cells may already be user annotations).")
      }
    } catch (err) {
      const msg = getErrorMessage(err, "")
      if (msg.includes("sample") || msg.includes("restricted")) {
        toast.error(getRestrictedDirectoryMessage("save annotation"))
      } else {
        toast.error(getErrorMessage(err, "Failed to save annotations."))
      }
    } finally {
      setSaving(false)
    }
  }, [
    currentPath,
    instanceId,
    shapeCoords,
    regionProbs,
    regionIndices,
    threshold,
    formattedPath,
    refreshGtHighlightIndices,
  ])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setChartWidth(Math.max(200, el.offsetWidth - 16))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || probHist.length === 0) return
    drawProbabilityCurve(canvas, probHist, chartWidth, threshold)
  }, [probHist, chartWidth, threshold])

  if (selectedClass.source === "tissue") {
    return (
      <div className="min-h-[80px] text-xs text-muted-foreground">
        Distribution: coming soon
      </div>
    )
  }

  if (selectedClass.source !== "nuclei") {
    return <div className="min-h-[80px]" />
  }

  if (!shapeCoords) {
    return (
      <div className="min-h-[80px] text-xs text-muted-foreground">
        No region selected
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-[120px] flex items-center justify-center text-xs text-muted-foreground">
        Loading distribution…
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-[80px] text-xs text-destructive">
        {error}
      </div>
    )
  }

  const hasData = probHist.length > 0 && probHist.some((v) => v > 0)
  if (!hasData) {
    return (
      <div className="min-h-[80px] text-xs text-muted-foreground">
        No probability data in this region for this class
      </div>
    )
  }

  return (
    <div ref={containerRef} className="w-full flex flex-col gap-1">
      <div className="text-xs text-muted-foreground shrink-0">
        Probability distribution (in region)
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        Current threshold: <span className="font-medium text-foreground">{threshold.toFixed(3)}</span>
      </div>
      <div className="flex-1 min-h-[100px]">
        <canvas
          ref={canvasRef}
          width={chartWidth}
          height={CHART_HEIGHT}
          className="w-full rounded border border-border cursor-ew-resize"
          style={{ maxWidth: "100%" }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseLeave}
        />
      </div>
      <div className="shrink-0 flex justify-end">
        <Button
          variant="default"
          size="sm"
          className="text-xs h-7"
          disabled={saving || regionProbs.length === 0}
          onClick={() => void saveHighlightedAsAnnotation()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {saving ? "Saving…" : "Save annotation"}
        </Button>
      </div>
    </div>
  )
}
