"use client"

import {useCallback, useEffect, useRef, useState} from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RotateCcw, Tag } from "lucide-react"
import { ImageAnnotation } from "@annotorious/react";
import { useDispatch, useSelector} from "react-redux";
import { AppDispatch, RootState } from "@/store";
import {
  selectPatchClassificationData,
  setPatchClassificationData,
  type PatchOverlayEntry,
} from "@/store/slices/viewer/annotationSlice";
import FilterContent from "./FilterContent";
import RulerContent from "./RulerContent";
import SelectionContent, { SelectionContentFooter } from "./SelectionContent";
import {
  isFilterEphemeral,
} from "@/utils/viewer/annotation.utils";
import { remoteUpdateAnnotation } from "@/utils/viewer/persistManualDrawing";
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import { useActiveSlidePath } from "@/utils/viewer/slidePath";

interface AnnotationPopupProps {
  annotation: ImageAnnotation
  selectedTool: string
  /** `explicit` = the footer Save button — the only click that writes to Zarr. */
  onSave: (explicit?: boolean) => boolean | void | Promise<boolean | void>
  /** Dismiss after Mark / Close — must not delete persisted manuals from Zarr. */
  onCancel: () => void
  /** Footer Delete — remove shape and delete from Zarr if persisted. */
  onDelete: () => void
  annotatorInstance: any
  instanceId?: string | null
  patches?: PatchOverlayEntry[]
}

const DEFAULT_REGION_COLOR = '#00ff00';

function patchBody(annotation: any, purpose: string, value: string) {
  const bodies = (Array.isArray(annotation?.bodies) ? annotation.bodies : []).filter(
    (b: any) => b?.purpose !== purpose,
  );
  bodies.push({
    id: `${annotation.id}-${purpose}`,
    annotation: annotation.id,
    type: 'TextualBody',
    purpose,
    value,
    created: new Date().toISOString(),
    creator: { id: 'default' },
  });
  return { ...annotation, bodies };
}

export default function AnnotationPopup({
    annotation,
    selectedTool,
    onSave = () => {},
    onCancel = () => {},
    onDelete,
    annotatorInstance,
    instanceId: instanceIdProp,
    patches = [],
  }: AnnotationPopupProps) {
  const currentPath = useActiveSlidePath();
  const { allowed: pathWritable, tooltip: writeBlockTitle, assertWritable } = usePathWriteAccess(currentPath);
  const [selectedColor, setSelectedColor] = useState(() => {
    const styleBody = annotation.bodies.find(b => b.purpose === 'style');
    return styleBody?.value || DEFAULT_REGION_COLOR;
  });
  const [customText, setCustomText] = useState(() => {
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    return commentBody?.value || "";
  });

  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const dispatch = useDispatch<AppDispatch>();
  const shapeCoords = useSelector((state: RootState) => state.shape.shapeData?.rectangleCoords);

  const isRulerTool = selectedTool === 'line' || annotation.target.selector?.type === 'LINE';
  // Create stamps ephemeral before popup; only that identity opens Filter UI.
  const isFilterTool = isFilterEphemeral(annotation);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const skipFlushRef = useRef(false);
  const flushedRef = useRef(false);
  const isFilterToolRef = useRef(isFilterTool);
  isFilterToolRef.current = isFilterTool;

  const updateLiveBody = useCallback((purpose: 'style' | 'comment', value: string) => {
    if (!annotatorInstance?.getAnnotationById) return;
    try {
      const live = annotatorInstance.getAnnotationById(annotation.id);
      if (!live) return;
      const next = patchBody(live, purpose, value);
      if (!remoteUpdateAnnotation(annotatorInstance, next)) {
        annotatorInstance.updateAnnotation(next);
      }
    } catch {}
  }, [annotatorInstance, annotation.id]);

  /**
   * Deselect flush (`explicit` false) only syncs drawings already stored in
   * Zarr — a fresh drawing stays a canvas-only draft until the footer Save.
   */
  const flushOnDeselect = useCallback((explicit = false) => {
    if (isFilterToolRef.current) return;
    if (skipFlushRef.current) return;
    if (flushedRef.current && !explicit) return;
    // onSave reads live Annotorious state; false = suppress / gone — allow retry.
    const result = onSaveRef.current(explicit);
    if (result !== false) {
      flushedRef.current = true;
    }
  }, []);

  useEffect(() => {
    skipFlushRef.current = false;
    flushedRef.current = false;
    const styleBody = annotation.bodies.find(b => b.purpose === 'style');
    setSelectedColor(styleBody?.value || DEFAULT_REGION_COLOR);
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    setCustomText(commentBody?.value || "");
  }, [annotation.id]);

  useEffect(() => {
    if (!annotatorInstance?.on) return;
    const id = annotation.id;
    try {
      const selected = annotatorInstance.getSelected?.() || [];
      if (selected.some((a: any) => a?.id === id)) {
        flushedRef.current = false;
      }
    } catch {}
    const onSelectionChanged = (selected: any[]) => {
      const stillSelected = (selected || []).some((a: any) => a?.id === id);
      if (stillSelected) {
        flushedRef.current = false;
        return;
      }
      flushOnDeselect();
    };
    annotatorInstance.on('selectionChanged', onSelectionChanged);
    return () => {
      try {
        annotatorInstance.off?.('selectionChanged', onSelectionChanged);
      } catch {}
      flushOnDeselect();
    };
  }, [annotatorInstance, annotation.id, flushOnDeselect]);

  useEffect(() => {
    if (!reduxPatchClassificationData || !reduxPatchClassificationData.class_name || reduxPatchClassificationData.class_name.length === 0) {
      dispatch(setPatchClassificationData({
        class_id: [0],
        class_name: ['Negative control'],
        class_hex_color: ['#aaaaaa']
      }));
    }
  }, [reduxPatchClassificationData, dispatch]);

  const handleColorChange = (color: string) => {
    setSelectedColor(color);
    updateLiveBody('style', color);
  };

  const handleTextChange = (text: string) => {
    setCustomText(text);
    updateLiveBody('comment', text);
  };

  const classificationBody = annotation.bodies.find(b => b.purpose === 'classification');

  const handleFooterSave = () => {
    if (!assertWritable('save this drawing')) {
      skipFlushRef.current = true;
      try {
        annotatorInstance?.cancelSelected?.();
      } catch {}
      return;
    }
    flushOnDeselect(true);
    try {
      annotatorInstance?.cancelSelected?.();
    } catch {}
  };

  const handleDelete = () => {
    skipFlushRef.current = true;
    onDelete();
  };

  const handleFilterClose = () => {
    skipFlushRef.current = true;
    onCancel();
  };

  /**
   * Marking consumes the region: the drawing was only a selection, so drop it
   * (canvas + Zarr manual record) instead of flushing it as a manual
   * annotation. The geometry is not lost — save_patch stores the polygon under
   * User-Annotations/patch selection geometry.
   */
  const handleMarkDiscard = () => {
    skipFlushRef.current = true;
    onDelete();
  };

  const handleDismiss = () => {
    flushOnDeselect();
    onCancel();
  };

  return (
      <Card
          className="w-full max-w-lg relative z-50 shadow-lg border-0"
      >
        <div className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 py-1 px-3 shrink-0">
            <CardTitle className="flex items-center space-x-2 text-sm">
              <Tag className="w-4 h-4"/>
              <span>Annotation</span>
            </CardTitle>
            {!isFilterTool && (
              <span className="flex items-center gap-1">
                <input
                  type="color"
                  value={selectedColor}
                  onChange={(e) => handleColorChange(e.target.value)}
                  title="Change selection color"
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-4 w-4 shrink-0 p-0 text-muted-foreground/50 hover:text-muted-foreground hover:bg-transparent disabled:opacity-30"
                  onClick={() => handleColorChange(DEFAULT_REGION_COLOR)}
                  disabled={selectedColor.toLowerCase() === DEFAULT_REGION_COLOR}
                  title="Reset to default green"
                  aria-label="Reset to default green"
                >
                  <RotateCcw className="!h-3 !w-3" strokeWidth={2} />
                </Button>
              </span>
            )}
          </CardHeader>

          <CardContent className="py-0.5 px-3 overflow-hidden">
            <div className="space-y-2">
              {isRulerTool ? (
                <RulerContent annotation={annotation} instanceId={instanceIdProp} />
              ) : isFilterTool ? (
                <FilterContent shapeCoords={shapeCoords || null} instanceId={instanceIdProp} />
              ) : (
                <SelectionContent 
                  annotation={annotation}
                  customText={customText} 
                  onTextChange={handleTextChange}
                  selectedColor={selectedColor}
                  onColorChange={handleColorChange}
                  selectedTool={selectedTool}
                  annotatorInstance={annotatorInstance}
                  instanceId={instanceIdProp}
                  onCancel={handleDismiss}
                  onDiscardRegion={handleMarkDiscard}
                  shapeCoords={shapeCoords || null}
                  patches={patches}
                />
              )}
              {classificationBody && (
                  <div className="mt-2 text-sm">
                    <Label>Current Class:</Label>
                    <div className="text-foreground">{classificationBody.value}</div>
                  </div>
              )}
            </div>
          </CardContent>

          {isRulerTool ? (
            <div className="px-3 py-1 flex justify-end items-center">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  onClick={handleFooterSave}
                  disabled={!pathWritable || !selectedColor}
                  title={writeBlockTitle}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : isFilterTool ? (
            <div className="px-3 py-1 flex justify-end items-center">
              <Button variant="outline" size="sm" onClick={handleFilterClose}>
                Close
              </Button>
            </div>
          ) : (
            <SelectionContentFooter
              selectedColor={selectedColor}
              onSave={handleFooterSave}
              onDelete={handleDelete}
              annotatorInstance={annotatorInstance}
              shapeCoords={shapeCoords || null}
            />
          )}
        </div>
      </Card>
  );
}
