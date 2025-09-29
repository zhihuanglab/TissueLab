"use client";
import React, { useRef, useEffect, useState } from "react";
import Image from "next/image";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState } from "@/store";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { setIsRunning } from "@/store/slices/workflowSlice";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chatSlice";
import http from "@/utils/http";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { formatPath } from "@/utils/pathUtils";
import { WorkflowPanel } from "@/store/slices/workflowSlice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ContentRenderer } from "./ContentRenderer"; // Assuming ContentRenderer is in the same directory
import { Info } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import EventBus from "@/utils/EventBus";
import { RectangleCoords } from "@/store/slices/shapeSlice";
import { CButton } from "@coreui/react";
import CIcon from "@coreui/icons-react";
import { cilMediaPlay } from "@coreui/icons";
import { setTool, DrawingTool } from "@/store/slices/toolSlice";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";

interface CellSegmentationPanelContentProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
}

const ZOOM_SCALE = 16; // same constant as in viewer component

export const CellSegmentationPanelContent: React.FC<CellSegmentationPanelContentProps> = ({
  panel,
  onContentChange,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const targetMppItem = panel.content.find(item => item.key === 'target_mpp');
  const otherContentItems = panel.content.filter(item => item.key !== 'prompt' && item.key !== 'target_mpp' && item.key !== 'organ' && item.key !== 'path');

  // path
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

  // --- Thumbnail drawing ---
  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);
  const [liveRectangleCoords, setLiveRectangleCoords] = useState<RectangleCoords | null>(shapeData?.rectangleCoords || null);
  const context = useAnnotatorInstance();
  const viewer = context.viewerInstance;
  const [frozenThumbnail, setFrozenThumbnail] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

// Track the last captured geometry so we don't overwrite a good snapshot
const lastCaptureRef = useRef<{ rect: RectangleCoords | null; polyKey: string } | null>(null);

const rectsEqual = (a: RectangleCoords | null, b: RectangleCoords | null) => {
  if (!a || !b) return false;
  return (
    Math.abs(a.x1 - b.x1) < 1e-6 &&
    Math.abs(a.y1 - b.y1) < 1e-6 &&
    Math.abs(a.x2 - b.x2) < 1e-6 &&
    Math.abs(a.y2 - b.y2) < 1e-6
  );
};

const makePolyKey = (pts?: [number, number][]) =>
  pts && pts.length
    ? pts.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(';')
    : '';

  useEffect(() => {
    // When there's no selection, clear the frozen thumbnail
    if (!shapeData?.rectangleCoords) {
      setFrozenThumbnail(null);
    }
  }, [shapeData]);

  useEffect(() => {
    const handleShapeResizing = (payload: any) => {
      // payload can be { x1, y1, x2, y2 } OR { rectangleCoords, polygonPoints }
      const rect: RectangleCoords | undefined =
        payload && typeof payload.x1 === 'number'
          ? payload
          : payload?.rectangleCoords;

      if (rect && typeof rect.x1 === 'number') {
        setLiveRectangleCoords(prev => (rectsEqual(prev, rect) ? prev : rect));
      }
    };

    EventBus.on('shape-resizing', handleShapeResizing);

    return () => {
        EventBus.off('shape-resizing', handleShapeResizing);
    };
  }, []);

  useEffect(() => {
  const next = shapeData?.rectangleCoords || null;
  setLiveRectangleCoords(prev => (rectsEqual(prev, next) ? prev : next));
}, [shapeData]);

  const [osdReady, setOsdReady] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    const handleOpen = () => setOsdReady(true);
    if (viewer.world && viewer.world.getItemCount() > 0) {
      setOsdReady(true);
    }
    viewer.addHandler("open", handleOpen);
    return () => {
      viewer.removeHandler("open", handleOpen as any);
    };
  }, [viewer]);

  const drawThumbnail = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Always clear and fill canvas with a gray background
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = "#e5e7eb"; // gray-200
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const hasSelection = viewer && liveRectangleCoords && osdReady && slideDimensions;
    if (!hasSelection) {
      setFrozenThumbnail(null);
      return;
    }

    const tiledImage = viewer.world.getItemAt(0);
    if (!tiledImage) {
      setFrozenThumbnail(null);
      return;
    }

    const contentSize = tiledImage.getContentSize();
    if (contentSize.x === 0 || contentSize.y === 0) {
        setFrozenThumbnail(null);
        return;
    }

    let rasterCanvas: HTMLCanvasElement | null = (viewer as any)?.drawer?.canvas || (viewer as any)?.drawer?.glCanvas || null;
    if (!rasterCanvas) {
      rasterCanvas = viewer.container?.querySelector<HTMLCanvasElement>("canvas.openseadragon-canvas") || null;
    }
    if (!rasterCanvas || !(rasterCanvas instanceof HTMLCanvasElement)) {
        setFrozenThumbnail(null);
        return;
    }

    const containerRect = viewer.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    let imgX1 = liveRectangleCoords.x1 * ZOOM_SCALE;
    let imgY1 = liveRectangleCoords.y1 * ZOOM_SCALE;
    let imgX2 = liveRectangleCoords.x2 * ZOOM_SCALE;
    let imgY2 = liveRectangleCoords.y2 * ZOOM_SCALE;

    const maxX = contentSize.x;
    const maxY = contentSize.y;
    imgX1 = Math.max(0, Math.min(maxX, imgX1));
    imgX2 = Math.max(0, Math.min(maxX, imgX2));
    imgY1 = Math.max(0, Math.min(maxY, imgY1));
    imgY2 = Math.max(0, Math.min(maxY, imgY2));

    const OpenSeadragon = require('openseadragon');
    if (!OpenSeadragon) {
        setFrozenThumbnail(null);
        return;
    }
    const pointTL = new OpenSeadragon.Point(imgX1, imgY1);
    const pointBR = new OpenSeadragon.Point(imgX2, imgY2);
    const winTL = viewer.viewport.imageToWindowCoordinates(pointTL);
    const winBR = viewer.viewport.imageToWindowCoordinates(pointBR);

    if (!isFinite(winTL.x) || !isFinite(winTL.y) || !isFinite(winBR.x) || !isFinite(winBR.y)) {
        setFrozenThumbnail(null);
        return;
    }

    let srcX = (winTL.x - containerRect.left) * dpr;
    let srcY = (winTL.y - containerRect.top) * dpr;
    let srcW = (winBR.x - winTL.x) * dpr;
    let srcH = (winBR.y - winTL.y) * dpr;

    srcX = Math.max(0, Math.min(rasterCanvas.width, srcX));
    srcY = Math.max(0, Math.min(rasterCanvas.height, srcY));
    srcW = Math.max(1, Math.min(rasterCanvas.width - srcX, srcW));
    srcH = Math.max(1, Math.min(rasterCanvas.height - srcY, srcH));

    if (srcW < 2 || srcH < 2) {
      setFrozenThumbnail(null);
      return;
    }

    try {
      // Calculate aspect-ratio-preserving destination
      const imageRatio = srcW / srcH;
      const canvasRatio = canvasWidth / canvasHeight;

      let destWidth: number, destHeight: number, destX: number, destY: number;

      if (imageRatio > canvasRatio) {
        // Image is wider than canvas aspect ratio
        destWidth = canvasWidth;
        destHeight = canvasWidth / imageRatio;
        destX = 0;
        destY = (canvasHeight - destHeight) / 2;
      } else {
        // Image is taller than or same as canvas aspect ratio
        destHeight = canvasHeight;
        destWidth = canvasHeight * imageRatio;
        destY = 0;
        destX = (canvasWidth - destWidth) / 2;
      }

      // If we have polygon points, create a clipping path
      if (shapeData?.polygonPoints) {
        ctx.save();
        ctx.beginPath();
        
        const rect = liveRectangleCoords; // Bounding box in L0 coords
        
        shapeData.polygonPoints.forEach((point, index) => {
          // Normalize point within the bounding box
          const normalizedX = (point[0] - rect.x1) / (rect.x2 - rect.x1);
          const normalizedY = (point[1] - rect.y1) / (rect.y2 - rect.y1);
          // Scale to destination canvas coordinates
          const canvasX = destX + normalizedX * destWidth;
          const canvasY = destY + normalizedY * destHeight;

          if (index === 0) {
            ctx.moveTo(canvasX, canvasY);
          } else {
            ctx.lineTo(canvasX, canvasY);
          }
        });

        ctx.closePath();
        ctx.clip();
      }

      ctx.drawImage(rasterCanvas, srcX, srcY, srcW, srcH, destX, destY, destWidth, destHeight);
      
      // Draw border if there's a selection
      if (shapeData?.polygonPoints) {
        ctx.restore(); // restore from clipping
        ctx.strokeStyle = "#6366f1";
        ctx.lineWidth = 2;
        // Re-draw the polygon path to stroke it
        ctx.beginPath();
        const rect = liveRectangleCoords;
        shapeData.polygonPoints.forEach((point, index) => {
          const normalizedX = (point[0] - rect.x1) / (rect.x2 - rect.x1);
          const normalizedY = (point[1] - rect.y1) / (rect.y2 - rect.y1);
          const canvasX = destX + normalizedX * destWidth;
          const canvasY = destY + normalizedY * destHeight;
          if (index === 0) ctx.moveTo(canvasX, canvasY);
          else ctx.lineTo(canvasX, canvasY);
        });
        ctx.closePath();
        ctx.stroke();
      } else if (shapeData?.rectangleCoords) {
        ctx.strokeStyle = "#6366f1";
        ctx.lineWidth = 2;
        ctx.strokeRect(destX, destY, destWidth, destHeight);
      }
      
      setFrozenThumbnail(canvas.toDataURL());

    } catch (e) {
      console.error("Error drawing thumbnail:", e);
      setFrozenThumbnail(null);
      return;
    }
  }, [viewer, liveRectangleCoords, osdReady, slideDimensions, shapeData]);

  useEffect(() => {
  // Build a key from both the rectangle and polygon points
  const currentKey = {
    rect: liveRectangleCoords,
    polyKey: makePolyKey(shapeData?.polygonPoints)
  };

  // If there is no selection, clear everything and bail
  if (!liveRectangleCoords) {
    setFrozenThumbnail(null);
    lastCaptureRef.current = null;
    return;
  }

  const last = lastCaptureRef.current;
  const changed =
    !last ||
    !rectsEqual(last.rect, currentKey.rect) ||
    last.polyKey !== currentKey.polyKey;

  // If geometry hasn't changed, don't capture again (prevents “one-time” overwrite after fast pan)
  if (!changed) return;

  const timer = setTimeout(() => {
    drawThumbnail();
    lastCaptureRef.current = currentKey; // Remember what we captured
  }, 100); // keep your existing debounce (helps tiles sharpen)

  return () => clearTimeout(timer);
}, [liveRectangleCoords, drawThumbnail, shapeData?.polygonPoints]);

  const handleRunClick = async () => {
    const getDefaultOutputPath = (path: string): string => {
      if (!path) return "";
      return path + '.h5';
    };

    const outputPath = getDefaultOutputPath(formattedPath);
    const targetMppValue = panel.content.find(item => item.key === "target_mpp")?.value;
    
    let bbox = null;
    if (liveRectangleCoords) {
      const { x1, y1, x2, y2 } = liveRectangleCoords;
      const width = x2 - x1;
      const height = y2 - y1;
      if (width > 0 && height > 0) {
        bbox = `${x1},${y1},${width},${height}`;
      }
    } else if (slideDimensions && slideDimensions.length === 2) {
      const [width, height] = slideDimensions;
      bbox = `0,0,${width},${height}`;
    }

    const workflowPayload = {
      h5_path: outputPath,
      step1: {
        model: "SegmentationNode",
        input: {
          path: formattedPath,
          target_mpp: targetMppValue,
          ...(bbox && { bbox: bbox }),
          ...(shapeData?.polygonPoints && { polygon_points: shapeData.polygonPoints }),
        }
      }
    };

    console.log("Starting Segmentation workflow with payload:", workflowPayload);
    try {
      dispatch(setIsChatGenerating(true));
      dispatch(setIsRunning(true));
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, workflowPayload);
      console.log("Segmentation workflow start response:", response.data);

      if (response.data.message === "Success" || response.status === 200 || response.data.code === 0) {
        console.log("Segmentation workflow started successfully. Parent container will track status.");
        EventBus.emit("switchTab", "workflow");
      } else {
        dispatch(setIsChatGenerating(false));
        dispatch(setIsRunning(false));
        console.error("Failed to start Segmentation workflow:", response.data);
      }
    } catch (error) {
      dispatch(setIsChatGenerating(false));
      dispatch(setIsRunning(false));
      console.error('Error starting Segmentation workflow:', error);
    }
  };

  const handleInputChange = (itemKey: string, value: string) => {
    onContentChange(panel.id, {
      ...panel,
      content: panel.content.map((contentItem) =>
        contentItem.key === itemKey
          ? { ...contentItem, value: value }
          : contentItem
      ),
    });
  };

  const currentTool = useSelector((state: RootState) => state.tool.currentTool);
  const handleToolChange = (tool: DrawingTool) => {
    dispatch(setTool(tool));
  };

  return (
    <div className="space-y-3 px-1">
      <div className="flex flex-row gap-3">
        {/* Left column: thumbnail placeholder */}
        <div className="w-[120px] h-28 bg-neutral-100/70 border border-dashed border-neutral-300 rounded-md flex items-center justify-center relative overflow-hidden flex-shrink-0">
          <canvas
            ref={canvasRef}
            width={120}
            height={112}
            className="absolute inset-0 w-full h-full"
            hidden
          />
          {frozenThumbnail ? (
            <Image
              src={frozenThumbnail}
              alt="Selected Region Thumbnail"
              className="absolute inset-0 w-full h-full object-contain"
              width={120}
              height={112}
            />
          ) : (
            <span className="text-xs text-neutral-500 select-none z-10 text-center px-2">
              Whole slide selected
            </span>
          )}
        </div>

        {/* Right column: inputs */}
        <div className="flex-1 space-y-3">
          {targetMppItem && targetMppItem.type === 'input' && (
            <div className="space-y-2">
              <Label htmlFor={`${panel.id}-${targetMppItem.key}`} className="text-xs font-medium text-gray-700 flex items-center gap-1">
                {targetMppItem.label || 'Target MPP (µm/pixel)'}
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 cursor-pointer text-gray-400" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[220px] p-2 text-xs text-gray-700 bg-white border border-gray-400 rounded-md">
                      The target MPP (microns per pixel) lets you down-sample or up-sample the image before segmentation. A lower number means higher resolution; a higher number speeds up processing by sampling a coarser image.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id={`${panel.id}-${targetMppItem.key}`}
                type="text"
                value={targetMppItem.value}
                placeholder={targetMppItem.placeholder}
                onChange={(e) => handleInputChange(targetMppItem.key, e.target.value)}
                className="h-8 text-sm w-full"
              />
            </div>
          )}

          <div className="flex justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleToolChange('rectangle')}
                className={`flex items-center justify-center p-2 rounded-md transition-colors ${
                  currentTool === 'rectangle'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                }`}
              > 
                <PiRectangle className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleToolChange('polygon')}
                className={`flex items-center justify-center p-2 rounded-md transition-colors ${
                  currentTool === 'polygon'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                }`}
              >
                <LiaDrawPolygonSolid className="h-4 w-4" />
              </button>
            </div>
            {/* @ts-ignore */}
            <CButton color="success" size="sm" onClick={handleRunClick} disabled={isRunning} className="h-full border border-black">
              <CIcon icon={cilMediaPlay} className="mr-1" /> Run
            </CButton>
          </div>
        </div>
      </div>

      <div>
        {/* Render other generic content items */}
        {otherContentItems.map(item => (
          <ContentRenderer
            key={item.key}
            item={item}
            onChange={(value) => handleInputChange(item.key, value)}
          />
        ))}
      </div>
    </div>
  );
}; 