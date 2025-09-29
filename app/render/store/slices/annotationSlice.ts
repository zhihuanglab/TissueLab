import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { RootState } from '../index';
import { normalizePatchClassificationData } from '@/utils/patchClassificationUtils';

// Export the interface for reuse in components
export interface AnnotationClass {
  name: string;
  count: number;
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

export type PatchOverlayEntry = [number, number, number, string];

interface AnnotationTypeMap {
  [id: string]: {
    classIndex: number;  // index of NuclearClasses or RegionClasses
    color: string;
    category: string;
  }
}

interface AnnotationState<T extends BaseAnnotation> {
  annotations: T[];
  nuclei_segmentation: T[];
  tissue_segmentation: string[];
  patches: PatchOverlayEntry[];
  patchOverrides: Record<number, string>;
  showTissueAnnotations: boolean;
  showPatchAnnotations: boolean;
  isEditPanelOpen: boolean;
  editAnnotation: undefined | string;
  isGenerating: boolean;
  threshold: number;
  polygon_threshold: number;
  patchClassificationData: PatchClassificationData | null;
  
  classificationEnabled: boolean;
  isRequestingClassification: boolean;
  
  nucleiClasses: AnnotationClass[];
  regionClasses: AnnotationClass[];
  customOptions: string[];
  selectedNucleiClasses: number[];
  annotationTypeMap: AnnotationTypeMap;
  activeManualClassificationClass: AnnotationClass | null;
}

const initialState: AnnotationState<BaseAnnotation> = {
  annotations: [],
  nuclei_segmentation: [],
  tissue_segmentation: [],
  patches: [],
  patchOverrides: {},
  showTissueAnnotations: false,
  showPatchAnnotations: false,
  isEditPanelOpen: false,
  editAnnotation: undefined,
  isGenerating: false,
  threshold: 100,
  polygon_threshold: 10,
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
  customOptions: [],
  selectedNucleiClasses: [0],
  annotationTypeMap: {},
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
    setPatchOverlays: (
      state,
      action: PayloadAction<PatchOverlayEntry[]>
    ) => {
      const overrides = state.patchOverrides;
      state.patches = action.payload.map((patch) => {
        const overrideColor = overrides[patch[0]];
        if (overrideColor) {
          if (overrideColor === patch[3]) {
            delete overrides[patch[0]];
            return patch;
          }
          return [patch[0], patch[1], patch[2], overrideColor] as PatchOverlayEntry;
        }
        return patch;
      });
    },
    clearPatchOverlays: (state) => {
      state.patches = [];
    },
    clearPatchOverrides: (state) => {
      state.patchOverrides = {};
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

      if (!state.patches.length) return;

      const idSet = new Set(ids.map((id) => Number(id)));
      state.patches = state.patches.map((patch) =>
        idSet.has(patch[0])
          ? [patch[0], patch[1], patch[2], color] as PatchOverlayEntry
          : patch
      );
    },
    toggleTissueAnnotations: (state) => {
      state.showTissueAnnotations = !state.showTissueAnnotations
    },
    togglePatchAnnotations: (state) => {
      state.showPatchAnnotations = !state.showPatchAnnotations
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
      state.nucleiClasses = incoming.map(cls => ({
        ...cls,
        name: typeof cls.name === 'string' ? cls.name : String(cls.name ?? ''),
        persisted: cls.persisted ?? true,
      }));
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

        // If the color has changed, update the annotationTypeMap
        if (oldClass.color !== newClass.color) {
          Object.keys(state.annotationTypeMap).forEach(annotationId => {
            const annotationType = state.annotationTypeMap[annotationId];
            if (annotationType.classIndex === index) {
              annotationType.color = newClass.color;
            }
          });
        }
      }
    },

    deleteNucleiClass: (state, action: PayloadAction<number>) => {
      const index = action.payload;
      if (index >= 0 && index < state.nucleiClasses.length) {
        const [removed] = state.nucleiClasses.splice(index, 1);
        if (removed?.persisted !== false) {
          state.annotationTypeMap = {} as any;
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

    setAnnotationType: (state, action) => {
      const updates = Array.isArray(action.payload) ? action.payload : [action.payload];

      updates.forEach(({ id, classIndex, color, category }) => {
        state.annotationTypeMap[id] = { classIndex, color, category };

        if (category === 'nuclei' && state.nucleiClasses[classIndex]) {
          state.nucleiClasses[classIndex].count += 1;
        } else if (category === 'region' && state.regionClasses[classIndex]) {
          state.regionClasses[classIndex].count += 1;
        }
      });
    },

    removeAnnotationType: (state, action) => {
      const typeInfo = state.annotationTypeMap[action.payload];
      if (typeInfo) {
        if (typeInfo.category === 'nuclei' && state.nucleiClasses[typeInfo.classIndex]) {
          state.nucleiClasses[typeInfo.classIndex].count -= 1;
        } else if (typeInfo.category === 'region' && state.regionClasses[typeInfo.classIndex]) {
          state.regionClasses[typeInfo.classIndex].count -= 1;
        }
      }
      delete state.annotationTypeMap[action.payload];
    },

    clearAnnotationTypes: (state) => {
      state.annotationTypeMap = {};
      state.nucleiClasses.forEach(cls => cls.count = 0);
      state.regionClasses.forEach(cls => cls.count = 0);
    },

    setActiveManualClassificationClass: (state, action: PayloadAction<AnnotationClass | null>) => {
      state.activeManualClassificationClass = action.payload;
    },
  },
})

export const selectPatchClassificationData = (state: RootState) => state.annotations.patchClassificationData;
export const selectPatchOverlays = (state: RootState) => state.annotations.patches;

export const {
  setAnnotations,
  addAnnotation,
  removeAnnotationById,
  clearAnnotations,
  updateAnnotationById,
  toggleEditPanel,
  setEditAnnotations,
  setTissueSegmentation,
  clearTissueSegmentation,
  setPatchOverlays,
  clearPatchOverlays,
  clearPatchOverrides,
  updatePatchOverlayColors,
  toggleTissueAnnotations,
  togglePatchAnnotations,
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
  setAnnotationType,
  removeAnnotationType,
  clearAnnotationTypes,
  setActiveManualClassificationClass,
} = annotationSlice.actions

export default annotationSlice.reducer
