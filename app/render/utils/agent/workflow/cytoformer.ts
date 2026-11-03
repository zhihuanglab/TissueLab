/**
 * Everything CytoformerClassification needs beyond the shared NuClass panel:
 * the organ enum for the dropdown, and the one extra payload field.
 *
 * The organ list mirrors cytoformer_model/model_code/organ_celltype_map.json
 * (organ_to_celltypes keys) — keep in sync with the model. It only selects the
 * model's zero-shot head; it does NOT pin a class taxonomy or a palette, and
 * classes are managed exactly like NuClass.
 */
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { parseOvrClassifierPaths } from "@/utils/agent/workflow/panelContent";


export const CYTOFORMER_ORGANS: string[] = [
  "bone",
  "bone_marrow",
  "brain",
  "breast",
  "cervix",
  "colon",
  "heart",
  "kidney",
  "liver",
  "lung",
  "lymph_node",
  "ovary",
  "pancreas",
  "prostate",
  "skin",
  "tonsil",
];

/** Human-friendly labels for the organ dropdown (values stay the model's lowercase keys). */
export const CYTOFORMER_ORGAN_LABEL: Record<string, string> = {
  bone: "Bone",
  bone_marrow: "Bone marrow",
  brain: "Brain",
  breast: "Breast",
  cervix: "Cervix",
  colon: "Colon",
  heart: "Heart",
  kidney: "Kidney",
  liver: "Liver",
  lung: "Lung",
  lymph_node: "Lymph node",
  ovary: "Ovary",
  pancreas: "Pancreas",
  prostate: "Prostate",
  skin: "Skin",
  tonsil: "Tonsil",
};

function normalizeCytoformerOrgan(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Empty is allowed: the organ only feeds the zero-shot head, and a run with
 * annotations trains on those labels instead. The tasknode raises its own error
 * if it ends up on the zero-shot path without one. A non-empty value must still
 * be a real organ key — a saved workflow can carry junk the dropdown cannot.
 */
function validateCytoformerOrgan(value: unknown): string | null {
  const organ = normalizeCytoformerOrgan(value);
  if (!organ) return null;
  if (!CYTOFORMER_ORGANS.includes(organ)) {
    return `Unknown Cytoformer organ "${String(value)}".`;
  }
  return null;
}

/**
 * Zero-shot is the only path that needs an organ. The tasknode takes the
 * supervised path on `CLASSIFIER_PATH is not None or (use_supervised and
 * annotations_data is not None)`, so an attached classifier makes the organ as
 * unnecessary as annotations do. Returns a message to show the user, or null.
 */
export function cytoformerOrganError(
  value: unknown,
  isSupervised: boolean,
): string | null {
  const unknownOrgan = validateCytoformerOrgan(value);
  if (unknownOrgan) return unknownOrgan;
  if (!normalizeCytoformerOrgan(value) && !isSupervised) {
    return "Select an organ or a classifier — Cytoformer needs one of them to predict without annotations.";
  }
  return null;
}

type OvrClass = { name: string; count?: number };

/**
 * One-vs-Rest: a class's binary comes from its attached classifier or, on
 * Update, from the cells marked as it — as multiclass trains on annotations.
 * Only the rest go to the organ head, so an organ is required only when no class
 * has either. (With nothing marked as not-the-class, the tasknode stands
 * unannotated cells in for the negatives.)
 */
export function cytoformerOvrOrganError(
  value: unknown,
  classes: OvrClass[],
  classifierPaths: unknown,
  afterAnnotation = false,
): string | null {
  const unknownOrgan = validateCytoformerOrgan(value);
  if (unknownOrgan) return unknownOrgan;
  const paths = parseOvrClassifierPaths(classifierPaths);
  // An Update fired by a mark may run before the counts show it.
  const supervised = afterAnnotation || classes.some((c) =>
    c.name.trim().toLowerCase() !== "negative control" && (Boolean(paths?.[c.name]) || (c.count ?? 0) > 0));
  if (!normalizeCytoformerOrgan(value) && !supervised) {
    return "Select an organ, or mark cells of a class — Cytoformer One-vs-Rest needs one of them to predict.";
  }
  return null;
}

/**
 * CytoformerClassification shares NuClass's panel and payload. The only extra
 * input is `organ`; classes, colors, classifier paths and class operations are
 * built by the generic path (which also trims the class list — see
 * restrictClassesToAnnotated).
 *
 * `organ` is optional and is NOT inherited from the viewer's global organ (that
 * one is free text; this is a fixed enum). Empty just means the run has to be
 * supervised, using annotations or attached classifiers.
 */
export function applyCytoformerClassificationInput(
  inputObject: Record<string, any>,
  panel: WorkflowPanel,
  classes: OvrClass[],
  afterAnnotation = false,
): void {
  const organ = normalizeCytoformerOrgan(
    panel.content.find((item) => item.key === "organ")?.value,
  );
  const organError = inputObject.classifier_mode === "one-vs-rest"
    ? cytoformerOvrOrganError(organ, classes, inputObject.classifier_paths, afterAnnotation)
    : validateCytoformerOrgan(organ);
  if (organError) {
    throw new Error(organError);
  }
  inputObject.organ = organ;
  // Match NuClass semantics: annotations allow training; attached classifiers
  // can predict without annotations. The tasknode chooses the prediction path.
  inputObject.use_supervised = true;
}
