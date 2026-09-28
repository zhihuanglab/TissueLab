import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { RootState } from "@/store";
import { selectPatchClassificationData, setEditAnnotations } from "@/store/slices/viewer/annotationSlice";
import { useAnnotationTypes } from "@/store/zustand/slice/annotationTypesStore";
import { isSegmentationHandlerNotReadyError, segFetch } from '@/utils/common/segFetch';
import { getClassColor } from "@/utils/agent/patchClassification.utils";
import { apiListManualAnnotations } from "@/utils/viewer/manualAnnotation.api";
import { verticesBounds, MANUAL_SOURCE, toManualZarrPath } from "@/utils/viewer/annotation.utils";
import { getLargestTiledImage } from "@/utils/viewer/viewerHelpers";
import {
  ChevronDown,
  Eye,
} from "lucide-react";
import OpenSeadragon from "openseadragon";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { getErrorMessage } from "@/utils/common/apiResponse";
import {
  AnnoActionButtons,
  AnnoLayerCard,
  AnnoTableCard,
  SidebarPagination,
} from "./Anno-LayerCard";

type AnnotationGeometry = {
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: Array<[number, number] | number[]>;
  [key: string]: unknown;
};

type AnnotationSelector = {
  type?: string;
  class_id?: string | number;
  class_name?: string;
  class_hex_color?: string;
  geometry?: AnnotationGeometry;
  [key: string]: unknown;
};

type AnnotationTarget = {
  created?: string;
  selector: AnnotationSelector;
  [key: string]: unknown;
};

export interface AnnotationRecord {
  id?: string | number;
  target?: AnnotationTarget;
  annotations?: AnnotationRecord[];
  isBackend?: boolean;
  // New simplified format from zarr (direct fields, no zoom scale)
  centroids?: [number, number];
  contours?: Array<[number, number] | number[]>;
  color?: string | null;  // From ClassificationNode, null if no classification
  classid?: number | null;
  classname?: string;  // From ClassificationNode, "N/A" if no classification
  minX?: number;
  minY?: number;
  maxX?: number;
  maxY?: number;
  [key: string]: unknown;
}

interface AnnotationFilters {
  state?: string[];
  annotationType?: string[];
  class_name?: string[];
  class_hex_color?: string[];
  class_id?: string[];
}

interface LayerItem {
  key: string;
  type: "user" | "ai" | "patch";
  layer_name: string;
  completed_at: string;
  annotations: AnnotationRecord[];
  isPaginated: boolean;
  pagination?: {
    total: number;
    current: number;
    pageSize: number;
  };
}

interface FilterOption {
  label: React.ReactNode;
  value: string;
}

// Slide-name extensions we strip from the filename prefix on exports so
// `slide123.svs` lands as `slide123_Cell_Classification.csv` (NOT
// `slide123.svs_Cell_Classification.csv`). Mirrors the BE helper at
// `_slide_stem_for_filename` in app/api/seg.py.
const SLIDE_EXTS = [
  ".zarr.zip", ".zarr", ".svs", ".tiff", ".tif", ".ndpi", ".mrxs",
  ".scn", ".bif", ".czi", ".dcm", ".vsi", ".qptiff",
];

const slideStemFromPath = (p: string | null | undefined): string => {
  if (!p) return "";
  const last = p.replace(/\\/g, "/").split("/").pop() || "";
  const lower = last.toLowerCase();
  let stem = last;
  for (const ext of SLIDE_EXTS) {
    if (lower.endsWith(ext)) {
      stem = last.slice(0, -ext.length);
      break;
    }
  }
  // Same safe-charset rule as the BE helper.
  return stem.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
};

const triggerBrowserDownload = (
  data: unknown,
  filename: string,
  mimeType: string,
) => {
  // Handle string data (e.g., CSV) and object data (e.g., JSON) differently
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => window.URL.revokeObjectURL(url), 100);
};

const formatDate = (value: string | undefined) => {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

const applyFilters = (
  data: AnnotationRecord[],
  filters: AnnotationFilters,
): AnnotationRecord[] => {
  if (!filters) return data;

  return data.filter((record) => {
    const selector = record.target?.selector;
    const effectiveClassName =
      selector?.class_name && selector.class_name !== "N/A"
        ? selector.class_name
        : record.classname && record.classname !== "N/A"
          ? record.classname
          : undefined;
    const effectiveClassId =
      selector?.class_id !== undefined
        ? String(selector.class_id)
        : record.classid !== undefined && record.classid !== null
          ? String(record.classid)
          : undefined;
    const effectiveClassColor =
      selector?.class_hex_color
        ? selector.class_hex_color
        : record.color ?? undefined;
    const stateMatch =
      !filters.state ||
      filters.state.length === 0 ||
      filters.state.includes("finished");

    const typeMatch =
      !filters.annotationType ||
      filters.annotationType.length === 0 ||
      (selector?.type
        ? filters.annotationType.includes(selector.type)
        : true);

    const classNameMatch =
      !filters.class_name ||
      filters.class_name.length === 0 ||
      (effectiveClassName ? filters.class_name.includes(effectiveClassName) : false);

    const classIdMatch =
      !filters.class_id ||
      filters.class_id.length === 0 ||
      (effectiveClassId ? filters.class_id.includes(effectiveClassId) : false);

    const classColorMatch =
      !filters.class_hex_color ||
      filters.class_hex_color.length === 0 ||
      (effectiveClassColor
        ? filters.class_hex_color.includes(effectiveClassColor)
        : false);

    return (
      stateMatch && typeMatch && classNameMatch && classIdMatch && classColorMatch
    );
  });
};

const FilterDropdown: React.FC<{
  label: string;
  options: FilterOption[];
  values: string[];
  onChange: (nextValues: string[]) => void;
}> = ({ label, options, values, onChange }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        variant="outline"
        size="sm"
        className="inline-flex items-center gap-2"
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-48">
      {options.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.value}
          checked={values.includes(option.value)}
          onCheckedChange={(checked) => {
            if (checked) {
              onChange([...values, option.value]);
            } else {
              onChange(values.filter((value) => value !== option.value));
            }
          }}
          className="capitalize"
        >
          {option.label}
        </DropdownMenuCheckboxItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

const EmptyState = ({ message }: { message: string }) => (
  <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground px-4 py-2">
    {message}
  </div>
);

const SidebarAnnotation: React.FC = () => {
  const dispatch = useDispatch();
  const { viewerInstance, annotatorInstance } = useAnnotatorInstance();
  const { annotationTypes, version: annotationTypeVersion } = useAnnotationTypes();
  
  // Ref to store the highlight timeout timer
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Refs to store viewport animation handler + fallback timeout (avoid leaks on repeated clicks/unmount)
  const animationFinishHandlerRef = useRef<(() => void) | null>(null);
  const animationFallbackTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [expandedLayers, setExpandedLayers] = useState<Record<string, boolean>>(
    {},
  );

  const [aiAnnotationFilters, setAiAnnotationFilters] =
    useState<AnnotationFilters>({});

  const allAnnotations = useSelector(
    (state: RootState) => state.annotations.annotations,
  );
  const patchClassificationData = useSelector(selectPatchClassificationData);
  const currentImagePath = useActiveSlidePath();
  const { assertWritable, allowed: pathWritable } = usePathWriteAccess(currentImagePath);
  const activeInstanceId = useSelector(
    (state: RootState) => state.wsi.activeInstanceId,
  );
  const userAnnotations = useMemo(
    () => allAnnotations.filter((annotation) => !annotation.isBackend),
    [allAnnotations],
  );

  const [aiAnnotations, setAiAnnotations] = useState<AnnotationRecord[]>([]);
  // Saved user annotations (one entry per save event: class_name / method /
  // datetime / vertices), fetched from the backend so the panel shows the
  // REAL stored annotations rather than the in-memory annotorious shapes.
  const [savedUserAnnotations, setSavedUserAnnotations] = useState<any[]>([]);
  const savedUserFetchSeqRef = useRef(0);
  // Per-classifier run metadata (created_at) from <X-Classification>/metadata,
  // refreshed each classification run — used for the cell/patch "most recent".
  const [classificationMeta, setClassificationMeta] = useState<{
    cell?: { created_at?: string } | null;
    patch?: { created_at?: string } | null;
  }>({});
  const [aiAnnotationsPatch, setAiAnnotationsPatch] = useState<
    AnnotationRecord[]
  >([]);
  const [totalAiAnnotations, setTotalAiAnnotations] = useState(0);
  const [totalAiAnnotationsPatch, setTotalAiAnnotationsPatch] = useState(0);

  const [aiPagination, setAiPagination] = useState({
    offset: 0,
    limit: 20,
    current: 1,
  });
  const [aiPaginationPatch, setAiPaginationPatch] = useState({
    offset: 0,
    limit: 20,
    current: 1,
  });
  const [loading, setLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadStage, setDownloadStage] = useState<"downloading" | "saving">("downloading");
  const [activeDownloadFormat, setActiveDownloadFormat] = useState<"csv" | "geojson">("geojson");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [downloadTotalBytes, setDownloadTotalBytes] = useState<number | null>(null);
  // Concurrent downloads, each tracked independently so their progress updates
  // don't collide on one shared bar (which made it flicker between processes).
  const [downloads, setDownloads] = useState<Array<{
    id: string;
    scope: "cell" | "user" | "patch";
    format: "csv" | "geojson";
    progress: number;
    stage: "downloading" | "saving";
    bytes: number;
    total: number | null;
  }>>([]);

  const classIndexToName = useMemo(() => {
    const map = new Map<number, string>();
    annotationTypes.forEach((entry) => {
      if (entry.classIndex !== undefined && entry.category) {
        map.set(entry.classIndex, entry.category);
      }
    });
    return map;
  }, [annotationTypes, annotationTypeVersion]);

  const classIndexToColor = useMemo(() => {
    const map = new Map<number, string>();
    annotationTypes.forEach((entry) => {
      if (entry.classIndex !== undefined && entry.color) {
        map.set(entry.classIndex, entry.color);
      }
    });
    return map;
  }, [annotationTypes, annotationTypeVersion]);

  // Cleanup highlight timeout on component unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      if (animationFallbackTimeoutRef.current) {
        clearTimeout(animationFallbackTimeoutRef.current);
        animationFallbackTimeoutRef.current = null;
      }
      if (animationFinishHandlerRef.current && viewerInstance?.viewport) {
        const viewport = viewerInstance.viewport as any;
        viewport?.removeHandler?.("animation-finish", animationFinishHandlerRef.current);
        animationFinishHandlerRef.current = null;
      }
    };
  }, []);

  // Cleanup highlight timeout on component unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      // Cleanup any pending viewport animation handler/timeout
      if (animationFallbackTimeoutRef.current) {
        clearTimeout(animationFallbackTimeoutRef.current);
        animationFallbackTimeoutRef.current = null;
      }
      if (animationFinishHandlerRef.current && viewerInstance?.viewport) {
        const viewport = viewerInstance.viewport as any;
        viewport?.removeHandler?.("animation-finish", animationFinishHandlerRef.current);
        animationFinishHandlerRef.current = null;
      }
    };
  }, [viewerInstance]);

  const moveTo = (record: AnnotationRecord) => {
    if (record.id !== undefined) {
      dispatch(setEditAnnotations(String(record.id)));
    }
  };

  // Zoom to cell centroids - centers the centroids coordinate in viewport
  // Uses centroids data directly from Zarr File Viewer
  const zoomToRecordBoundsFromZarr = (record: AnnotationRecord) => {
    try {
      if (!viewerInstance?.viewport || !viewerInstance.world || viewerInstance.world.getItemCount() === 0) {
        return;
      }

      // Require centroids - they must be present to center the view
      if (!record.centroids || !Array.isArray(record.centroids) || record.centroids.length < 2) {
        console.warn('[SidebarAnnotation] Centroids required for zoom');
        return;
      }

      const centerX = Number(record.centroids[0]);
      const centerY = Number(record.centroids[1]);

      if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
        console.warn('[SidebarAnnotation] Invalid centroids coordinates');
        return;
      }

      console.log('[SidebarAnnotation] Zooming to centroids:', { id: record.id, centerX, centerY });

      // Get tiled image for coordinate conversion
      const tiledImage = getLargestTiledImage(viewerInstance);

      // Use a fixed high zoom level for consistent cell viewing
      const maxZoom = viewerInstance.viewport.getMaxZoom();
      const minZoom = viewerInstance.viewport.getMinZoom();
      const targetZoom = minZoom + (maxZoom - minZoom) * 0.8;
      
      // Convert centroids to viewport coordinates at target zoom
      // First set zoom temporarily to get accurate coordinate conversion
      const currentZoom = viewerInstance.viewport.getZoom();
      viewerInstance.viewport.zoomTo(targetZoom, undefined, true);
      
      // Now convert centroids coordinates at the target zoom level
      const centerPoint = new OpenSeadragon.Point(centerX, centerY);
      const viewportCenter = tiledImage 
        ? tiledImage.imageToViewportCoordinates(centerPoint)
        : viewerInstance.viewport.imageToViewportCoordinates(centerPoint);
      
      // Pan to centroids and zoom, keeping centroids at center
      viewerInstance.viewport.panTo(viewportCenter, false);
      viewerInstance.viewport.zoomTo(targetZoom, viewportCenter, false);
      viewerInstance.viewport.applyConstraints();
    } catch (e) {
      console.warn('[SidebarAnnotation] Failed to zoom to record bounds:', e);
    }
  };

  const handleViewRecord = (record: AnnotationRecord) => {
    moveTo(record);
    
    // Clear any existing highlight timeout
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }

    // Clear any previous viewport animation handler/timeout (if user clicks again before animation completes)
    if (animationFallbackTimeoutRef.current) {
      clearTimeout(animationFallbackTimeoutRef.current);
      animationFallbackTimeoutRef.current = null;
    }
    if (animationFinishHandlerRef.current && viewerInstance?.viewport) {
      const viewport = viewerInstance.viewport as any;
      viewport?.removeHandler?.("animation-finish", animationFinishHandlerRef.current);
      animationFinishHandlerRef.current = null;
    }
    
    // Select the annotation to highlight it with bright border
    if (annotatorInstance && record.id !== undefined) {
      try {
        annotatorInstance.setSelected?.(String(record.id));
        
        // Auto-deselect after 10 seconds
        highlightTimeoutRef.current = setTimeout(() => {
          try {
            annotatorInstance.setSelected?.([]);
            highlightTimeoutRef.current = null;
          } catch (e) {
            console.warn('[SidebarAnnotation] Failed to deselect annotation:', e);
          }
        }, 10000); // 10 seconds
      } catch (e) {
        console.warn('[SidebarAnnotation] Failed to select annotation:', e);
      }
    }
    
    // First zoom out to full image, then zoom in to target
    if (viewerInstance?.viewport && viewerInstance?.world && viewerInstance.world.getItemCount() > 0) {
      try {
        // Get the main tiled image bounds for zoom out
        const tiledImage = getLargestTiledImage(viewerInstance);
        
        if (tiledImage) {
          const bounds = tiledImage.getBounds();
          if (bounds) {
            // Zoom out to full image first
            viewerInstance.viewport.fitBounds(bounds, false);
            viewerInstance.viewport.applyConstraints();
            
            // Wait for zoom out animation to complete using OpenSeadragon animation finish event
            // This avoids race conditions from fixed timeouts
            const viewport = viewerInstance.viewport as any;
            const animationFinishHandler = () => {
              // Remove handler + timeout to prevent multiple calls
              viewport?.removeHandler?.("animation-finish", animationFinishHandler);
              animationFinishHandlerRef.current = null;
              if (animationFallbackTimeoutRef.current) {
                clearTimeout(animationFallbackTimeoutRef.current);
                animationFallbackTimeoutRef.current = null;
              }
              zoomToRecordBoundsFromZarr(record);
            };

            // Listen for animation completion
            viewport?.addHandler?.("animation-finish", animationFinishHandler);
            animationFinishHandlerRef.current = animationFinishHandler;

            // Fallback timeout in case animation event doesn't fire (e.g., if animation is disabled or very fast)
            // Use a reasonable timeout based on animationTime setting (default 0.3s, so 500ms should be safe)
            animationFallbackTimeoutRef.current = setTimeout(() => {
              viewport?.removeHandler?.("animation-finish", animationFinishHandler);
              animationFinishHandlerRef.current = null;
              animationFallbackTimeoutRef.current = null;
              zoomToRecordBoundsFromZarr(record);
            }, 500);
            
            return;
          }
        }
      } catch (e) {
        console.warn('[SidebarAnnotation] Failed to zoom out, proceeding directly to zoom in:', e);
      }
    }
    
    // Fallback: zoom in directly if zoom out fails
    requestAnimationFrame(() => zoomToRecordBoundsFromZarr(record));
  };

  const fetchAiAnnotations = async (offset: number, limit: number) => {
    if (!currentImagePath || !activeInstanceId) return;
    try {
      setLoading(true);
      const response = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/?offset=${offset}&limit=${limit}`, {
          method: 'GET',
          
          returnAxiosFormat: true,
        });
      const data = response.data;
      if (!data) {
        throw new Error("Unexpected response structure");
      }

      setAiAnnotations(data.annotations ?? []);
      setTotalAiAnnotations(data.count ?? 0);

      if (data.annotations && data.annotations.length < limit) {
        const newTotal = offset + data.annotations.length;
        setTotalAiAnnotations(newTotal);
      }
    } catch (error) {
      if (isSegmentationHandlerNotReadyError(error)) {
        // A slide switch tears down the old handler before the new one is
        // ready. This is an expected transient state, not a dev-runtime error.
        return;
      }
      console.warn("Error fetching AI annotations:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSavedUserAnnotations = async () => {
    if (!currentImagePath || !activeInstanceId) return;
    const seq = ++savedUserFetchSeqRef.current;
    const pathAtStart = currentImagePath;
    const instanceAtStart = activeInstanceId;
    try {
      const response = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/user/list`, { method: 'GET',  returnAxiosFormat: true });
      if (seq !== savedUserFetchSeqRef.current) return;
      // success_response wraps as { data: { annotations, total } }.
      const payload = response?.data?.data ?? response?.data;
      const cellPatch = Array.isArray(payload?.annotations) ? payload.annotations : [];

      let manuals: any[] | null = null;
      try {
        const zarrPath = toManualZarrPath(pathAtStart);
        if (zarrPath && instanceAtStart) {
          const records = await apiListManualAnnotations(instanceAtStart, zarrPath);
          if (seq !== savedUserFetchSeqRef.current) return;
          manuals = records.map((r) => ({
            source: MANUAL_SOURCE,
            id: r.id,
            shape: r.shape,
            class_name: r.comment?.trim()
              ? r.comment
              : `${r.shape || "drawing"}`,
            class_color_hex: r.style || "#00ff00",
            method: `manual ${r.shape || "drawing"}`,
            datetime: r.datetime,
            annotator: r.annotator,
            vertices: r.vertices,
          }));
        } else {
          manuals = [];
        }
      } catch (manualErr) {
        console.warn("Error fetching manual annotations:", manualErr);
        // Keep previously listed drawings — do not blank the sidebar on a
        // transient manuals API failure while cell/patch still succeeded.
        manuals = null;
      }

      if (seq !== savedUserFetchSeqRef.current) return;
      if (manuals === null) {
        setSavedUserAnnotations((prev) => [
          ...prev.filter((a: any) => a?.source === MANUAL_SOURCE),
          ...cellPatch,
        ]);
      } else {
        setSavedUserAnnotations([...manuals, ...cellPatch]);
      }
    } catch (error) {
      if (seq !== savedUserFetchSeqRef.current) return;
      if (isSegmentationHandlerNotReadyError(error)) return;
      console.warn("Error fetching saved user annotations:", error);
    }
  };

  const focusManualAnnotation = (rec: any) => {
    try {
      const id = rec?.id ? String(rec.id) : '';
      const live =
        id && annotatorInstance?.getAnnotationById
          ? annotatorInstance.getAnnotationById(id)
          : null;

      if (live && annotatorInstance) {
        try {
          annotatorInstance.setSelected?.(id);
          annotatorInstance.fitBounds?.(id, {
            immediately: false,
            padding: 40,
          });
          return;
        } catch {}
      }

      // Hydrate may still be in flight — zoom via stored vertices, then select
      // if/when the shape appears on the canvas.
      const bounds = verticesBounds(rec?.vertices || []);
      if (!bounds || !viewerInstance?.viewport) return;
      const tiledImage = getLargestTiledImage(viewerInstance);
      const rect = new OpenSeadragon.Rect(
        bounds.minX,
        bounds.minY,
        Math.max(1, bounds.maxX - bounds.minX),
        Math.max(1, bounds.maxY - bounds.minY),
      );
      const vpRect = tiledImage
        ? tiledImage.imageToViewportRectangle(rect)
        : viewerInstance.viewport.imageToViewportRectangle(rect);
      viewerInstance.viewport.fitBounds(vpRect, false);
      viewerInstance.viewport.applyConstraints();
      if (id && annotatorInstance?.setSelected) {
        try {
          annotatorInstance.setSelected(id);
        } catch {}
      }
    } catch (e) {
      console.warn("[SidebarAnnotation] Failed to focus manual annotation:", e);
    }
  };

  const fetchClassificationMeta = async () => {
    if (!currentImagePath || !activeInstanceId) return;
    try {
      const response = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/classification/metadata`, { method: 'GET',  returnAxiosFormat: true });
      const payload = response?.data?.data ?? response?.data;
      setClassificationMeta({
        cell: payload?.cell ?? null,
        patch: payload?.patch ?? null,
      });
    } catch (error) {
      if (isSegmentationHandlerNotReadyError(error)) return;
      console.warn("Error fetching classification metadata:", error);
    }
  };

  const fetchAiAnnotationsPatch = async (offset: number, limit: number) => {
    if (!currentImagePath || !activeInstanceId) return;
    try {
      setLoading(true);
      const response = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/patches/?offset=${offset}&limit=${limit}`, {
          method: 'GET',
          
          returnAxiosFormat: true,
        });
      const data = response.data;
      if (!data) {
        throw new Error("Unexpected response structure");
      }

      setAiAnnotationsPatch(data.annotations ?? []);
      setTotalAiAnnotationsPatch(data.count ?? 0);

      if (data.annotations && data.annotations.length < limit) {
        const newTotal = offset + data.annotations.length;
        setTotalAiAnnotationsPatch(newTotal);
      }
    } catch (error) {
      if (isSegmentationHandlerNotReadyError(error)) {
        return;
      }
      console.warn("Error fetching AI annotations patch:", error);
    } finally {
      setLoading(false);
    }
  };

  // Switching the active image resets both classification layers back to the
  // first page; otherwise the sidebar keeps showing the previous image's
  // annotations until the user manually paginates.
  useEffect(() => {
    setAiPagination((prev) => ({ ...prev, offset: 0, current: 1 }));
    setAiPaginationPatch((prev) => ({ ...prev, offset: 0, current: 1 }));
  }, [currentImagePath]);

  // Refresh the saved user-annotation list on slide change, in-memory count
  // changes, and explicit manual persist events (Footer Save / hydrate).
  useEffect(() => {
    fetchSavedUserAnnotations();
    fetchClassificationMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImagePath, activeInstanceId, userAnnotations.length]);

  useEffect(() => {
    const onManualChanged = () => {
      fetchSavedUserAnnotations();
    };
    window.addEventListener('manual-annotations-changed', onManualChanged);
    return () =>
      window.removeEventListener('manual-annotations-changed', onManualChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImagePath, activeInstanceId]);

  useEffect(() => {
    fetchAiAnnotations(aiPagination.offset, aiPagination.limit);
  }, [aiPagination.offset, aiPagination.limit, currentImagePath, activeInstanceId]);

  useEffect(() => {
    fetchAiAnnotationsPatch(aiPaginationPatch.offset, aiPaginationPatch.limit);
  }, [aiPaginationPatch.offset, aiPaginationPatch.limit, currentImagePath, activeInstanceId]);

  const uniquePatchIds = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotationsPatch
            .map((annotation) =>
              annotation.target?.selector?.class_id ?? annotation.classid,
            )
            .filter((value): value is string | number => value !== undefined),
        ),
      ),
    [aiAnnotationsPatch],
  );

  const patchClassIdToName = useMemo(() => {
    if (!patchClassificationData) {
      return new Map<number, string>();
    }
    const map = new Map<number, string>();
    patchClassificationData.class_id.forEach((id, index) => {
      const name = patchClassificationData.class_name[index];
      if (typeof id === "number" && typeof name === "string" && name) {
        map.set(id, name);
      }
    });
    return map;
  }, [patchClassificationData]);

  const uniquePatchNamesResolved = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotationsPatch
            .map((annotation) => {
              const selector = annotation.target?.selector;
              if (selector?.class_name && selector.class_name !== "N/A") {
                return selector.class_name;
              }
              if (annotation.classname && annotation.classname !== "N/A") {
                return annotation.classname;
              }
              const classId =
                selector?.class_id !== undefined
                  ? Number(selector.class_id)
                  : annotation.classid !== undefined && annotation.classid !== null
                    ? Number(annotation.classid)
                    : undefined;
              if (classId === undefined || Number.isNaN(classId)) return undefined;
              return patchClassIdToName.get(classId);
            })
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    [aiAnnotationsPatch, patchClassIdToName],
  );

  const uniquePatchColors = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotationsPatch
            .map(
              (annotation) =>
                annotation.target?.selector?.class_hex_color ?? annotation.color,
            )
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    [aiAnnotationsPatch],
  );

  const uniqueCellIds = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotations
            .map(
              (annotation) =>
                annotation.target?.selector?.class_id ?? annotation.classid,
            )
            .filter(
              (value): value is string | number =>
                value !== undefined && value !== null,
            ),
        ),
      ),
    [aiAnnotations],
  );

  const uniqueCellNamesResolved = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotations
            .map((annotation) => {
              const selector = annotation.target?.selector;
              if (selector?.class_name && selector.class_name !== "N/A") {
                return selector.class_name;
              }
              if (annotation.classname && annotation.classname !== "N/A") {
                return annotation.classname;
              }
              const classId =
                selector?.class_id !== undefined
                  ? Number(selector.class_id)
                  : annotation.classid !== undefined && annotation.classid !== null
                    ? Number(annotation.classid)
                    : undefined;
              if (classId === undefined || Number.isNaN(classId)) return undefined;
              return classIndexToName.get(classId);
            })
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    [aiAnnotations, classIndexToName],
  );

  const uniqueCellColors = useMemo(
    () =>
      Array.from(
        new Set(
          aiAnnotations
            .map(
              (annotation) =>
                annotation.target?.selector?.class_hex_color ?? annotation.color,
            )
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    [aiAnnotations],
  );

  const layerItems: LayerItem[] = useMemo(() => {
    const layers = [
      {
        key: "user",
        type: "user" as const,
        layer_name: "User-generated annotations",
        // Count + "most recent" come from the SAVED annotations (what the
        // panel actually lists), not the in-memory annotorious shapes.
        completed_at:
          savedUserAnnotations.length > 0
            ? formatDate(
                new Date(
                  Math.max(
                    ...savedUserAnnotations.map((r) => Number(r.datetime) || 0),
                  ),
                ).toISOString(),
              )
            : "N/A",
        annotations: savedUserAnnotations as unknown as AnnotationRecord[],
        isPaginated: false,
      },
      {
        key: "ai",
        type: "ai" as const,
        layer_name: "Cell Classification Overview",
        // Most-recent = the classifier's last run time (metadata.created_at),
        // refreshed every classification run by the model-zoo tasknode.
        completed_at: classificationMeta.cell?.created_at
          ? formatDate(classificationMeta.cell.created_at)
          : "N/A",
        annotations: aiAnnotations,
        isPaginated: true,
        pagination: {
          total: totalAiAnnotations,
          current: aiPagination.current,
          pageSize: aiPagination.limit,
        },
      },
      {
        key: "patch",
        type: "patch" as const,
        layer_name: "Patch Classification Overview",
        completed_at: classificationMeta.patch?.created_at
          ? formatDate(classificationMeta.patch.created_at)
          : "N/A",
        annotations: aiAnnotationsPatch,
        isPaginated: true,
        pagination: {
          total: totalAiAnnotationsPatch,
          current: aiPaginationPatch.current,
          pageSize: aiPaginationPatch.limit,
        },
      },
    ];

    return layers;
  }, [
    userAnnotations,
    savedUserAnnotations,
    classificationMeta,
    aiAnnotations,
    aiAnnotationsPatch,
    totalAiAnnotations,
    totalAiAnnotationsPatch,
    aiPagination,
    aiPaginationPatch,
  ]);

  const toggleLayer = (key: string) => {
    setExpandedLayers((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handlePageChange = (
    type: "ai" | "patch",
    page: number,
    pageSize: number,
  ) => {
    if (type === "ai") {
      setAiPagination({
        offset: (page - 1) * pageSize,
        limit: pageSize,
        current: page,
      });
    } else {
      setAiPaginationPatch({
        offset: (page - 1) * pageSize,
        limit: pageSize,
        current: page,
      });
    }
  };

  const handleDownloadAnnotations = async (
    scope: "cell" | "user" | "patch",
    format: "csv" | "geojson",
  ) => {
    if (!assertWritable("download annotations")) return;
    // Give THIS download its own entry + local setters, so concurrent downloads
    // each update an independent progress bar instead of one shared (flickering) one.
    const id = `${scope}-${format}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setDownloads((prev) => [...prev, { id, scope, format, progress: 0, stage: "downloading", bytes: 0, total: null }]);
    const setDownloadProgress = (v: number) => setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, progress: v } : d)));
    const setDownloadStage = (s: "downloading" | "saving") => setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, stage: s } : d)));
    const setDownloadedBytes = (b: number) => setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, bytes: b } : d)));
    const setDownloadTotalBytes = (t: number | null) => setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, total: t } : d)));
    try {
      setLoading(true);
      setDownloadProgress(0);
      setDownloadStage("downloading");
      setDownloadedBytes(0);
      setDownloadTotalBytes(null);

      const isGeoJson = format === "geojson";
      // Endpoint forks on scope; the streaming + progress UI is the same.
      //   cell  → AI cell-classification results
      //   patch → AI patch-classification results
      //   user  → user annotations (cell + patch)
      const urlBase =
        scope === "user"
          ? `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/export/user`
          : scope === "patch"
            ? `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/export/patch`
            : `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/export`;
      const url = isGeoJson ? `${urlBase}/geojson` : `${urlBase}/csv`;

      // Use apiFetch with isReturnResponse to get the full response object
      const response = await segFetch(activeInstanceId, url, {
        method: 'GET',
        
        isReturnResponse: true,
      }) as Response;

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Get Content-Length for progress tracking
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      setDownloadTotalBytes(total > 0 ? total : null);

      // Read the response stream with progress tracking
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const chunks: Uint8Array[] = [];
      let receivedLength = 0;
      let lastStageProgress = 0;
      const canAssembleDuringReceive = total > 0;
      const chunksAllDuringReceive = canAssembleDuringReceive ? new Uint8Array(total) : null;
      let writeOffset = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (canAssembleDuringReceive && chunksAllDuringReceive) {
          chunksAllDuringReceive.set(value, writeOffset);
          writeOffset += value.length;
        } else {
          chunks.push(value);
        }
        receivedLength += value.length;
        setDownloadedBytes(receivedLength);

        // Update progress
        if (total > 0) {
          const progress = Math.min((receivedLength / total) * 100, 100);
          const stageProgress = Math.min(progress * 0.99, 99);
          const rounded = Math.round(stageProgress * 10) / 10;
          lastStageProgress = rounded;
          setDownloadProgress(rounded);
        } else {
          // Content-Length unknown: use a slower asymptotic estimate that approaches 99%.
          const receivedMB = receivedLength / (1024 * 1024);
          const estimatedStageProgress = 99 * (1 - Math.exp(-receivedMB / 64));
          const rounded = Math.round(Math.min(99, estimatedStageProgress) * 10) / 10;
          lastStageProgress = rounded;
          setDownloadProgress(rounded);
        }
      }

      setDownloadStage("saving");
      const savingStartProgress = Math.max(99, lastStageProgress);
      setDownloadProgress(savingStartProgress);

      let chunksAll: Uint8Array;
      if (canAssembleDuringReceive && chunksAllDuringReceive) {
        chunksAll = writeOffset === chunksAllDuringReceive.length
          ? chunksAllDuringReceive
          : chunksAllDuringReceive.subarray(0, writeOffset);
        setDownloadProgress(99);
      } else {
        chunksAll = new Uint8Array(receivedLength);
        let position = 0;

        for (const chunk of chunks) {
          chunksAll.set(chunk, position);
          position += chunk.length;

          const assembledProgress = receivedLength > 0
            ? savingStartProgress + (position / receivedLength) * (99 - savingStartProgress)
            : 99;
          setDownloadProgress(Math.round(assembledProgress * 10) / 10);
        }
      }

      const blob = new Blob([chunksAll as BlobPart], {
        type: isGeoJson ? 'application/geo+json' : 'text/csv',
      });

      // Create a download link and trigger it
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      // Prefix the slide stem so multiple exports from different slides
      // sort together and the user can tell what each file came from.
      const slideStem = slideStemFromPath(currentImagePath);
      const kind =
        scope === "user"
          ? "User_Annotations"
          : scope === "patch"
            ? "Patch_Classification"
            : "Cell_Classification";
      const prefix = slideStem ? `${slideStem}_` : "";
      link.download = `${prefix}${kind}.${isGeoJson ? "geojson" : "csv"}`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setDownloadProgress(100);

      // Clean up the blob URL
      setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);

    } catch (error) {
      console.error("Error downloading annotation data:", error);
      toast.error(getErrorMessage(error, "Failed to download annotation data."));
    } finally {
      setLoading(false);
      // Keep this finished bar visible briefly, then drop only this download's entry.
      setTimeout(() => setDownloads((prev) => prev.filter((d) => d.id !== id)), 1000);
    }
  };

  const handleDownloadLayer = (layer: LayerItem) => {
    if (!assertWritable("download annotations")) return;
    // Cell classification (model output) and user-set annotations both go
    // through the streaming BE export. The dropdown lets users pick CSV /
    // GeoJSON; clicking the button itself defaults to CSV.
    if (layer.type === "ai") {
      handleDownloadAnnotations("cell", "csv");
      return;
    }
    if (layer.type === "user") {
      handleDownloadAnnotations("user", "csv");
      return;
    }

    // Other layer types (currently only patch) — keep the in-memory JSON
    // dump path until a backend export lands.
    triggerBrowserDownload(
      {
        ...layer,
        annotations: layer.annotations ?? [],
      },
      `${layer.layer_name}.json`,
      "application/json",
    );
  };

  const renderPaginator = (layer: LayerItem) => {
    if (!layer.pagination) return null;

    const { current, pageSize, total } = layer.pagination;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return (
      <SidebarPagination
        current={current}
        totalPages={totalPages}
        onPageChange={(page) =>
          handlePageChange(layer.type === "ai" ? "ai" : "patch", page, pageSize)
        }
      />
    );
  };

  const renderUserLayer = (_layer: LayerItem) => {
    return (
      <div className="space-y-4">
        <AnnoTableCard
          headers={
            <TableRow className="bg-muted text-muted-foreground">
              <TableHead className="rounded-tl-lg">Class</TableHead>
              <TableHead className="text-center">Method</TableHead>
              <TableHead className="text-center rounded-tr-lg">Time</TableHead>
            </TableRow>
          }
        >
          {savedUserAnnotations.length === 0 && (
            <TableRow>
              <TableCell colSpan={3}>
                <EmptyState message="No saved user annotations yet." />
              </TableCell>
            </TableRow>
          )}
          {savedUserAnnotations.map((rec, i) => (
            <TableRow
              key={`${rec.source ?? "?"}:${rec.id ?? rec.datetime ?? i}:${i}`}
              className="hover:bg-muted/60 cursor-pointer"
              onClick={() => {
                if (rec.source === MANUAL_SOURCE) focusManualAnnotation(rec);
              }}
            >
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
                    style={{ backgroundColor: rec.class_color_hex || "#aaaaaa" }}
                  />
                  <span>{rec.class_name ?? rec.class ?? "—"}</span>
                  {rec.source === "patch" && (
                    <span className="text-xs text-muted-foreground">(patch)</span>
                  )}
                  {rec.source === MANUAL_SOURCE && (
                    <span className="text-xs text-muted-foreground">(drawing)</span>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-center">{rec.method ?? "—"}</TableCell>
              <TableCell className="text-center">
                {rec.datetime
                  ? new Date(Number(rec.datetime)).toLocaleString()
                  : "N/A"}
              </TableCell>
            </TableRow>
          ))}
        </AnnoTableCard>
      </div>
    );
  };

  // Shared renderer for the cell ("ai") and patch classification overviews so
  // both layers expose the same Class / Class ID / Color columns and filters.
  const renderClassificationLayer = (
    layer: LayerItem,
    config: {
      classIdToName: Map<number, string>;
      classIdToColor?: Map<number, string>;
      uniqueNames: string[];
      uniqueIds: Array<string | number>;
      uniqueColors: string[];
      emptyMessage: string;
    },
  ) => {
    const {
      classIdToName,
      classIdToColor,
      uniqueNames,
      uniqueIds,
      uniqueColors,
      emptyMessage,
    } = config;
    const filteredAnnotations = applyFilters(
      layer.annotations,
      aiAnnotationFilters,
    );

    const resolveRow = (record: AnnotationRecord) => {
      const selector = record.target?.selector;
      const effectiveClassName =
        selector?.class_name && selector.class_name !== "N/A"
          ? selector.class_name
          : record.classname && record.classname !== "N/A"
            ? record.classname
            : undefined;
      const effectiveClassId =
        selector?.class_id !== undefined
          ? selector.class_id
          : record.classid !== undefined && record.classid !== null
            ? record.classid
            : undefined;
      const numericClassId =
        effectiveClassId !== undefined ? Number(effectiveClassId) : undefined;
      const hasNumericClassId =
        numericClassId !== undefined && !Number.isNaN(numericClassId);
      const resolvedName =
        effectiveClassName ??
        (hasNumericClassId
          ? classIdToName.get(numericClassId as number)
          : undefined);
      const effectiveClassColor =
        selector?.class_hex_color ??
        record.color ??
        (hasNumericClassId
          ? classIdToColor?.get(numericClassId as number)
          : undefined) ??
        undefined;
      return {
        className: resolvedName ?? "—",
        classId: effectiveClassId ?? "—",
        classColor: effectiveClassColor,
        effectiveClassName,
      };
    };

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Class"
            options={uniqueNames.map((name) => ({
              label: name,
              value: name,
            }))}
            values={aiAnnotationFilters.class_name ?? []}
            onChange={(values) =>
              setAiAnnotationFilters((prev) => ({
                ...prev,
                class_name: values.length ? values : undefined,
              }))
            }
          />
          <FilterDropdown
            label="Class ID"
            options={uniqueIds.map((id) => ({
              label: String(id),
              value: String(id),
            }))}
            values={aiAnnotationFilters.class_id ?? []}
            onChange={(values) =>
              setAiAnnotationFilters((prev) => ({
                ...prev,
                class_id: values.length ? values : undefined,
              }))
            }
          />
          <FilterDropdown
            label="Color"
            options={uniqueColors.map((color) => ({
              label: (
                <span className="inline-flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded"
                    style={{ backgroundColor: color }}
                  />
                  {color}
                </span>
              ),
              value: color,
            }))}
            values={aiAnnotationFilters.class_hex_color ?? []}
            onChange={(values) =>
              setAiAnnotationFilters((prev) => ({
                ...prev,
                class_hex_color: values.length ? values : undefined,
              }))
            }
          />
        </div>

        <AnnoTableCard
          headers={
            <TableRow className="bg-muted text-muted-foreground">
              <TableHead className="w-16 rounded-tl-lg">ID</TableHead>
              <TableHead className="w-28 text-center">Class</TableHead>
              <TableHead className="w-24 text-center">CID</TableHead>
              <TableHead className="w-24 text-center">Color</TableHead>
              <TableHead className="w-24 text-center rounded-tr-lg">Action</TableHead>
            </TableRow>
          }
          paginator={renderPaginator(layer)}
        >
          {filteredAnnotations.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>
                <EmptyState message={emptyMessage} />
              </TableCell>
            </TableRow>
          )}
          {filteredAnnotations.map((record) => {
            const { className, classId, classColor, effectiveClassName } =
              resolveRow(record);
            return (
              <TableRow
                key={String(record.id ?? Math.random())}
                className="hover:bg-muted/60"
              >
                <TableCell className="font-medium">
                  {record.id ?? "—"}
                </TableCell>
                <TableCell className="text-center">{className}</TableCell>
                <TableCell className="text-center">{classId}</TableCell>
                <TableCell className="text-center">
                  {classColor ? (
                    <span
                      className="mx-auto inline-flex h-3 w-6 rounded border border-border"
                      style={{
                        backgroundColor: getClassColor(
                          effectiveClassName,
                          classColor,
                        ),
                      }}
                    />
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-muted"
                        onClick={() => handleViewRecord(record)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>View</p>
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
              </TableRow>
            );
          })}
        </AnnoTableCard>
      </div>
    );
  };

  const renderLayerDetails = (layer: LayerItem) => {
    if (layer.type === "user") {
      return renderUserLayer(layer);
    }
    if (layer.type === "ai") {
      return renderClassificationLayer(layer, {
        classIdToName: classIndexToName,
        classIdToColor: classIndexToColor,
        uniqueNames: uniqueCellNamesResolved,
        uniqueIds: uniqueCellIds,
        uniqueColors: uniqueCellColors,
        emptyMessage: "No annotations match the selected filters.",
      });
    }
    return renderClassificationLayer(layer, {
      classIdToName: patchClassIdToName,
      uniqueNames: uniquePatchNamesResolved,
      uniqueIds: uniquePatchIds,
      uniqueColors: uniquePatchColors,
      emptyMessage: "No patch annotations match the selected filters.",
    });
  };

  const topTableRows = (
    <Table className="text-xs">
      <TableHeader>
        <TableRow className="bg-muted text-muted-foreground">
          <TableHead className="rounded-tl-lg">Layer Name</TableHead>
          <TableHead className="w-40">Most Recent</TableHead>
          <TableHead className="w-24 text-center">Annotations</TableHead>
          <TableHead className="w-32 text-center rounded-tr-lg">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {layerItems.map((layer) => (
          <TableRow key={layer.key} className="hover:bg-muted/60">
            <TableCell className="font-medium">{layer.layer_name}</TableCell>
            <TableCell>{layer.completed_at}</TableCell>
            <TableCell className="text-center">
              {/* Paginated layers (ai/patch) only hold one page — show the
                  real total, not just the loaded page. */}
              {(layer.isPaginated && layer.pagination
                ? layer.pagination.total
                : layer.annotations.length
              ).toLocaleString()}
            </TableCell>
            <TableCell>
              <AnnoActionButtons
                onDownload={() => handleDownloadLayer(layer)}
                downloadOptions={
                  layer.type === "ai"
                    ? [
                        {
                          label: "Download CSV",
                          onSelect: () => handleDownloadAnnotations("cell", "csv"),
                        },
                        {
                          label: "Download GeoJSON",
                          onSelect: () => handleDownloadAnnotations("cell", "geojson"),
                        },
                      ]
                    : layer.type === "user"
                      ? [
                          {
                            label: "Download CSV",
                            onSelect: () => handleDownloadAnnotations("user", "csv"),
                          },
                          {
                            label: "Download GeoJSON",
                            onSelect: () => handleDownloadAnnotations("user", "geojson"),
                          },
                        ]
                      : layer.type === "patch"
                        ? [
                            {
                              label: "Download CSV",
                              onSelect: () => handleDownloadAnnotations("patch", "csv"),
                            },
                            {
                              label: "Download GeoJSON",
                              onSelect: () => handleDownloadAnnotations("patch", "geojson"),
                            },
                          ]
                        : undefined
                }
                onExpand={() => toggleLayer(layer.key)}
                isExpanded={expandedLayers[layer.key]}
                downloadTooltip="Download"
                showDownload={pathWritable}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Card className="h-full w-full bg-transparent border-none shadow-none text-foreground">
        <CardHeader className="border-b border-border bg-card py-2.5 px-3">
          <CardTitle className="text-sm font-semibold">
            Annotation &amp; Results Management
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3 px-2">
          {/* Download progress — one independent bar per concurrent download */}
          {downloads.map((d) => (
            <Alert key={d.id} className="border border-blue-500/20 bg-blue-500/10 text-blue-600">
              <AlertDescription className="text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {d.stage === "saving"
                      ? `Saving ${d.format.toUpperCase()} file...`
                      : `Downloading ${d.format.toUpperCase()}...`}
                    <span className="ml-1 text-xs font-normal opacity-70">
                      ({d.scope === "user" ? "User" : d.scope === "patch" ? "Patch" : "Cell"})
                    </span>
                  </span>
                  <span className="text-xs">{d.progress.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-blue-200/30 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full transition-all duration-300 ease-out"
                    style={{ width: `${d.progress}%` }}
                  />
                </div>
                <div className="text-xs text-blue-500/70">
                  {d.stage === "saving"
                    ? "Combining streamed chunks and preparing the file for download"
                    : d.total !== null
                      ? `Downloaded ${(d.bytes / 1024 / 1024).toFixed(1)} / ${(d.total / 1024 / 1024).toFixed(1)} MB`
                      : `Downloaded ${(d.bytes / 1024 / 1024).toFixed(1)} MB`}
                </div>
              </AlertDescription>
            </Alert>
          ))}

          <Alert className="border border-primary/20 bg-primary/10 text-primary py-2">
            <AlertDescription className="text-xs leading-relaxed">
              To efficiently manage all annotation labels, we preprocess the
              data to facilitate downstream analysis, including real-time nuclei
              classification and other AI-assisted workflows.
            </AlertDescription>
          </Alert>

          <div className="rounded-md border border-border bg-card overflow-hidden">
            <div className="max-h-[250px] overflow-auto">{topTableRows}</div>
          </div>

          <div className="space-y-2.5">
            {layerItems.map((layer) => {
              const isOpen = expandedLayers[layer.key];
              return (
                <AnnoLayerCard
                  key={layer.key}
                  title={layer.layer_name}
                  latestUpdate={layer.completed_at}
                  isExpanded={isOpen}
                  onToggle={() => toggleLayer(layer.key)}
                  onDownload={() => handleDownloadLayer(layer)}
                  downloadOptions={
                    layer.type === "ai"
                      ? [
                          {
                            label: "Download CSV",
                            onSelect: () => handleDownloadAnnotations("cell", "csv"),
                          },
                          {
                            label: "Download GeoJSON",
                            onSelect: () => handleDownloadAnnotations("cell", "geojson"),
                          },
                        ]
                      : layer.type === "user"
                        ? [
                            {
                              label: "Download CSV",
                              onSelect: () => handleDownloadAnnotations("user", "csv"),
                            },
                            {
                              label: "Download GeoJSON",
                              onSelect: () => handleDownloadAnnotations("user", "geojson"),
                            },
                          ]
                        : undefined
                  }
                  downloadTooltip="Download"
                  showDownload={pathWritable && layer.type !== "patch"}
                >
                  {renderLayerDetails(layer)}
                </AnnoLayerCard>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
};

export default SidebarAnnotation;
