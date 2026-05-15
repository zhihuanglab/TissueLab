import { useSelector } from "react-redux";
import { RootState } from "@/store";
import { ReviewState } from "@/store/slices/reviewSlice";

export const useReview = (): ReviewState => {
  return useSelector((state: RootState) => {
    // Provide default values if the slice doesn't exist
    if (!state.review) {
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
        isReviewOpen: false,
        probDistCache: null,
      };
    }
    return state.review;
  });
};

// Keep backward compatibility alias
export const useActiveLearning = useReview;

export const useNucleiClasses = () => {
  return useSelector((state: RootState) => {
    if (!state.annotations?.nucleiClasses) {
      return [];
    }
    return state.annotations.nucleiClasses;
  });
};

