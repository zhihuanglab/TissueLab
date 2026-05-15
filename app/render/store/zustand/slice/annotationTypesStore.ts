import { useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

export interface AnnotationTypeEntry {
  classIndex?: number;
  color: string;
  category: string;
}

export interface AnnotationTypeUpdate extends AnnotationTypeEntry {
  id: string;
}

const normalizedId = (id: string | number) => String(id);
type AnnotationTypeStore = {
  annotationTypes: Map<string, AnnotationTypeEntry>;
  version: number;
  setMany: (updates: AnnotationTypeUpdate[]) => void;
  removeMany: (ids: Array<string | number>) => void;
  clear: () => void;
  updateColorByClassIndex: (classIndex: number, color: string) => void;
  removeByClassIndex: (classIndex: number) => void;
};

const annotationTypeStore = createStore<AnnotationTypeStore>()(
  devtools(
    (set) => ({
      annotationTypes: new Map<string, AnnotationTypeEntry>(),
      version: 0,
      setMany: (updates) => {
        if (!updates.length) return;
        set(
          (state) => {
            const newMap = new Map(state.annotationTypes);
            let changed = false;
            updates.forEach(({ id, ...rest }) => {
              const key = normalizedId(id);
              const existing = newMap.get(key);
              if (
                !existing ||
                existing.classIndex !== rest.classIndex ||
                existing.color !== rest.color ||
                existing.category !== rest.category
              ) {
                newMap.set(key, { ...rest });
                changed = true;
              }
            });
            if (!changed) {
              return state;
            }
            return {
              annotationTypes: newMap,
              version: state.version + 1,
            };
          },
          false,
          'annotationTypes/setMany'
        );
      },
      removeMany: (ids) => {
        if (!ids.length) return;
        set(
          (state) => {
            const newMap = new Map(state.annotationTypes);
            let changed = false;
            ids.forEach((id) => {
              const key = normalizedId(id);
              if (newMap.delete(key)) {
                changed = true;
              }
            });
            if (!changed) {
              return state;
            }
            return {
              annotationTypes: newMap,
              version: state.version + 1,
            };
          },
          false,
          'annotationTypes/removeMany'
        );
      },
      clear: () => {
        set(
          (state) => {
            if (!state.annotationTypes.size) {
              return state;
            }
            return {
              annotationTypes: new Map<string, AnnotationTypeEntry>(),
              version: state.version + 1,
            };
          },
          false,
          'annotationTypes/clear'
        );
      },
      updateColorByClassIndex: (classIndex, color) => {
        set(
          (state) => {
            const newMap = new Map(state.annotationTypes);
            let changed = false;
            newMap.forEach((entry, key) => {
              if (entry.classIndex === classIndex && entry.color !== color) {
                newMap.set(key, { ...entry, color });
                changed = true;
              }
            });
            if (!changed) {
              return state;
            }
            return {
              annotationTypes: newMap,
              version: state.version + 1,
            };
          },
          false,
          'annotationTypes/updateColorByClassIndex'
        );
      },
      removeByClassIndex: (classIndex) => {
        set(
          (state) => {
            const newMap = new Map(state.annotationTypes);
            let changed = false;
            newMap.forEach((entry, key) => {
              if (entry.classIndex === classIndex) {
                newMap.delete(key);
                changed = true;
              }
            });
            if (!changed) {
              return state;
            }
            return {
              annotationTypes: newMap,
              version: state.version + 1,
            };
          },
          false,
          'annotationTypes/removeByClassIndex'
        );
      },
    }),
    { name: 'AnnotationTypeStore' }
  )
);

// Export the store instance for direct access
export { annotationTypeStore };

// Convenience helper functions for common operations
export const getAnnotationTypeEntry = (id: string | number) =>
  annotationTypeStore.getState().annotationTypes.get(normalizedId(id));

export const getAllAnnotationTypes = () =>
  annotationTypeStore.getState().annotationTypes;

export const useAnnotationTypes = () => {
  const annotationTypes = useStore(annotationTypeStore, (state) => state.annotationTypes);
  const version = useStore(annotationTypeStore, (state) => state.version);
  return { annotationTypes, version };
};

