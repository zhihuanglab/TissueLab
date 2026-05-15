import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { RootState } from "@/store";
import { selectPatchClassificationData, setEditAnnotations } from "@/store/slices/viewer/annotationSlice";
import { useAnnotationTypes } from "@/store/zustand/slice/annotationTypesStore";
import { apiFetch } from '@/utils/common/apiFetch';
import { getClassColor } from "@/utils/patchClassificationUtils";
import { getLargestTiledImage } from "@/utils/viewer/viewerHelpers";
import {
  ChevronDown,
  ChevronRightCircle,
  Eye,
  Shapes,
  Square
} from "lucide-react";
import OpenSeadragon from "openseadragon";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
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

const annotationTypeIcon = (type?: string) => {
  if (type === "RECTANGLE") {
    return <Square className="h-4 w-4" />;
  }
  if (type === "POLYGON") {
    return <Shapes className="h-4 w-4" />;
  }
  return <ChevronRightCircle className="h-4 w-4" />;
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

const StatusBadge = ({ label }: { label: string }) => (
  <Badge className="bg-success/10 text-success hover:bg-success/10">
    {label}
  </Badge>
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

  const [userAnnotationFilters, setUserAnnotationFilters] =
    useState<AnnotationFilters>({});
  const [aiAnnotationFilters, setAiAnnotationFilters] =
    useState<AnnotationFilters>({});

  const allAnnotations = useSelector(
    (state: RootState) => state.annotations.annotations,
  );
  const patchClassificationData = useSelector(selectPatchClassificationData);
  const userAnnotations = useMemo(
    () => allAnnotations.filter((annotation) => !annotation.isBackend),
    [allAnnotations],
  );

  const [aiAnnotations, setAiAnnotations] = useState<AnnotationRecord[]>([]);
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

  const classIndexToName = useMemo(() => {
    const map = new Map<number, string>();
    annotationTypes.forEach((entry) => {
      if (entry.classIndex !== undefined && entry.category) {
        map.set(entry.classIndex, entry.category);
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
    try {
      setLoading(true);
      const response = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/?offset=${offset}&limit=${limit}`,
        {
          method: 'GET',
          returnAxiosFormat: true,
        }
      );
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
      console.error("Error fetching AI annotations:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAiAnnotationsPatch = async (offset: number, limit: number) => {
    try {
      setLoading(true);
      const response = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/patches/?offset=${offset}&limit=${limit}`,
        {
          method: 'GET',
          returnAxiosFormat: true,
        }
      );
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
      console.error("Error fetching AI annotations patch:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAiAnnotations(aiPagination.offset, aiPagination.limit);
  }, [aiPagination.offset, aiPagination.limit]);

  useEffect(() => {
    fetchAiAnnotationsPatch(aiPaginationPatch.offset, aiPaginationPatch.limit);
  }, [aiPaginationPatch.offset, aiPaginationPatch.limit]);

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

  const layerItems: LayerItem[] = useMemo(() => {
    const layers = [
      {
        key: "user",
        type: "user" as const,
        layer_name: "User-generated annotations",
        completed_at:
          userAnnotations.length > 0
            ? formatDate(
                userAnnotations[userAnnotations.length - 1]?.target?.created,
              )
            : "N/A",
        annotations: userAnnotations,
        isPaginated: false,
      },
      {
        key: "ai",
        type: "ai" as const,
        layer_name: "Cell Classification Overview",
        completed_at:
          aiAnnotations.length > 0
            ? formatDate(aiAnnotations[0]?.target?.created)
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
        completed_at:
          aiAnnotationsPatch.length > 0
            ? formatDate(aiAnnotationsPatch[0]?.target?.created)
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

  const handleDownloadCellClassification = async (format: "csv" | "geojson") => {
    try {
      setLoading(true);
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadStage("downloading");
      setActiveDownloadFormat(format);
      setDownloadedBytes(0);
      setDownloadTotalBytes(null);

      const isGeoJson = format === "geojson";
      const url = isGeoJson
        ? `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/export/geojson`
        : `${AI_SERVICE_API_ENDPOINT}/seg/v1/annotations/export/csv`;

      // Use apiFetch with isReturnResponse to get the full response object
      const response = await apiFetch(url, {
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
      link.download = isGeoJson
        ? 'Cell_Segmentation_Classification.geojson'
        : 'Cell_Classification_Overview.csv';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setDownloadProgress(100);

      // Clean up the blob URL
      setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);

    } catch (error) {
      console.error("Error downloading annotation data:", error);
      // You might want to show a toast notification here
    } finally {
      setLoading(false);
      setTimeout(() => {
        setIsDownloading(false);
        setDownloadProgress(0);
        setDownloadStage("downloading");
        setDownloadedBytes(0);
        setDownloadTotalBytes(null);
      }, 1000); // Keep progress visible for 1 second after completion
    }
  };

  const handleDownloadLayer = (layer: LayerItem) => {
    // Handle Cell Classification Overview (ai type) with CSV download
    if (layer.type === "ai") {
      handleDownloadCellClassification("csv");
      return;
    }

    // Handle other layer types with JSON download (coordinates already in viewer image space)
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

  const renderUserLayer = (layer: LayerItem) => {
    const filteredAnnotations = applyFilters(
      layer.annotations,
      userAnnotationFilters,
    );

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Type"
            options={[
              { label: "Rectangle", value: "RECTANGLE" },
              { label: "Polygon", value: "POLYGON" },
            ]}
            values={userAnnotationFilters.annotationType ?? []}
            onChange={(values) =>
              setUserAnnotationFilters((prev) => ({
                ...prev,
                annotationType: values.length ? values : undefined,
              }))
            }
          />
          <FilterDropdown
            label="State"
            options={[{ label: "Finished", value: "finished" }]}
            values={userAnnotationFilters.state ?? []}
            onChange={(values) =>
              setUserAnnotationFilters((prev) => ({
                ...prev,
                state: values.length ? values : undefined,
              }))
            }
          />
        </div>

        <AnnoTableCard
          headers={
            <TableRow className="bg-muted text-muted-foreground">
              <TableHead className="w-16 rounded-tl-lg">ID</TableHead>
              <TableHead className="w-24 text-center">Type</TableHead>
              <TableHead className="w-32 text-center">Time</TableHead>
              <TableHead className="w-24 text-center">Status</TableHead>
              <TableHead className="w-24 text-center rounded-tr-lg">Action</TableHead>
            </TableRow>
          }
        >
          {filteredAnnotations.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>
                <EmptyState message="No annotations match the selected filters." />
              </TableCell>
            </TableRow>
          )}
          {filteredAnnotations.map((record) => (
            <TableRow
              key={String(record.id ?? Math.random())}
              className="hover:bg-muted/60"
            >
              <TableCell className="font-medium">
                {record.id ?? "—"}
              </TableCell>
              <TableCell className="text-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center justify-center">
                      {annotationTypeIcon(record.target?.selector?.type)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {record.target?.selector?.type ?? "Unknown"}
                  </TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-center">
                {record.target?.created
                  ? new Date(record.target.created).toLocaleDateString()
                  : "N/A"}
              </TableCell>
              <TableCell className="text-center">
                <StatusBadge label="✓" />
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
          ))}
        </AnnoTableCard>

      </div>
    );
  };

  const renderAiLayer = (layer: LayerItem) => {
    const filteredAnnotations = applyFilters(
      layer.annotations,
      aiAnnotationFilters,
    );

    const getRealCellType = (record: AnnotationRecord) => {
      if (record.classname) return record.classname;
      const selector = record.target?.selector;
      if (selector?.class_name) return selector.class_name;
      const classId = record.classid ?? selector?.class_id;
      if (classId === undefined || classId === null) return "—";
      const normalizedId =
        typeof classId === "string" ? Number(classId) : classId;
      if (Number.isNaN(normalizedId)) return "—";
      return classIndexToName.get(normalizedId) ?? "—";
    };

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Type"
            options={[
              { label: "Rectangle", value: "RECTANGLE" },
              { label: "Polygon", value: "POLYGON" },
            ]}
            values={aiAnnotationFilters.annotationType ?? []}
            onChange={(values) =>
              setAiAnnotationFilters((prev) => ({
                ...prev,
                annotationType: values.length ? values : undefined,
              }))
            }
          />
          <FilterDropdown
            label="State"
            options={[{ label: "Finished", value: "finished" }]}
            values={aiAnnotationFilters.state ?? []}
            onChange={(values) =>
              setAiAnnotationFilters((prev) => ({
                ...prev,
                state: values.length ? values : undefined,
              }))
            }
          />
        </div>

        <AnnoTableCard
          headers={
            <TableRow className="bg-muted text-muted-foreground">
              <TableHead className="w-16 rounded-tl-lg">ID</TableHead>
              <TableHead className="w-24 text-center">Type</TableHead>
              <TableHead className="w-32 text-center">Time</TableHead>
              <TableHead className="w-24 text-center">Status</TableHead>
              <TableHead className="w-24 text-center rounded-tr-lg">Action</TableHead>
            </TableRow>
          }
          paginator={renderPaginator(layer)}
        >
          {filteredAnnotations.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>
                <EmptyState message="No annotations match the selected filters." />
              </TableCell>
            </TableRow>
          )}
          {filteredAnnotations.map((record) => (
            <TableRow
              key={String(record.id ?? Math.random())}
              className="hover:bg-muted/60"
            >
              <TableCell className="font-medium">
                {record.id ?? "—"}
              </TableCell>
              <TableCell className="text-center">
                {getRealCellType(record)}
              </TableCell>
              <TableCell className="text-center">
                {record.target?.created
                  ? new Date(record.target.created).toLocaleDateString()
                  : "N/A"}
              </TableCell>
              <TableCell className="text-center">
                <StatusBadge label="✓" />
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
          ))}
        </AnnoTableCard>
      </div>
    );
  };

  const renderPatchLayer = (layer: LayerItem) => {
    const filteredAnnotations = applyFilters(
      layer.annotations,
      aiAnnotationFilters,
    );

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Class"
            options={uniquePatchNamesResolved.map((name) => ({
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
            options={uniquePatchIds.map((id) => ({
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
            options={uniquePatchColors.map((color) => ({
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
                <EmptyState message="No patch annotations match the selected filters." />
              </TableCell>
            </TableRow>
          )}
          {filteredAnnotations.map((record) => {
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
            const effectiveClassColor =
              selector?.class_hex_color ?? record.color ?? undefined;
            return (
              <TableRow
                key={String(record.id ?? Math.random())}
                className="hover:bg-muted/60"
              >
                <TableCell className="font-medium">
                  {record.id ?? "—"}
                </TableCell>
                <TableCell className="text-center">
                  {effectiveClassName ??
                    (() => {
                      const classId =
                        effectiveClassId !== undefined
                          ? Number(effectiveClassId)
                          : undefined;
                      if (classId === undefined || Number.isNaN(classId)) {
                        return "—";
                      }
                      return patchClassIdToName.get(classId) ?? "—";
                    })()}
                </TableCell>
                <TableCell className="text-center">
                  {effectiveClassId ?? "—"}
                </TableCell>
                <TableCell className="text-center">
                  {effectiveClassColor ? (
                    <span
                      className="mx-auto inline-flex h-3 w-6 rounded border border-border"
                      style={{
                        backgroundColor: getClassColor(
                          effectiveClassName,
                          effectiveClassColor,
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
      return renderAiLayer(layer);
    }
    return renderPatchLayer(layer);
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
              {layer.annotations.length}
            </TableCell>
            <TableCell>
              <AnnoActionButtons
                onDownload={() => handleDownloadLayer(layer)}
                downloadOptions={
                  layer.type === "ai"
                    ? [
                        {
                          label: "Download CSV",
                          onSelect: () => handleDownloadCellClassification("csv"),
                        },
                        {
                          label: "Download GeoJSON",
                          onSelect: () => handleDownloadCellClassification("geojson"),
                        },
                      ]
                    : undefined
                }
                onExpand={() => toggleLayer(layer.key)}
                isExpanded={expandedLayers[layer.key]}
                downloadTooltip="Download"
                showDownload={layer.type !== "patch"}
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
          {/* Download Progress Indicator */}
          {isDownloading && (
            <Alert className="border border-blue-500/20 bg-blue-500/10 text-blue-600">
              <AlertDescription className="text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {downloadStage === "saving"
                      ? `Saving ${activeDownloadFormat.toUpperCase()} file...`
                      : `Downloading ${activeDownloadFormat.toUpperCase()}...`}
                  </span>
                  <span className="text-xs">{downloadProgress.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-blue-200/30 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full transition-all duration-300 ease-out"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
                <div className="text-xs text-blue-500/70">
                  {downloadStage === "saving"
                    ? "Combining streamed chunks and preparing the file for download"
                    : downloadTotalBytes !== null
                      ? `Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)} / ${(downloadTotalBytes / 1024 / 1024).toFixed(1)} MB - Processing ${totalAiAnnotations.toLocaleString()} cells`
                      : `Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB - Processing ${totalAiAnnotations.toLocaleString()} cells`}
                </div>
              </AlertDescription>
            </Alert>
          )}

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
                            onSelect: () => handleDownloadCellClassification("csv"),
                          },
                          {
                            label: "Download GeoJSON",
                            onSelect: () => handleDownloadCellClassification("geojson"),
                          },
                        ]
                      : undefined
                  }
                  downloadTooltip="Download"
                  showDownload={layer.type !== "patch"}
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
