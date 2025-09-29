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
}

const initialState: ShapeState = {
    shapeData: undefined,
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
        },
    },
});

export const { setShapeData, resetShapeData } = shapeSlice.actions;
export default shapeSlice.reducer;
