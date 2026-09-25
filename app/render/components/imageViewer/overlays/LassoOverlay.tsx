"use client";

import { Origin } from "@annotorious/react";
import OpenSeadragon from "openseadragon";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import { RootState } from "@/store";
import { setTool } from "@/store/slices/viewer/toolSlice";

/**
 * Freehand "lasso" region tool. Mirrors the 2D lasso interaction from the
 * 3D-pathology app (drag to trace, distance-throttled points, dedupe, ≥3 points)
 * on the OpenSeadragon WSI. A lasso is just a polygon drawn by dragging instead
 * of clicking vertices.
 *
 * On release we LOCAL-add via the Annotorious store so the shape enters the
 * undo stack and fires `createAnnotation` — persistence then matches rectangle
 * (useAnnotatorInitialization). Public `addAnnotation` / `setAnnotations` are
 * REMOTE-only and would skip history (Cmd+Z would undo something else).
 * View-only paths still LOCAL-add; create handler stamps without disk write.
 */

interface LassoOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  annotator: any;
  /** Dual viewer: only the focused pane may draw. */
  isActiveInstance?: boolean;
}

const MIN_SCREEN_DIST = 2; // px between recorded points (matches the 3D tool)
const STROKE = "#00ff00"; // matches the style body color the app gives annotations
const FILL = "rgba(0, 255, 0, 0.10)";

const LassoOverlay: React.FC<LassoOverlayProps> = ({
  viewer,
  annotator,
  isActiveInstance = true,
}) => {
  const dispatch = useDispatch();
  const currentTool = useSelector((s: RootState) => s.tool.currentTool);
  const active = currentTool === "lasso" && isActiveInstance;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const drawingRef = useRef(false);
  const screenPtsRef = useRef<[number, number][]>([]);
  const [preview, setPreview] = useState<[number, number][]>([]);

  const clearTrace = useCallback(() => {
    drawingRef.current = false;
    screenPtsRef.current = [];
    setPreview([]);
  }, []);

  // Cancel any in-progress trace when leaving the lasso tool / inactive pane.
  useEffect(() => {
    if (!active) clearTrace();
  }, [active, clearTrace]);

  const localPoint = useCallback((e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [e.clientX - rect.left, e.clientY - rect.top];
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!active || !viewer || e.button !== 0) return;
      // Mouse-nav is disabled by OpenSeadragonContainer while lasso is active.
      // Still block the event so OSD's MouseTracker cannot start a drag.
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      drawingRef.current = true;
      screenPtsRef.current = [localPoint(e)];
      setPreview([...screenPtsRef.current]);
    },
    [active, viewer, localPoint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drawingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const p = localPoint(e);
      const pts = screenPtsRef.current;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_SCREEN_DIST) {
        return;
      }
      pts.push(p);
      setPreview([...pts]);
    },
    [localPoint],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    drawingRef.current = false;
    const screenPts = screenPtsRef.current;
    screenPtsRef.current = [];
    setPreview([]);

    const item = viewer?.world.getItemAt(0);
    if (!viewer || !item || !annotator || screenPts.length < 3) return;

    // screen px -> image coords, dropping consecutive duplicates
    const points: [number, number][] = [];
    for (const [px, py] of screenPts) {
      const vp = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(px, py));
      const ip = item.viewportToImageCoordinates(vp);
      const xy: [number, number] = [Math.round(ip.x), Math.round(ip.y)];
      const prev = points[points.length - 1];
      if (!prev || prev[0] !== xy[0] || prev[1] !== xy[1]) points.push(xy);
    }
    if (points.length < 3) return;

    let minX = points[0][0];
    let minY = points[0][1];
    let maxX = points[0][0];
    let maxY = points[0][1];
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `lasso-${Date.now()}-${Math.round((minX + maxX) * 7)}`;
    const created = new Date().toISOString();
    const creator = { id: "default", type: "Person" };
    const annotation = {
      id,
      type: "Annotation",
      bodies: [
        {
          id: `${id}-style`,
          annotation: id,
          type: "TextualBody",
          purpose: "style",
          value: "#00ff00",
          created,
          creator,
        },
      ],
      target: {
        annotation: id,
        selector: {
          type: "POLYGON",
          geometry: { points, bounds: { minX, minY, maxX, maxY } },
        },
        creator,
        created,
      },
      isBackend: false,
    };

    // LOCAL so undo history + createAnnotation (persist) match rectangle.
    try {
      const store = annotator.state?.store;
      if (store?.addAnnotation) {
        store.addAnnotation(annotation, Origin.LOCAL);
      } else {
        // Fallback: REMOTE public API — no undo entry, but still on canvas.
        annotator.addAnnotation?.(annotation);
      }
      annotator.setSelected?.(id);
    } catch (err) {
      console.error("LassoOverlay: failed to add annotation", err);
      return;
    }

    // Selection done — drop back to the move tool (like finishing any draw).
    dispatch(setTool("move"));
  }, [viewer, annotator, dispatch]);

  const cancelTrace = useCallback(
    (e?: React.PointerEvent) => {
      if (!drawingRef.current) return;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
        } catch {}
      }
      clearTrace();
    },
    [clearTrace],
  );

  const onPointerLeave = useCallback(
    (e: React.PointerEvent) => {
      // Leaving the overlay mid-drag cancels the trace — do not auto-commit
      // a partial lasso just because the cursor exited the SVG.
      cancelTrace(e);
    },
    [cancelTrace],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      cancelTrace(e);
    },
    [cancelTrace],
  );

  const previewStr = preview.map((p) => `${p[0]},${p[1]}`).join(" ");

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: active ? "auto" : "none",
        // Avoid browser touch panning competing with the lasso stroke.
        touchAction: "none",
        cursor: active ? "crosshair" : "default",
        zIndex: 6,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      {preview.length > 1 && (
        <polygon
          points={previewStr}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={2}
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
};

// See MaskOverlay: shields the overlay from the parent's per-mouse-move renders.
export default React.memo(LassoOverlay);
