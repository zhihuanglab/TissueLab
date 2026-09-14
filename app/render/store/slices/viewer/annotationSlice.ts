import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { RootState } from '../../index';
import { normalizePatchClassificationData } from '@/utils/agent/patchClassification.utils';
import { annotationTypeStore } from '@/store/zustand/slice/annotationTypesStore';

// Export the interface for reuse in components
export interface AnnotationClass {
  name: string;
  /** Cells the user labelled AS this class. */
  count: number;
  /** Cells the user marked "not this type" for this class. */
  negativeCount?: number;
  color: string;
  persisted?: boolean;
}

interface BaseAnnotation {
  id: string;
  [key: string]: any;
}

export interface PatchClassificationData {
  class_id: number[];
  class_name: string[];
  class_hex_color: string[];
  class_counts?: number[];
}

export type PatchOverlayEntry = [number, number, number, number, number, string, number]; // [idx, x, y, width, height, color, class_id]

interface AnnotationState<T extends BaseAnnotation> {
  annotations: T[];
  nuclei_segmentation: T[];
  tissue_segmentation: string[];
  patchOverrides: Record<number, string>;
  isEditPanelOpen: boolean;
  editAnnotation: undefined | string;
  isGenerating: boolean;
  threshold: number;
  patchClassificationData: PatchClassificationData | null;
  
  classificationEnabled: boolean;
  isRequestingClassification: boolean;
  
  nucleiClasses: AnnotationClass[];
  regionClasses: AnnotationClass[];
  activeManualClassificationClass: AnnotationClass | null;
}

const initialState: AnnotationState<BaseAnnotation> = {
  annotations: [],
  nuclei_segmentation: [],
  tissue_segmentation: [],
  patchOverrides: {},
  isEditPanelOpen: false,
  editAnnotation: undefined,
  isGenerating: false,
  threshold: 100,
  patchClassificationData: null,
  
  classificationEnabled: false,
  isRequestingClassification: false,
  
  nucleiClasses: [
    {
      name: 'Negative control',
      count: 0,
      color: '#aaaaaa',
    },
  ],
  regionClasses: [],
  activeManualClassificationClass: null,
}

const annotationSlice = createSlice({
  name: 'annotations',
  initialState,
  reducers: {
    setIsGenerating(state, action: PayloadAction<boolean>) {
      state.isGenerating = action.payload
    },
    updateThreshold: (state, action: PayloadAction<number>) => {
      state.threshold = action.payload;
    },
    setNucleiSegmentation: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<T[]>
    ) => {
      state.nuclei_segmentation = action.payload
    },
    addNucleiSegmentation: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<T>
    ) => {
      state.nuclei_segmentation.push(action.payload)
    },
    clearNucleiSegmentation: <T extends BaseAnnotation>(state: AnnotationState<T>) => {
      state.nuclei_segmentation = []
    },
    setAnnotations: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<T[]>
    ) => {
      state.annotations = action.payload
    },
    addAnnotation: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<T>
    ) => {
      state.annotations.push(action.payload)
    },
    removeAnnotationById: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<string>
    ) => {
      state.annotations = state.annotations.filter(
        (annotation) => annotation.id !== action.payload
      )
    },
    clearAnnotations: <T extends BaseAnnotation>(state: AnnotationState<T>) => {
      state.annotations = []
    },
    updateAnnotationById: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<{ id: string; data: Partial<T> }>
    ) => {
      const { id, data } = action.payload
      const annotation = state.annotations.find(
        (annotation) => annotation.id === id
      )
      if (annotation) {
        Object.assign(annotation, data)
      }
    },
    toggleEditPanel: (state) => {
      state.isEditPanelOpen = !state.isEditPanelOpen
    },
    setEditPanelOpen: (state, action: PayloadAction<boolean>) => {
      state.isEditPanelOpen = action.payload
    },
    setEditAnnotations: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<string>
    ) => {
      state.editAnnotation = action.payload
    },
    setTissueSegmentation: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<string[]>
    ) => {
      state.tissue_segmentation = action.payload
    },
    clearTissueSegmentation: <T extends BaseAnnotation>(state: AnnotationState<T>) => { 
      state.tissue_segmentation = []
    },
    clearPatchOverrides: (state) => {
      state.patchOverrides = {};
    },
    clearPatchOverridesForIds: (state, action: PayloadAction<number[]>) => {
      action.payload.forEach((id) => {
        delete state.patchOverrides[Number(id)];
      });
    },
    updatePatchOverlayColors: (
      state,
      action: PayloadAction<{ ids: number[]; color: string; persistOverride?: boolean }>
    ) => {
      const { ids, color, persistOverride = true } = action.payload;
      if (!ids.length) return;

      ids.forEach((id) => {
        if (persistOverride) {
          state.patchOverrides[Number(id)] = color;
        } else {
          delete state.patchOverrides[Number(id)];
        }
      });
    },
    setPatchClassificationData: <T extends BaseAnnotation>(
      state: AnnotationState<T>,
      action: PayloadAction<PatchClassificationData>
    ) => {
      state.patchClassificationData = normalizePatchClassificationData(action.payload);
    },
    
    setClassificationEnabled: (state, action: PayloadAction<boolean>) => {
      console.log("[Redux]", action.payload)
      state.classificationEnabled = action.payload;
    },
    resetClassificationEnabled: (state) => {
      state.classificationEnabled = false;
    },
    requestClassification: (state) => {
      state.isRequestingClassification = true;
    },
    classificationRequestComplete: (state) => {
      state.isRequestingClassification = false;
    },
    
    setNucleiClasses: (state, action: PayloadAction<AnnotationClass[]>) => {
      const incoming = action.payload;
      if (incoming.length && incoming.every(cls => cls.persisted === false)) {
        return;
      }
      // Ensure 'Negative control' is first
      const normalized = incoming.map(cls => ({
        ...cls,
        name: typeof cls.name === 'string' ? cls.name : String(cls.name ?? ''),
        persisted: cls.persisted ?? true,
      }));

      // Dedup by name — the class list must never contain duplicate class names.
      // Some upstream payloads can arrive one-entry-per-cell (e.g. a region labeled
      // with 300 cells yielding 300 copies of the same name in dynamic_class_names);
      // without this guard the panel renders the class 300 times. Keep first + merge
      // a non-zero count / persisted flag from any later duplicate. Mirrors the
      // name-uniqueness that addNucleiClass already enforces.
      const byName = new Map<string, typeof normalized[number]>();
      for (const cls of normalized) {
        const prev = byName.get(cls.name);
        if (!prev) {
          byName.set(cls.name, cls);
        } else {
          byName.set(cls.name, {
            ...prev,
            count: prev.count || cls.count,
            persisted: prev.persisted || cls.persisted,
          });
        }
      }
      const deduped = Array.from(byName.values());

      const negativeControl = deduped.find(cls => cls.name === 'Negative control');
      const others = deduped.filter(cls => cls.name !== 'Negative control');
      const next = negativeControl ? [negativeControl, ...others] : deduped;

      // Bail when the result is identical to what's already stored. Assigning an
      // equal-but-new array still hands the store a fresh `nucleiClasses`
      // reference, and that array is a dependency of DrawingOverlay's centroid
      // and polygon buffer memos — so a redundant set rebuilds every vertex,
      // color and index buffer for the whole slide. Re-loading a slide's
      // classifications normally returns the exact same list, and that load now
      // runs unawaited (see handleLoadClassification), so it lands after the
      // first paint and the rebuild is fully visible as a stutter.
      //
      // Compare every field of AnnotationClass, not just names: the panel shows
      // `count` and a genuine count change must still reach the store.
      const current = state.nucleiClasses;
      const unchanged =
        current.length === next.length &&
        next.every((cls, i) =>
          cls.name === current[i].name &&
          cls.count === current[i].count &&
          cls.color === current[i].color &&
          cls.persisted === current[i].persisted
        );
      if (unchanged) return;

      state.nucleiClasses = next;
    },

    addNucleiClass: (state, action: PayloadAction<AnnotationClass>) => {
      const incoming = action.payload;
      const exists = state.nucleiClasses.some(cls => cls.name === incoming.name);
      if (!exists) {
        state.nucleiClasses.push({ ...incoming, persisted: incoming.persisted ?? false });
      }
    },

    updateNucleiClass: (state, action: PayloadAction<{
      index: number;
      newClass: AnnotationClass;
    }>) => {
      const { index, newClass } = action.payload;
      
      if (state.nucleiClasses[index]) {
        const oldClass = state.nucleiClasses[index];
        state.nucleiClasses[index] = newClass;

        if (oldClass.color !== newClass.color) {
          annotationTypeStore.getState().updateColorByClassIndex(index, newClass.color);
        }
      }
    },

    deleteNucleiClass: (state, action: PayloadAction<number>) => {
      const index = action.payload;
      if (index >= 0 && index < state.nucleiClasses.length) {
        const [removed] = state.nucleiClasses.splice(index, 1);
        if (removed?.persisted !== false) {
          annotationTypeStore.getState().clear();
        }
      }
    },

    resetNucleiClasses: (state) => {
      state.nucleiClasses = [state.nucleiClasses[0]];
    },

    setRegionClasses: (state, action) => {
      state.regionClasses = action.payload;
    },

    addRegionClass: (state, action) => {
      state.regionClasses.push(action.payload);
    },

    updateRegionClass: (state, action) => {
      const { index, newClass } = action.payload;
      state.regionClasses[index] = newClass;
    },

    deleteRegionClass: (state, action) => {
      state.regionClasses.splice(action.payload, 1);
    },

    resetRegionClasses: (state) => {
      state.regionClasses = [];
    },

    clearAnnotationTypes: (state) => {
      annotationTypeStore.getState().clear();
      state.nucleiClasses.forEach(cls => cls.count = 0);
      state.regionClasses.forEach(cls => cls.count = 0);
    },

    setActiveManualClassificationClass: (state, action: PayloadAction<AnnotationClass | null>) => {
      state.activeManualClassificationClass = action.payload;
    },
  },
})

export const selectPatchClassificationData = (state: RootState) => state.annotations.patchClassificationData;

export const {
  setAnnotations,
  addAnnotation,
  removeAnnotationById,
  clearAnnotations,
  updateAnnotationById,
  toggleEditPanel,
  setEditPanelOpen,
  setEditAnnotations,
  setTissueSegmentation,
  clearTissueSegmentation,
  clearPatchOverrides,
  clearPatchOverridesForIds,
  updatePatchOverlayColors,
  setNucleiSegmentation,
  clearNucleiSegmentation,
  addNucleiSegmentation,
  setIsGenerating,
  updateThreshold,
  setPatchClassificationData,
  
  setClassificationEnabled,
  resetClassificationEnabled,
  requestClassification,
  classificationRequestComplete,
  
  setNucleiClasses,
  addNucleiClass,
  updateNucleiClass,
  deleteNucleiClass,
  resetNucleiClasses,
  setRegionClasses,
  addRegionClass,
  updateRegionClass,
  deleteRegionClass,
  resetRegionClasses,
  clearAnnotationTypes,
  setActiveManualClassificationClass,
} = annotationSlice.actions

export default annotationSlice.reducer
