import http from "@/utils/http";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { setIsRunning } from "@/store/slices/workflowSlice";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chatSlice";
import { AppDispatch } from "@/store";
import { AnnotationClass } from "@/store/slices/annotationSlice";


/**
 * Generates the .h5 output path from a given file path.
 * @param path The input file path.
 * @returns The path with .h5 appended, or the original path if it already ends with .h5.
 */
export const getDefaultOutputPath = (path: string | null): string => {
  if (!path) return "";
  return path.endsWith('.h5') ? path : path + '.h5';
};

interface WorkflowPayloadInput {
  nuclei_classes: string[];
  nuclei_colors: string[];
  organ: string;
  classifier_path?: string | null;
  save_classifier_path?: string | null;
}

interface WorkflowStep {
  model: string;
  input: WorkflowPayloadInput;
}

export interface WorkflowPayload {
  h5_path: string;
  step1: WorkflowStep; // Assuming 'step1' is standard, adjust if workflows can have different structures
}

/**
 * Creates the payload for starting a classification workflow.
 * @param h5Path The full path to the H5 file.
 * @param nucleiClasses Array of nuclei class objects.
 * @param currentOrgan The current organ selected for classification.
 * @param classifierPath Optional classifier path from FileBrowserSidebar.
 * @param saveClassifierPath Optional save classifier path from FileBrowserSidebar.
 * @returns The workflow payload object.
 */
export const createWorkflowPayload = (
  h5Path: string,
  nucleiClasses: AnnotationClass[],
  currentOrgan: string | null,
  classifierPath?: string | null,
  saveClassifierPath?: string | null
): WorkflowPayload => {
  const organValue = currentOrgan || ""; // Default to empty string if null

  return {
    h5_path: h5Path,
    step1: {
      model: "ClassificationNode", // The name of the node to execute
      input: {
        nuclei_classes: nucleiClasses.map(cls => cls.name),
        nuclei_colors: nucleiClasses.map(cls => cls.color),
        organ: organValue,
        classifier_path: classifierPath || null,
        save_classifier_path: saveClassifierPath || null,
      }
    }
  };
};

/**
 * Triggers the classification workflow synchronously.
 * @param dispatch Redux AppDispatch instance.
 * @param h5Path The full path to the H5 file.
 * @param nucleiClasses Array of nuclei class objects.
 * @param currentOrgan The current organ selected for classification.
 * @param classifierPath Optional classifier path from FileBrowserSidebar.
 * @param saveClassifierPath Optional save classifier path from FileBrowserSidebar.
 */
export const triggerClassificationWorkflow = async (
  dispatch: AppDispatch,
  h5Path: string,
  nucleiClasses: AnnotationClass[],
  currentOrgan: string | null,
  classifierPath?: string | null,
  saveClassifierPath?: string | null
): Promise<void> => {
  if (!h5Path || nucleiClasses.length === 0) {
    console.warn("Cannot trigger workflow: Missing H5 path or nuclei classes.");
    return;
  }

  const workflowPayload = createWorkflowPayload(h5Path, nucleiClasses, currentOrgan, classifierPath, saveClassifierPath);

  dispatch(setIsChatGenerating(true));
  dispatch(setIsRunning(true));

  try {
    console.log("Attempting to trigger workflow with payload:", workflowPayload);
    const wfResponse = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, workflowPayload);
    console.log("Workflow triggered synchronously:", wfResponse.data);
    

    
  } catch (wfError) {
    console.error("Error triggering workflow synchronously:", wfError);
    // Handle error (e.g., show error notification to user)
  } finally {
    dispatch(setIsChatGenerating(false));
    dispatch(setIsRunning(false));
  }
};


/**
 * Triggers the patch classification workflow.
 * @param dispatch Redux AppDispatch instance.
 * @param h5Path The full path to the H5 file.
 * @param patchClassificationData Object containing patch classification data.
 */
export const triggerPatchClassificationWorkflow = async (
  dispatch: AppDispatch,
  h5Path: string,
  patchClassificationData: { class_name: string[], class_hex_color: string[] },
  classifierPath: string | null,
  classifierSavePath: string | null
): Promise<void> => {
  if (!h5Path || !patchClassificationData || patchClassificationData.class_name.length === 0) {
    console.warn("Cannot trigger patch workflow: Missing H5 path or patch classification data.");
    return;
  }

  const payload = {
    h5_path: h5Path,
    step1: {
      model: "MuskClassification",
      input: {
        tissue_classes: patchClassificationData.class_name,
        tissue_colors: patchClassificationData.class_hex_color,
        classifier_path: classifierPath,
        save_classifier_path: classifierSavePath,
      }
    }
  };

  dispatch(setIsChatGenerating(true));
  dispatch(setIsRunning(true));

  try {
    console.log("Attempting to trigger patch workflow with payload:", payload);
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, payload);
    console.log("Patch workflow triggered:", response.data);
    
  } catch (error) {
    console.error("Error triggering patch workflow:", error);
  } finally {
    dispatch(setIsChatGenerating(false));
    dispatch(setIsRunning(false));
  }
}; 