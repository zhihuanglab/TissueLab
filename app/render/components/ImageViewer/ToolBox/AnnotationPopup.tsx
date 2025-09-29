"use client"

import {useEffect, useState, useCallback} from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Search, Tag } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HexColorPicker } from "react-colorful"
import { AnnotationBody, ImageAnnotation } from "@annotorious/react";
import { useDispatch, useSelector} from "react-redux";
import { AppDispatch, RootState } from "@/store";
import http from "@/utils/http";
import { message } from "antd";
import {
  setAnnotationType,
  removeAnnotationType,
  selectPatchClassificationData,
  setPatchClassificationData,
  updatePatchOverlayColors,
  selectPatchOverlays,
} from "@/store/slices/annotationSlice";
import {useWs, WsProvider} from "@/contexts/WsProvider";
import {AI_SERVICE_API_ENDPOINT, AI_SERVICE_SOCKET_ENDPOINT} from "@/constants/config"
import { formatPath } from "@/utils/pathUtils"
import EventBus from "@/utils/EventBus";

// Workflow utility
import { getDefaultOutputPath, triggerClassificationWorkflow, triggerPatchClassificationWorkflow } from "@/utils/workflowUtils";
import { savePNGFromCurrentSelection } from "@/utils/snapshot.util";

interface AnnotationPopupProps {
  annotation: ImageAnnotation
  selectedTool: string
  onSave: (color: string, customText?: string) => void
  onCancel: () => void
  annotatorInstance: any
  instanceId?: string | null
}

export default function AnnotationPopup({
annotation,
selectedTool,
onSave = () => {},
onCancel = () => {},
annotatorInstance,
instanceId: instanceIdProp
}: AnnotationPopupProps) {
  const [selectedColor, setSelectedColor] = useState(() => {
    const styleBody = annotation.bodies.find(b => b.purpose === 'style');
    return styleBody?.value || '#00ff00';
  });
  const [customText, setCustomText] = useState(() => {
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    return commentBody?.value || "";
  });

  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses)
  const updateAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updateAfterEveryAnnotation);
  const updatePatchAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updatePatchAfterEveryAnnotation);
  const patchClassifierPath = useSelector((state: RootState) => state.workflow.patchClassifierPath);
  const patchClassifierSavePath = useSelector((state: RootState) => state.workflow.patchClassifierSavePath);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const currentPatches = useSelector(selectPatchOverlays);
  const dispatch = useDispatch<AppDispatch>();
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan);
  const shapeCoords = useSelector((state: RootState) => state.shape.shapeData?.rectangleCoords);
  
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));

  const isPointInsidePolygon = useCallback((x: number, y: number, polygon: number[][]) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = Number(polygon[i]?.[0] ?? 0);
      const yi = Number(polygon[i]?.[1] ?? 0);
      const xj = Number(polygon[j]?.[0] ?? 0);
      const yj = Number(polygon[j]?.[1] ?? 0);
      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }, []);

  const refreshPatchCountsFromServer = useCallback(async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`);
      const payload = resp.data?.data ?? resp.data;
      if (!payload || !Array.isArray(payload.class_name) || payload.class_name.length === 0) {
        return;
      }

      const coerceCounts = (arr: any[] | undefined, fallbackLength: number) => {
        if (!Array.isArray(arr)) {
          return new Array(fallbackLength).fill(0);
        }
        return arr.map((value) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : 0;
        });
      };

      const mergedData = {
        class_id: Array.isArray(payload.class_id) ? [...payload.class_id] : [],
        class_name: [...payload.class_name],
        class_hex_color: Array.isArray(payload.class_hex_color) ? [...payload.class_hex_color] : new Array(payload.class_name.length).fill('#aaaaaa'),
        class_counts: coerceCounts(payload.class_counts, payload.class_name.length),
      };

      if (reduxPatchClassificationData && reduxPatchClassificationData.class_name) {
        reduxPatchClassificationData.class_name.forEach((localName, index) => {
          const existingIndex = mergedData.class_name.findIndex((name) => name === localName);
          if (existingIndex === -1) {
            const numericIds = mergedData.class_id
              .map((val) => (Number.isFinite(Number(val)) ? Number(val) : null))
              .filter((val) => val !== null) as number[];
            const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : mergedData.class_name.length;
            mergedData.class_name.push(localName);
            mergedData.class_hex_color.push(reduxPatchClassificationData.class_hex_color[index]);
            mergedData.class_id.push(nextId);
            const fallbackCount = reduxPatchClassificationData.class_counts?.[index] ?? 0;
            mergedData.class_counts.push(Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0);
          } else if (mergedData.class_counts[existingIndex] === undefined) {
            const fallbackCount = reduxPatchClassificationData.class_counts?.[index] ?? 0;
            mergedData.class_counts[existingIndex] = Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0;
          }
        });
      }

      if (mergedData.class_counts.length < mergedData.class_name.length) {
        mergedData.class_counts = [
          ...mergedData.class_counts,
          ...new Array(mergedData.class_name.length - mergedData.class_counts.length).fill(0),
        ];
      }

      dispatch(setPatchClassificationData(mergedData));
    } catch (error) {
      console.error('Failed to refresh patch classification data:', error);
    }
  }, [dispatch, reduxPatchClassificationData]);

  const applyOptimisticAnnotationTypes = useCallback((
    updates: Array<{ id: string; classIndex?: number; color: string; category: string }>
  ) => {
    if (!updates.length) return () => {};

    dispatch(setAnnotationType(updates.map(update => ({
      id: update.id,
      classIndex: update.classIndex ?? 0,
      color: update.color,
      category: update.category,
    }))));

    return () => {
      updates.forEach(update => dispatch(removeAnnotationType(update.id)));
    };
  }, [dispatch]);

  // The frontend stores rectangle coordinates divided by the viewer scale (see OpenSeadragonContainer).
  // Backend endpoints expect RAW OpenSeadragon coordinates, which are 16× larger.
  // Use this constant to up-scale before sending any request.
  const SCALE_FACTOR = 16;

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

  useEffect(() => {
    if (!reduxPatchClassificationData || !reduxPatchClassificationData.class_name || reduxPatchClassificationData.class_name.length === 0) {
      dispatch(setPatchClassificationData({
        class_id: [0],
        class_name: ['Negative control'],
        class_hex_color: ['#aaaaaa']
      }));
    }
  }, [reduxPatchClassificationData, dispatch]);

  const handleColorChange = async (color: string) => {
    setSelectedColor(color)
  }

  const handleSave = () => {
    if (selectedColor) {
      // take the parent onSave function and pass the selectedColor, title, description, customText
      onSave(selectedColor, customText);
    }
    // }
  };

  const handleSavePngFromRectangle = async () => {
    await savePNGFromCurrentSelection(annotatorInstance?.viewer, shapeCoords, {
      scaleFactor: SCALE_FACTOR,
      backgroundColor: '#ffffff',
      quality: 0.95,
      filenameSuffix: 'annotation'
    });
  };

  const markAllNuclei = async (item: any) => {
    if (!shapeCoords) {
      console.error("Shape coordinates (Raw BBox) not found in Redux state. Cannot mark nuclei.");
      return;
    }
    // Frontend keeps coordinates divided by SCALE_FACTOR when dispatching to Redux.
    // Convert them back to RAW OSD coordinates for backend queries.
    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;
    const scaledX1 = bboxX1 * SCALE_FACTOR;
    const scaledY1 = bboxY1 * SCALE_FACTOR;
    const scaledX2 = bboxX2 * SCALE_FACTOR;
    const scaledY2 = bboxY2 * SCALE_FACTOR;

    // 2. Check if the original annotation is a Polygon and get its RAW points
    let polygonRawPoints: number[][] | null = null;
    let selectorType = annotation.target.selector?.type; // Store type for logging/debugging

    if (selectorType === 'POLYGON') {
      // Use type assertion for potentially dynamic geometry structure
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

    // 3. Prepare API parameters
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/query`;
    const apiParams: any = { // Build API parameters
      "x1": scaledX1,
      "x2": scaledX2,
      "y1": scaledY1,
      "y2": scaledY2,
      "class_name": item.name,
      "color": item.color
    };


    // 4. If it was a polygon, add the stringified raw points
    if (polygonRawPoints) {
      try {
          // Use the alias 'polygon_points' matching the backend Query parameter
          const pts = polygonRawPoints || [];
          apiParams.polygon_points = JSON.stringify(pts);
      } catch (e) {}
    }

    try {
      const response = await http.get(url, { params: apiParams });
      const responseData = response.data.data || response.data;
      const matching_indices = responseData?.matching_indices ?? [];

      const classIndex = nucleiClasses.findIndex((c) => c.name === item.name);
      const updates = matching_indices.map((idx: any) => ({
        id: idx.toString(),
        classIndex,
        color: item.color,
        category: item.name,
      }));

      if (!updates.length) {
        message.info('No nuclei detected in this region.');
        return;
      }

      const rollback = applyOptimisticAnnotationTypes(updates);

      if (annotatorInstance && annotatorInstance.viewer) {
        annotatorInstance.viewer.raiseEvent('update-viewport');
        annotatorInstance.viewer.raiseEvent('animation');
        annotatorInstance.viewer.raiseEvent('animation-finish');
      }

      if (annotation && annotatorInstance) {
        const newRectangleBodies = annotation.bodies.filter((b) => b.purpose !== 'style');
        newRectangleBodies.push({
          id: String(Date.now()) + '-rectstyle',
          annotation: annotation.id,
          type: 'TextualBody',
          purpose: 'style',
          value: item.color,
          created: new Date(),
          creator: { id: 'default' },
        });

        const updatedRectangleAnnotation = {
          ...annotation,
          bodies: newRectangleBodies,
        };
        annotatorInstance.updateAnnotation(updatedRectangleAnnotation);

        if (annotatorInstance.viewer) {
          annotatorInstance.setSelected(null);
          annotatorInstance.setSelected(updatedRectangleAnnotation.id);
          annotatorInstance.viewer.forceRedraw();
        }
      }

      onCancel();

      const savePayload: any = {
        path: getDefaultOutputPath(formattedPath),
        wf_id: 1,
        region_geometry: { x1: scaledX1, y1: scaledY1, x2: scaledX2, y2: scaledY2 },
        matching_indices,
        classification: item.name,
        color: item.color,
        method: `${selectorType || selectedTool || 'unknown'} selection`.toLowerCase(),
        annotator: 'Unknown',
        ui_nuclei_classes: nucleiClasses.map((cls) => cls.name),
        ui_nuclei_colors: nucleiClasses.map((cls) => cls.color),
        ui_organ: currentOrgan,
      };
      if (polygonRawPoints) savePayload.polygon_vertices = polygonRawPoints;

      const headers: any = {};
      if (!instanceIdProp) {
        console.warn('[AnnotationPopup] Missing instanceIdProp; aborting save_annotation to avoid mismatched session.');
        return;
      }
      headers['X-Instance-ID'] = instanceIdProp;

      void http
        .post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, savePayload, { headers })
        .then(() => {
          try {
            EventBus.emit('refresh-annotations');
          } catch {}
          try {
            EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
          } catch {}

          if (updateAfterEveryAnnotation && currentPath && nucleiClasses.length > 0) {
            const h5Path = getDefaultOutputPath(formattedPath);
            void triggerClassificationWorkflow(dispatch, h5Path, nucleiClasses, currentOrgan);
          }
        })
        .catch((err) => {
          console.error('POST /save_annotation error or workflow trigger error:', err);
          rollback();
          message.error('Failed to save nuclei annotations. Reverted to previous state.');
          EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        });
    } catch (error) {
      console.error('Error during markAllNuclei API call or processing:', error);
      message.error('Unable to mark nuclei for this region.');
    }
  };

  const classificationBody = annotation.bodies.find(b => b.purpose === 'classification');

  const handleCancel = () => {
    // close the popup
    onCancel();
  };

  const [aiMessage, setAiMessage] = useState("");
  const handleSendMessage = async () => {
    if (!aiMessage.trim()) return;

    console.log("Sending message to AI:", aiMessage);

    setAiMessage("");
  };

  useEffect(() => {
    const commentBody = annotation.bodies.find(b => b.purpose === 'comment');
    setCustomText(commentBody?.value || "");
  }, [annotation]);

  useEffect(() => { console.log('nucleiClasses from popup =', nucleiClasses) }, [nucleiClasses])

  const markTissue = async (classId: number) => {
    if (!shapeCoords) {
      console.error('[MarkTissue] Shape coordinates (Raw BBox) not found in Redux state.');
      return;
    }
    const { x1: rawBBoxX1, y1: rawBBoxY1, x2: rawBBoxX2, y2: rawBBoxY2 } = shapeCoords;
    const scaledBBoxX1 = rawBBoxX1 * SCALE_FACTOR;
    const scaledBBoxY1 = rawBBoxY1 * SCALE_FACTOR;
    const scaledBBoxX2 = rawBBoxX2 * SCALE_FACTOR;
    const scaledBBoxY2 = rawBBoxY2 * SCALE_FACTOR;

    if (!reduxPatchClassificationData) {
      message.error('Patch classification metadata is not available.');
      return;
    }
    if (classId < 0 || classId >= reduxPatchClassificationData.class_name.length) {
      message.error('Invalid patch classification selection.');
      return;
    }
    const className = reduxPatchClassificationData.class_name[classId];
    const colorHex = reduxPatchClassificationData.class_hex_color[classId] || '#FFFF00';

    let polygonRawPoints: number[][] | null = null;
    const selector = annotation.target.selector;
    const selectorType = selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
          polygonRawPoints = geometry.points;
          console.log('[MarkTissue] Detected Polygon, raw points obtained:', polygonRawPoints);
      } else {
          console.warn('[MarkTissue] Polygon selector detected, but raw points are missing or invalid.', geometry);
      }
    } else {
      console.log('[MarkTissue] Detected Rectangle or other shape type.');
    }

    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_tissue`;

    let method = 'polygon selection';
    if (selectorType === 'RECTANGLE') {
      method = 'rectangle selection';
    } else if (selectorType === 'LINE') {
      method = 'line selection';
    }
    
    const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        start_x: scaledBBoxX1,
        start_y: scaledBBoxY1,
        end_x: scaledBBoxX2,
        end_y: scaledBBoxY2,
        classification: className,
        color: colorHex,
        method: method,
        annotator: "Unknown"
    };

    if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
        console.log('[MarkTissue] Adding polygon_points to save_tissue payload:', payload.polygon_points);
    }

    const previousColorById = new Map<number, string>();
    const optimisticIds: number[] = [];

    if (currentPatches && currentPatches.length > 0) {
      const polygonPoints = polygonRawPoints && polygonRawPoints.length >= 3
        ? polygonRawPoints.map((pt: any) => [Number(pt[0]), Number(pt[1])])
        : null;

      currentPatches.forEach(([patchId, patchX, patchY, patchColor]) => {
        if (
          patchX >= scaledBBoxX1 && patchX <= scaledBBoxX2 &&
          patchY >= scaledBBoxY1 && patchY <= scaledBBoxY2
        ) {
          if (polygonPoints && !isPointInsidePolygon(patchX, patchY, polygonPoints)) {
            return;
          }
          optimisticIds.push(patchId);
          if (!previousColorById.has(patchId)) {
            previousColorById.set(patchId, patchColor);
          }
        }
      });
    }

    if (optimisticIds.length) {
      dispatch(updatePatchOverlayColors({ ids: optimisticIds, color: colorHex }));
    }

    const revertGroups = (() => {
      const grouped = new Map<string, number[]>();
      previousColorById.forEach((color, id) => {
        if (!grouped.has(color)) {
          grouped.set(color, []);
        }
        grouped.get(color)!.push(id);
      });
      return Array.from(grouped.entries()).map(([color, ids]) => ({ color, ids }));
    })();

    const revertOptimisticUpdates = () => {
      revertGroups.forEach(({ color, ids }) => {
        dispatch(updatePatchOverlayColors({ ids, color, persistOverride: false }));
      });
    };

    onCancel();

    void http
      .post(saveUrl, payload)
      .then(async (response) => {
        if (response.data.code === 0) {
          const matchingIndices: number[] = response.data?.data?.matching_indices ?? [];
          if (matchingIndices.length > 0) {
            const normalizedIds = matchingIndices.map((idx) => Number(idx));
            dispatch(updatePatchOverlayColors({ ids: normalizedIds, color: colorHex }));
            if (optimisticIds.length) {
              const backendIdSet = new Set(normalizedIds);
              revertGroups.forEach(({ color, ids }) => {
                const missing = ids.filter((id) => !backendIdSet.has(id));
                if (missing.length) {
                  dispatch(updatePatchOverlayColors({ ids: missing, color, persistOverride: false }));
                }
              });
            }
            EventBus.emit('refresh-patches');
          } else if (optimisticIds.length) {
            revertOptimisticUpdates();
          }

          const h5Path = getDefaultOutputPath(formattedPath);
          EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });

          if (updatePatchAfterEveryAnnotation && currentPath && reduxPatchClassificationData) {
            const refreshH5Path = getDefaultOutputPath(formattedPath);
            await triggerPatchClassificationWorkflow(dispatch, refreshH5Path, reduxPatchClassificationData, patchClassifierPath, patchClassifierSavePath);
          }

          await refreshPatchCountsFromServer();
        } else {
          revertOptimisticUpdates();
          throw new Error(response.data.error || 'Unknown save_tissue error');
        }
      })
      .catch((error) => {
        console.error('Failed to mark tissue via save_tissue API or trigger workflow:', error);
        revertOptimisticUpdates();
        message.error('Failed to save tissue annotations. View may show stale data until reloaded.');
        const h5Path = getDefaultOutputPath(formattedPath);
        EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });
      });
};

  return (
      <Card
          className="w-full max-w-lg relative z-50 shadow-lg border-0"
      >
        <div className="flex flex-col">
          <CardHeader className="py-1 px-3 shrink-0">
            <CardTitle className="flex items-center space-x-2 text-sm">
              <Tag className="w-4 h-4"/>
              <span>Annotation</span>
            </CardTitle>
          </CardHeader>

          <CardContent className="py-0.5 px-3 overflow-hidden">
            {/* replace label to nucleiColorsand regionColors */}
            <div className="grid grid-cols-2 gap-4 h-full">
              {/* left side */}
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label>Mark all nuclei in this region as:</Label>
                  <div className="space-y-0 bg-secondary/20 p-0.5 rounded-md overflow-y-auto max-h-[150px]">
                    {nucleiClasses.map((item, index) => (
                        <div
                            key={index}
                            className="flex items-center gap-2 cursor-pointer hover:bg-secondary/30 py-0 px-0.5 rounded-md"
                            onClick={() => markAllNuclei(item)}
                        >
                          <div
                              className="w-3 h-3 rounded-full"
                              style={{backgroundColor: item.color}}
                          />
                          <span className="text-sm">{item.name}</span>
                        </div>
                    ))}
                  </div>
                </div>

                {/* Add tissue marking section */}
                {reduxPatchClassificationData && (
                  <div className="space-y-1">
                    <Label>Mark this region as tissue type:</Label>
                    <div className="space-y-0 bg-secondary/20 p-0.5 rounded-md overflow-y-auto max-h-[150px]">
                      {reduxPatchClassificationData?.class_name?.map((name, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2 cursor-pointer hover:bg-secondary/30 py-0 px-0.5 rounded-md"
                          onClick={() => markTissue(index)}
                        >
                          <div
                            className="w-3 h-3 rounded"
                            style={{backgroundColor: reduxPatchClassificationData.class_hex_color[index] || '#FFFF00'}}
                          />
                          <span className="text-sm">{name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* right side */}
              <div className="space-y-2 overflow-y-auto max-h-[300px] pr-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm shrink-0">Custom color</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="h-6 px-2 justify-start text-left font-normal w-28">
                          <div className="w-3 h-3 rounded mr-1 shrink-0"
                               style={{backgroundColor: selectedColor || 'transparent'}}/>
                          <span className="text-xs truncate">{selectedColor || "#00ff00"}</span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-2">
                        <HexColorPicker color={selectedColor || "#000000"} onChange={handleColorChange}/>
                      </PopoverContent>
                    </Popover>
                  </div>
                <div className="space-y-1">
                  <Label className="text-sm">Custom annotation</Label>
                  <Textarea
                      placeholder="Type your text here..."
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      className="h-20"
                  />
                </div>
                {classificationBody && (
                    <div className="mt-2 text-sm">
                      <Label>Current Class:</Label>
                      <div className="text-gray-700">{classificationBody.value}</div>
                    </div>
                )}

              </div>
            </div>
          </CardContent>

          <div className="px-3 py-1 flex justify-between items-center">
            <div className="flex gap-2">
              <Button
                  size="sm"
                  variant="default"
                  onClick={handleSavePngFromRectangle}
              >
                Save PNG
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Delete
              </Button>
              <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!selectedColor}
              >
                Save
              </Button>
            </div>
          </div>

          {/* AI Agent chatBot */}
          {/* <div className="px-3 py-2 pb-4 border-t">
            <div className="flex items-start gap-2">
              <Label className="shrink-0 ">Ask TissueLab</Label>
              <div className="flex-1 flex gap-2">
                <Textarea
                    placeholder="Type your text here..."
                    value={aiMessage}
                    onChange={(e) => setAiMessage(e.target.value)}
                    className="min-h-[100px] resize-none"
                />
                <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!aiMessage.trim()}
                    className="self-end"
                >
                  Send
                </Button>
              </div>
            </div>
          </div> */}
        </div>
      </Card>
  );
}
