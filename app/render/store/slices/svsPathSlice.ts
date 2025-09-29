import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Channel {
  name: string;
  color: string;
  isVisible: boolean;
}

interface SlideInfo {
  dimensions: [number, number] | null;
  fileSize: number | null;
  mpp: number | null;
  magnification: string | number | null;
  imageType: string | null;
  totalAnnotations: number;
  totalCells: number;
  processingStatus: string;
  totalTiles: number;
}

interface SvsPathState {
  currentPath: string | null;
  totalChannels: number;
  channels: Channel[];
  visibleChannels: number[];
  slideInfo: SlideInfo;
}

const initialState: SvsPathState = {
  currentPath: null,
  totalChannels: 3,
  channels: [],
  visibleChannels: [],
  slideInfo: {
    dimensions: null,
    fileSize: null,
    mpp: null,
    magnification: null,
    imageType: null,
    totalAnnotations: 0,
    totalCells: 0,
    processingStatus: 'Pending',
    totalTiles: 0
  }
};

interface ColorUpdate {
  index: number;
  color: string;
}

const svsPathSlice = createSlice({
  name: 'svsPath',
  initialState,
  reducers: {
    setCurrentPath: (state, action: PayloadAction<{ path: string | null }>) => {
      state.currentPath = action.payload.path;
    },
    setSlideInfo: (state, action: PayloadAction<Partial<SlideInfo>>) => {
      state.slideInfo = {
        ...state.slideInfo,
        ...action.payload
      };
    },
    setTotalChannels: (state, action: PayloadAction<number>) => {
      state.totalChannels = action.payload;
      state.channels = Array.from({ length: action.payload }, (_, index) => ({
        name: `Channel ${index + 1}`,
        color: `#${Math.floor(Math.random()*16777215).toString(16)}`,
        isVisible: index < 3 
      }));
      
      state.visibleChannels = state.channels
        .map((channel, index) => channel.isVisible ? index : -1)
        .filter(index => index !== -1);
    },
    toggleChannel: (state, action: PayloadAction<number>) => {
      const channelIndex = action.payload;
      if (state.visibleChannels.includes(channelIndex)) {
        state.visibleChannels = state.visibleChannels.filter(ch => ch !== channelIndex);
      } else {
        state.visibleChannels = [...state.visibleChannels, channelIndex];
      }
    },
    setChannelColor: (state, action: PayloadAction<{index: number, color: string}>) => {
      const {index, color} = action.payload;
      if (state.channels[index]) {
        state.channels[index].color = color;
      }
    },
    setAllChannelsVisibility: (state, action: PayloadAction<boolean>) => {
      state.channels.forEach(channel => {
        channel.isVisible = action.payload;
      });
      state.visibleChannels = action.payload 
        ? Array.from({ length: state.channels.length }, (_, i) => i)
        : [];
    },
    initializeChannels: (state) => {
      const channelCount = state.totalChannels;
      state.channels = Array.from({ length: channelCount }, (_, index) => ({
        name: `Channel ${index + 1}`,
        color: `#${Math.floor(Math.random()*16777215).toString(16)}`,
        isVisible: index < Math.min(4, channelCount) // Show up to 4 channels by default
      }));
      state.visibleChannels = Array.from({ length: Math.min(4, channelCount) }, (_, i) => i);
    },
    batchUpdateChannelColors: (state, action: PayloadAction<ColorUpdate[]>) => {
      action.payload.forEach(update => {
        if (state.channels[update.index]) {
          state.channels[update.index].color = update.color;
        }
      });
    },
    updateProcessingStatus: (state, action: PayloadAction<string>) => {
      state.slideInfo.processingStatus = action.payload;
    },
    updateTotalCells: (state, action: PayloadAction<number>) => {
      state.slideInfo.totalCells = action.payload;
    },
    updateTotalAnnotations: (state, action: PayloadAction<number>) => {
      state.slideInfo.totalAnnotations = action.payload;
    }
  },
});

export const { 
  setCurrentPath, 
  setTotalChannels, 
  toggleChannel,
  setChannelColor,
  setAllChannelsVisibility,
  initializeChannels,
  batchUpdateChannelColors,
  setSlideInfo,
  updateProcessingStatus,
  updateTotalCells,
  updateTotalAnnotations
} = svsPathSlice.actions;

export default svsPathSlice.reducer; 