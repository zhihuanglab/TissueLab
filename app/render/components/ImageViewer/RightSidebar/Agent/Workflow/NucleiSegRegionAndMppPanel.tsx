"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext"
import { AppDispatch, RootState } from "@/store"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { RectangleCoords } from "@/store/slices/viewer/shapeSlice"
import { DrawingTool, setTool } from "@/store/slices/viewer/toolSlice"
import EventBus from "@/utils/EventBus"
import { Info, Loader2 } from "lucide-react"
import Image from "next/image"
import React, { useCallback, useEffect, useRef, useState } from "react"
import { LiaDrawPolygonSolid } from "react-icons/lia"
import { PiRectangle } from "react-icons/pi"
import { useDispatch, useSelector } from "react-redux"

export interface NucleiSegRegionAndMppPanelProps {
  panel: WorkflowPanel
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void
  /** Workflow graph dock: hide Run/Cancel (graph runs the pipeline). */
  showRunControls?: boolean
  isRunning?: boolean
  isCancelling?: boolean
  onRun?: () => void
  onCancel?: () => void
  className?: string
}

const rectsEqual = (a: RectangleCoords | null, b: RectangleCoords | null) => {
  if (!a || !b) return false
  return (
    Math.abs(a.x1 - b.x1) < 1e-6 &&
    Math.abs(a.y1 - b.y1) < 1e-6 &&
    Math.abs(a.x2 - b.x2) < 1e-6 &&
    Math.abs(a.y2 - b.y2) < 1e-6
  )
}

const makePolyKey = (pts?: [number, number][]) =>
  pts && pts.length ? pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(";") : ""

/**
 * Region preview (rectangle / polygon), target MPP, and drawing tools — same behavior as the
 * classic Workflow “Cell Segmentation + Embedding” card, without classifier or extra prompt rows.
 */
export function NucleiSegRegionAndMppPanel({
  panel,
  onContentChange,
  showRunControls = false,
  isRunning = false,
  isCancelling = false,
  onRun,
  onCancel,
  className,
}: NucleiSegRegionAndMppPanelProps) {
  const dispatch = useDispatch<AppDispatch>()
  const targetMppItem = panel.content.find((item) => item.key === "target_mpp")

  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions)
  const shapeData = useSelector((state: RootState) => state.shape.shapeData)
  const [liveRectangleCoords, setLiveRectangleCoords] = useState<RectangleCoords | null>(
    shapeData?.rectangleCoords || null
  )
  const context = useAnnotatorInstance()
  const viewer = context.viewerInstance
  const [frozenThumbnail, setFrozenThumbnail] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastCaptureRef = useRef<{ rect: RectangleCoords | null; polyKey: string } | null>(null)

  useEffect(() => {
    if (!shapeData?.rectangleCoords) {
      setFrozenThumbnail(null)
    }
  }, [shapeData])

  useEffect(() => {
    const handleShapeResizing = (payload: unknown) => {
      const rect: RectangleCoords | undefined =
        payload && typeof (payload as { x1?: unknown }).x1 === "number"
          ? (payload as RectangleCoords)
          : (payload as { rectangleCoords?: RectangleCoords })?.rectangleCoords

      if (rect && typeof rect.x1 === "number") {
        setLiveRectangleCoords((prev) => (rectsEqual(prev, rect) ? prev : rect))
      }
    }

    EventBus.on("shape-resizing", handleShapeResizing)

    return () => {
      EventBus.off("shape-resizing", handleShapeResizing)
    }
  }, [])

  useEffect(() => {
    const next = shapeData?.rectangleCoords || null
    setLiveRectangleCoords((prev) => (rectsEqual(prev, next) ? prev : next))
  }, [shapeData])

  const [osdReady, setOsdReady] = useState(false)

  useEffect(() => {
    if (!viewer) return
    const handleOpen = () => setOsdReady(true)
    if (viewer.world && viewer.world.getItemCount() > 0) {
      setOsdReady(true)
    }
    viewer.addHandler("open", handleOpen)
    return () => {
      viewer.removeHandler("open", handleOpen as never)
    }
  }, [viewer])

  const drawThumbnail = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const canvasWidth = canvas.width
    const canvasHeight = canvas.height

    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim()
    ctx.fillStyle = `hsl(${mutedColor})`
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    const hasSelection = viewer && liveRectangleCoords && osdReady && slideDimensions
    if (!hasSelection) {
      setFrozenThumbnail(null)
      return
    }

    const tiledImage = viewer.world.getItemAt(0)
    if (!tiledImage) {
      setFrozenThumbnail(null)
      return
    }

    const contentSize = tiledImage.getContentSize()
    if (contentSize.x === 0 || contentSize.y === 0) {
      setFrozenThumbnail(null)
      return
    }

    let rasterCanvas: HTMLCanvasElement | null =
      (viewer as { drawer?: { canvas?: HTMLCanvasElement; glCanvas?: HTMLCanvasElement } }).drawer?.canvas ||
      (viewer as { drawer?: { canvas?: HTMLCanvasElement; glCanvas?: HTMLCanvasElement } }).drawer?.glCanvas ||
      null
    if (!rasterCanvas) {
      rasterCanvas = viewer.container?.querySelector<HTMLCanvasElement>("canvas.openseadragon-canvas") || null
    }
    if (!rasterCanvas || !(rasterCanvas instanceof HTMLCanvasElement)) {
      setFrozenThumbnail(null)
      return
    }

    const containerRect = viewer.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1

    let imgX1 = liveRectangleCoords.x1
    let imgY1 = liveRectangleCoords.y1
    let imgX2 = liveRectangleCoords.x2
    let imgY2 = liveRectangleCoords.y2

    const maxX = contentSize.x
    const maxY = contentSize.y
    imgX1 = Math.max(0, Math.min(maxX, imgX1))
    imgX2 = Math.max(0, Math.min(maxX, imgX2))
    imgY1 = Math.max(0, Math.min(maxY, imgY1))
    imgY2 = Math.max(0, Math.min(maxY, imgY2))

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- OpenSeadragon is a viewer peer dependency
    const OpenSeadragon = require("openseadragon")
    if (!OpenSeadragon) {
      setFrozenThumbnail(null)
      return
    }
    const pointTL = new OpenSeadragon.Point(imgX1, imgY1)
    const pointBR = new OpenSeadragon.Point(imgX2, imgY2)
    const winTL = viewer.viewport.imageToWindowCoordinates(pointTL)
    const winBR = viewer.viewport.imageToWindowCoordinates(pointBR)

    if (!isFinite(winTL.x) || !isFinite(winTL.y) || !isFinite(winBR.x) || !isFinite(winBR.y)) {
      setFrozenThumbnail(null)
      return
    }

    let srcX = (winTL.x - containerRect.left) * dpr
    let srcY = (winTL.y - containerRect.top) * dpr
    let srcW = (winBR.x - winTL.x) * dpr
    let srcH = (winBR.y - winTL.y) * dpr

    srcX = Math.max(0, Math.min(rasterCanvas.width, srcX))
    srcY = Math.max(0, Math.min(rasterCanvas.height, srcY))
    srcW = Math.max(1, Math.min(rasterCanvas.width - srcX, srcW))
    srcH = Math.max(1, Math.min(rasterCanvas.height - srcY, srcH))

    if (srcW < 2 || srcH < 2) {
      setFrozenThumbnail(null)
      return
    }

    try {
      const imageRatio = srcW / srcH
      const canvasRatio = canvasWidth / canvasHeight

      let destWidth: number
      let destHeight: number
      let destX: number
      let destY: number

      if (imageRatio > canvasRatio) {
        destWidth = canvasWidth
        destHeight = canvasWidth / imageRatio
        destX = 0
        destY = (canvasHeight - destHeight) / 2
      } else {
        destHeight = canvasHeight
        destWidth = canvasHeight * imageRatio
        destY = 0
        destX = (canvasWidth - destWidth) / 2
      }

      if (shapeData?.polygonPoints) {
        ctx.save()
        ctx.beginPath()

        const rect = liveRectangleCoords

        shapeData.polygonPoints.forEach((point, index) => {
          const normalizedX = (point[0] - rect.x1) / (rect.x2 - rect.x1)
          const normalizedY = (point[1] - rect.y1) / (rect.y2 - rect.y1)
          const canvasX = destX + normalizedX * destWidth
          const canvasY = destY + normalizedY * destHeight

          if (index === 0) {
            ctx.moveTo(canvasX, canvasY)
          } else {
            ctx.lineTo(canvasX, canvasY)
          }
        })

        ctx.closePath()
        ctx.clip()
      }

      ctx.drawImage(rasterCanvas, srcX, srcY, srcW, srcH, destX, destY, destWidth, destHeight)

      if (shapeData?.polygonPoints) {
        ctx.restore()
        const primaryColor = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
        ctx.strokeStyle = `hsl(${primaryColor})`
        ctx.lineWidth = 2
        ctx.beginPath()
        const rect = liveRectangleCoords
        shapeData.polygonPoints.forEach((point, index) => {
          const normalizedX = (point[0] - rect.x1) / (rect.x2 - rect.x1)
          const normalizedY = (point[1] - rect.y1) / (rect.y2 - rect.y1)
          const canvasX = destX + normalizedX * destWidth
          const canvasY = destY + normalizedY * destHeight
          if (index === 0) ctx.moveTo(canvasX, canvasY)
          else ctx.lineTo(canvasX, canvasY)
        })
        ctx.closePath()
        ctx.stroke()
      } else if (shapeData?.rectangleCoords) {
        const primaryColor = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
        ctx.strokeStyle = `hsl(${primaryColor})`
        ctx.lineWidth = 2
        ctx.strokeRect(destX, destY, destWidth, destHeight)
      }

      setFrozenThumbnail(canvas.toDataURL())
    } catch (e) {
      console.error("Error drawing thumbnail:", e)
      setFrozenThumbnail(null)
    }
  }, [viewer, liveRectangleCoords, osdReady, slideDimensions, shapeData])

  useEffect(() => {
    const currentKey = {
      rect: liveRectangleCoords,
      polyKey: makePolyKey(shapeData?.polygonPoints),
    }

    if (!liveRectangleCoords) {
      setFrozenThumbnail(null)
      lastCaptureRef.current = null
      return
    }

    const last = lastCaptureRef.current
    const changed =
      !last || !rectsEqual(last.rect, currentKey.rect) || last.polyKey !== currentKey.polyKey

    if (!changed) return

    const timer = setTimeout(() => {
      drawThumbnail()
      lastCaptureRef.current = currentKey
    }, 100)

    return () => clearTimeout(timer)
  }, [liveRectangleCoords, drawThumbnail, shapeData?.polygonPoints])

  const handleInputChange = useCallback(
    (itemKey: string, value: string | unknown[]) => {
      onContentChange(panel.id, {
        ...panel,
        content: panel.content.map((contentItem) =>
          contentItem.key === itemKey ? { ...contentItem, value } : contentItem
        ),
      })
    },
    [onContentChange, panel]
  )

  const currentTool = useSelector((state: RootState) => state.tool.currentTool)
  const handleToolChange = (tool: DrawingTool) => {
    dispatch(setTool(tool))
  }

  return (
    <div className={className}>
      <div className="mt-1 flex flex-row gap-3">
        <div className="relative flex h-28 w-[120px] flex-shrink-0 items-center justify-center overflow-hidden rounded-sm border border-dashed border-border bg-muted/70">
          <canvas ref={canvasRef} width={120} height={112} className="absolute inset-0 hidden h-full w-full" />
          {frozenThumbnail ? (
            <Image
              src={frozenThumbnail}
              alt="Selected region preview"
              className="absolute inset-0 h-full w-full object-contain"
              width={120}
              height={112}
            />
          ) : (
            <span className="select-none px-2 text-center text-xs text-muted-foreground">Whole slide selected</span>
          )}
        </div>

        <div className="flex flex-1 flex-col">
          {targetMppItem && targetMppItem.type === "input" && (
            <div className="space-y-2">
              <Label
                htmlFor={`${panel.id}-${targetMppItem.key}`}
                className="flex items-center gap-1 text-xs font-medium text-foreground"
              >
                {targetMppItem.label || "Target MPP (µm/pixel)"}
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label="About target MPP"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-[220px] rounded-md border border-border bg-card p-2 text-xs text-foreground"
                    >
                      The target MPP (microns per pixel) lets you down-sample or up-sample the image before
                      segmentation. A lower number means higher resolution; a higher number speeds up processing by
                      sampling a coarser image.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id={`${panel.id}-${targetMppItem.key}`}
                type="text"
                value={typeof targetMppItem.value === "string" ? targetMppItem.value : ""}
                placeholder={targetMppItem.placeholder}
                onChange={(e) => handleInputChange(targetMppItem.key, e.target.value)}
                className="h-8 w-full rounded-[6px] text-sm placeholder:text-muted-foreground/40"
              />
            </div>
          )}

          <div className="mt-auto flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className={`h-5 w-5 rounded-[4px] border border-border ${
                  currentTool === "rectangle"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-transparent text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
                onClick={() => handleToolChange("rectangle")}
                title="Rectangle tool"
                type="button"
              >
                <PiRectangle className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className={`h-5 w-5 rounded-[4px] border border-border ${
                  currentTool === "polygon"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-transparent text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
                onClick={() => handleToolChange("polygon")}
                title="Polygon tool"
                type="button"
              >
                <LiaDrawPolygonSolid className="h-3 w-3" />
              </Button>
            </div>
            {showRunControls && (
              <div className="flex gap-2">
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={onCancel}
                    disabled={isCancelling}
                    className="h-6 w-20 border border-border text-xs"
                    type="button"
                  >
                    {isCancelling ? (
                      <>
                        <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                        Cancel
                      </>
                    ) : (
                      "Cancel"
                    )}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={onRun}
                    disabled={isRunning}
                    className="h-6 w-20 border border-border text-xs"
                    type="button"
                  >
                    Run
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
