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

/** A row of the panel's class list: label counts plus its colour. */
type CytoformerClassEntry = {
  name: string;
  color: string;
  /** Cells labelled AS this class. */
  count?: number;
  /** Cells marked "not this type"; a class can have these and no positives. */
  negativeCount?: number;
};

function isAnnotated(cls: CytoformerClassEntry): boolean {
  return (cls.count ?? 0) > 0 || (cls.negativeCount ?? 0) > 0;
}

/**
 * CytoformerClassification shares NuClass's panel and payload. The only extra
 * input is `organ`; classes, colors, classifier paths and class operations are
 * built by the generic path (which also trims the class list — see
 * restrictClassesToAnnotated).
 *
 * `organ` is optional and is NOT inherited from the viewer's global organ (that
 * one is free text; this is a fixed enum). Empty just means the run has to be
 * supervised, which the tasknode decides from the presence of annotations.
 */
export function applyCytoformerClassificationInput(
  inputObject: Record<string, any>,
  panel: WorkflowPanel,
): void {
  const organ = normalizeCytoformerOrgan(
    panel.content.find((item) => item.key === "organ")?.value,
  );
  const organError = validateCytoformerOrgan(organ);
  if (organError) {
    throw new Error(organError);
  }
  inputObject.organ = organ;
  // Match NuClass semantics: labelled cells train the head, and the tasknode
  // falls back to organ zero-shot on its own when there are none.
  inputObject.use_supervised = true;
}
