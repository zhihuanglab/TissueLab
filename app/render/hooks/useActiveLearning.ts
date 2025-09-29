import { useSelector } from "react-redux";
import { RootState } from "@/store";
import { ALState } from "@/store/slices/activeLearningSlice";

export const useActiveLearning = (): ALState => {
  return useSelector((state: RootState) => {
    // Provide default values if the slice doesn't exist
    if (!state.activeLearning) {
      return {
        classFilter: [],
        selectedClass: null,
        roi: null,
        threshold: 0.5,
        sort: 'asc' as const,
        hist: Array(20).fill(0),
        zoom: 40.0,
        page: 0,
        pageSize: 24,
        total: 0,
        items: [],
        loading: false,
        error: null,
        slideId: null,
        className: null,
        isActiveLearningOpen: false,
        probDistCache: null,
      };
    }
    return state.activeLearning;
  });
};

export const useNucleiClasses = () => {
  return useSelector((state: RootState) => {
    if (!state.annotations?.nucleiClasses) {
      return [];
    }
    return state.annotations.nucleiClasses;
  });
};