import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { panelMap } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants";

export type BuildWorkflowPayloadContext = {
  currentPath: string | null;
  nucleiClasses: { name: string; color: string }[];
  /** Same as classic `createWorkflowPayload` / toolbox — used for NuClass zero-shot text prompts when panel does not override. */
  currentOrgan: string | null;
  reduxPatchClassificationData: {
    class_name: string[];
    class_hex_color: string[];
  } | null;
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  /** Nuclei segmentation bbox is taken only from `rectangleCoords` here, not from x1–y2 (which may be full-slide for tissue). */
  shapeData: { rectangleCoords?: { x1: number; y1: number; x2: number; y2: number }; polygonPoints?: unknown } | null | undefined;
};

/** Panel `organ` wins if non-empty; else global (Redux) organ; else "" — matches legacy classification workflow. */
function resolveNucleiClassificationOrgan(
  panel: WorkflowPanel,
  currentOrgan: string | null | undefined
): string {
  const raw = panel.content.find((item) => item.key === "organ")?.value;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  if (currentOrgan != null && String(currentOrgan).trim() !== "") {
    return String(currentOrgan).trim();
  }
  return "";
}

/**
 * Builds the POST body for tasks/v1/start_workflow plus explicit per-node dependencies
 * for the backend scheduler (linear panel order: each step depends on the previous).
 */
export function buildStartWorkflowPayload(
  panelsToRun: WorkflowPanel[],
  zarrPath: string,
  ctx: BuildWorkflowPayloadContext
): { payload: Record<string, any>; orderedBackendNodeIds: string[] } {
  const workflowPayload: Record<string, any> = { zarr_path: zarrPath };
  const orderedBackendNodeIds: string[] = [];

  const { currentPath, nucleiClasses, currentOrgan, reduxPatchClassificationData, x1, y1, x2, y2, shapeData } = ctx;

  panelsToRun.forEach((panel, index) => {
    const stepKey = `step${index + 1}`;
    const nodeId = (panel.type || "GPT-4o Agent").trim();
    const inputObject: Record<string, any> = {};
    panel.content.forEach((contentItem) => {
      const k = (contentItem.key || "").trim();
      if (k.length > 0 && contentItem.type !== "tips") {
        if (contentItem.type === "color-selector" && contentItem.value && Array.isArray(contentItem.value)) {
          const classColorObj: Record<string, string> = {};
          contentItem.value.forEach((cls: any) => {
            if (cls.name && cls.color) {
              classColorObj[cls.name] = cls.color;
            }
          });
          inputObject[k] = classColorObj;
        } else {
          inputObject[k] = contentItem.value;
        }
      }
    });

    if (currentPath) {
      inputObject.path = currentPath;
    }

    if (panel.title === "Tissue Classification") {
      if (x1 && y1 && x2 && y2 && !Number.isNaN(Number(x1)) && !Number.isNaN(Number(y1)) && !Number.isNaN(Number(x2)) && !Number.isNaN(Number(y2))) {
        const numX1 = Number(x1);
        const numY1 = Number(y1);
        const numX2 = Number(x2);
        const numY2 = Number(y2);
        const width = numX2 - numX1;
        const height = numY2 - numY1;
        if (width > 0 && height > 0) {
          inputObject.bbox = [numX1, numY1, width, height];
        }
      }
      if (inputObject.rate) {
        inputObject.rate = Number(inputObject.rate);
      }
    }

    if (panel.title === "Nuclei Classification") {
      inputObject.nuclei_classes = nucleiClasses.map((cls) => cls.name);
      inputObject.nuclei_colors = nucleiClasses.map((cls) => cls.color);
      inputObject.organ = resolveNucleiClassificationOrgan(panel, currentOrgan);

      const loadPath = panel.content.find((item) => item.key === "classifier_path")?.value;
      const savePath = panel.content.find((item) => item.key === "save_classifier_path")?.value;

      inputObject.classifier_path = loadPath || null;
      inputObject.save_classifier_path = savePath || null;
    }

    if (panel.title === "Tissue Classification") {
      if (reduxPatchClassificationData) {
        inputObject.tissue_classes = reduxPatchClassificationData.class_name;
        inputObject.tissue_colors = reduxPatchClassificationData.class_hex_color;

        const loadPath = panel.content.find((item) => item.key === "classifier_path")?.value;
        const savePath = panel.content.find((item) => item.key === "save_classifier_path")?.value;

        inputObject.classifier_path = loadPath || null;
        inputObject.save_classifier_path = savePath || null;
      }
    }

    if (panel.title === panelMap.NucleiSeg.title) {
      const targetMppItem = panel.content.find((item) => item.key === "target_mpp");
      if (targetMppItem?.value && typeof targetMppItem.value === "string" && targetMppItem.value.trim() !== "") {
        const mppValue = parseFloat(targetMppItem.value);
        if (!Number.isNaN(mppValue)) {
          inputObject.target_mpp = mppValue;
        }
      }
      const rect = shapeData?.rectangleCoords;
      if (rect) {
        const { x1: rx1, y1: ry1, x2: rx2, y2: ry2 } = rect;
        const width = rx2 - rx1;
        const height = ry2 - ry1;
        if (width > 0 && height > 0) {
          inputObject.bbox = `${rx1},${ry1},${width},${height}`;
        }
      }
      if (shapeData?.polygonPoints) {
        inputObject.polygon_points = shapeData.polygonPoints;
      }
    }

    if (panel.title === panelMap.TissueSeg.title) {
      const tissueSegDefaults: Record<string, number> = {
        patch_size: 224,
        level: 0,
        tissue_threshold: 0.1,
        batch_size: 4,
      };
      (["patch_size", "level", "tissue_threshold", "batch_size"] as const).forEach((key) => {
        const v = inputObject[key];
        const isEmpty = v === "" || v == null || (typeof v === "string" && v.trim() === "");
        if (isEmpty) {
          inputObject[key] = tissueSegDefaults[key];
        } else {
          const n = Number(v);
          inputObject[key] = !Number.isNaN(n) ? n : tissueSegDefaults[key];
        }
      });
      if (x1 && y1 && x2 && y2 && !Number.isNaN(Number(x1)) && !Number.isNaN(Number(y1)) && !Number.isNaN(Number(x2)) && !Number.isNaN(Number(y2))) {
        const numX1 = Number(x1);
        const numY1 = Number(y1);
        const numX2 = Number(x2);
        const numY2 = Number(y2);
        const width = numX2 - numX1;
        const height = numY2 - numY1;
        if (width > 0 && height > 0) {
          inputObject.bbox = `${numX1},${numY1},${width},${height}`;
        }
      }
    }

    if (panel.type === "GPT-4o Agent") {
      const promptValue = inputObject.prompt;
      if (typeof promptValue === "string") {
        const normalizedPrompt = promptValue.trim();
        inputObject.prompt = normalizedPrompt.length > 0 ? normalizedPrompt : null;
      } else if (promptValue === undefined) {
        inputObject.prompt = null;
      }
    }

    workflowPayload[stepKey] = {
      nodeId,
      input: inputObject,
    };
    if (nodeId !== "GPT-4o Agent") {
      orderedBackendNodeIds.push(nodeId);
    }
  });

  const task_dependencies: Record<string, string[]> = {};
  for (let i = 0; i < orderedBackendNodeIds.length; i++) {
    task_dependencies[orderedBackendNodeIds[i]] = i > 0 ? [orderedBackendNodeIds[i - 1]] : [];
  }
  if (orderedBackendNodeIds.length > 0) {
    workflowPayload.task_dependencies = task_dependencies;
  }

  return { payload: workflowPayload, orderedBackendNodeIds };
}
