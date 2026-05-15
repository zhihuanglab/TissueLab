import { useEffect, useRef } from 'react';
import { useAnnotator } from '@annotorious/react';
import { mountPlugin as mountToolsPlugin } from '@annotorious/plugin-tools';
import { useDispatch, useSelector } from "react-redux";
import {
    addAnnotation, removeAnnotationById,
    setAnnotations,
    toggleEditPanel,
    updateAnnotationById
} from "@/store/slices/viewer/annotationSlice";
import {RootState} from "@/store";
import { resetSegmentationData } from "@/services/file.service";
import OpenSeadragon from 'openseadragon';
import { setShapeData, resetShapeData } from "@/store/slices/viewer/shapeSlice";
import { ensureValidAnnotation } from '@/utils/annotationUtils';


const useAnnotatorInitialization = () => {
    const dispatch = useDispatch();
    const annotatorInstance = useAnnotator<any>();
    const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
    const annotatorRef = useRef<any>(null);
    const lastVisibleSignatureRef = useRef<string>("");
    const rafIdRef = useRef<number | null>(null);

    const annotations = useSelector((state: RootState) => state.annotations.annotations)
    const editAnnotation = useSelector((state: RootState) => state.annotations.editAnnotation)

    useEffect(() => {
        if (annotatorInstance) {
            mountToolsPlugin(annotatorInstance);
            annotatorRef.current = annotatorInstance;
            viewerRef.current = annotatorInstance.viewer;

            annotatorInstance.on('createAnnotation', (annotation: any) => {
                console.log('Annotation created:', annotation);
                // Only add user-generated annotations to Redux
                if (!annotation.isBackend) {
                    dispatch(addAnnotation(annotation));
                }
            });

            annotatorInstance.on('deleteAnnotation', (annotation: any) => {
                console.log('Annotation deleted:', annotation);
                dispatch(removeAnnotationById(annotation.id));
            });

            // add listeners
            annotatorInstance.on('viewportIntersect', (viewportAnnotations: any) => {
                // Create a set of IDs for annotations currently in viewport for quick lookup
                const visibleAnnotationIds = new Set(viewportAnnotations.map((a: any) => a.id));

                // Only consider user annotations (exclude backend) to minimize churn
                const userAnnotations = annotatorInstance
                    .getAnnotations()
                    .filter((annotation: any) => !annotation.isBackend);

                // Build a stable signature: user annotation count + sorted visible IDs
                const signature = `${userAnnotations.length}|${Array.from(visibleAnnotationIds).sort().join(',')}`;

                // Skip if nothing changed to avoid dispatch loops
                if (lastVisibleSignatureRef.current === signature) return;
                lastVisibleSignatureRef.current = signature;

                // Prepare payload lazily; defer dispatch to next animation frame to avoid nested updates
                const buildPayload = () =>
                  userAnnotations.map((annotation: any) => ({
                    ...annotation,
                    isVisible: visibleAnnotationIds.has(annotation.id)
                  }));

                if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = requestAnimationFrame(() => {
                  try {
                    const payload = buildPayload();
                    dispatch(setAnnotations(payload));
                  } finally {
                    rafIdRef.current = null;
                  }
                });
            });
            annotatorInstance.on('updateAnnotation', (updated: any, previous: any) => {
                // Only update user-generated annotations in Redux
                if (!updated.isBackend) {
                    dispatch(updateAnnotationById({
                        id: previous.id,
                        data: updated
                    }))
                }
            })
            annotatorInstance.on('selectionChanged', (selected: any[]) => {
                // Maintain existing behavior
                dispatch(toggleEditPanel());
                
                // Handle overlay highlight via shapeSlice
                if (!selected || selected.length === 0) {
                    dispatch(resetShapeData());
                    return;
                }

                const annotation = selected[selected.length - 1];
                const selector = Array.isArray(annotation?.target?.selector)
                  ? annotation.target.selector[0]
                  : annotation?.target?.selector;

                // Ruler annotations (LINE type) should not trigger cell highlighting
                if (selector?.type === 'LINE') {
                    dispatch(resetShapeData());
                    return;
                }

                const selectorCandidate = Array.isArray(annotation?.target?.selector)
                  ? annotation.target.selector.find((s: any) => s?.type === 'POLYGON' || s?.type === 'RECTANGLE' || s?.geometry?.bounds)
                  : annotation?.target?.selector;

                if (!selectorCandidate) {
                    dispatch(resetShapeData());
                    return;
                }

                try {
                    const selector: any = selectorCandidate;
                    if (selector.type === 'RECTANGLE' && selector.geometry?.bounds) {
                        const { minX, minY, maxX, maxY } = selector.geometry.bounds;
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        dispatch(setShapeData({ rectangleCoords: coords }));
                    } else if (selector.type === 'POLYGON' && Array.isArray(selector.geometry?.points) && selector.geometry.points.length > 0) {
                        const points: [number, number][] = selector.geometry.points as [number, number][];
                        let minX = points[0][0], minY = points[0][1], maxX = points[0][0], maxY = points[0][1];
                        for (const [px, py] of points) {
                            if (px < minX) minX = px;
                            if (py < minY) minY = py;
                            if (px > maxX) maxX = px;
                            if (py > maxY) maxY = py;
                        }
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        const polygonPoints = points.map(([px, py]) => [px, py] as [number, number]);
                        dispatch(setShapeData({ rectangleCoords: coords, polygonPoints }));
                    } else if (selector.geometry?.bounds) {
                        // Fallback for shapes with bounds
                        const { minX, minY, maxX, maxY } = selector.geometry.bounds;
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        dispatch(setShapeData({ rectangleCoords: coords }));
                    } else {
                        dispatch(resetShapeData());
                    }
                } catch (e) {
                    dispatch(resetShapeData());
                }
            });

            // parse persisted data
            for (const annotation of annotations) {
                const validAnnotation = ensureValidAnnotation(annotation);
                annotatorInstance.addAnnotation(validAnnotation);
            }

            return () => {
                if (annotatorInstance) {
                    annotatorInstance.clearAnnotations();
                }

                if (viewerRef.current) {
                    viewerRef.current = null;
                }

                // Reset segmentation data when component unmounts
                resetSegmentationData()
                    .then(response => {
                        console.log('[Annotator Cleanup] Successfully reset segmentation data:', response);
                    })
                    .catch(error => {
                        console.error('[Annotator Cleanup] Failed to reset segmentation data:', error);
                    });
            }
        }
    }, [annotatorInstance]);


    useEffect(() => {
        if (annotatorInstance && annotatorInstance.viewer && editAnnotation) {
            annotatorInstance.fitBounds(editAnnotation, { immediately: true, padding: 20 });
        }
    }, [editAnnotation, annotatorInstance]);


    // add new annotation
    const addNewAnnotation = async (annotation: any) => {
        if (annotatorRef.current) {
            try {
                const validAnnotation = ensureValidAnnotation(annotation);
                await annotatorRef.current.addAnnotation(validAnnotation);
                // dispatch(addAnnotation(annotation));

            } catch (error) {
                console.error('Error adding annotation:', error);
            }
        } else {
            console.warn('Annotator instance not available');
        }
    };

    return { annotatorInstance, viewerRef, addNewAnnotation }
};

export default useAnnotatorInitialization;
