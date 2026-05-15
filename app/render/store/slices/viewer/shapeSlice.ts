import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface RectangleCoords {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export type Point = [number, number];

export interface ShapeData {
    rectangleCoords: RectangleCoords;
    polygonPoints?: Point[]; // Polygon points are in image coordinates
}

export interface ShapeState {
    shapeData?: ShapeData;
    /** Centroid indices to highlight (prob >= threshold in filter popup). When set, overlay highlights only these; others in region are dimmed. */
    filterHighlightIndices: number[] | null;
}

const initialState: ShapeState = {
    shapeData: undefined,
    filterHighlightIndices: null,
};

export const shapeSlice = createSlice({
    name: 'shape',
    initialState,
    reducers: {
        setShapeData(
            state,
            action: PayloadAction<ShapeData>
        ) {
            state.shapeData = action.payload;
        },
        resetShapeData(state) {
            state.shapeData = undefined;
            state.filterHighlightIndices = null;
        },
        setFilterHighlightIndices(
            state,
            action: PayloadAction<number[] | null>
        ) {
            state.filterHighlightIndices = action.payload;
        },
    },
});

export const { setShapeData, resetShapeData, setFilterHighlightIndices } = shapeSlice.actions;
export default shapeSlice.reducer;
