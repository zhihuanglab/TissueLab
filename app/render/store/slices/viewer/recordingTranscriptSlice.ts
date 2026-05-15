// store/slices/viewer/recordingTranscriptSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export interface TranscriptSegment {
  id: string
  text: string
  timestamp: number
  isFinal: boolean
  /** 'gpt' = follow-up question from GPT (triggered by keyword); omit = user transcript */
  source?: 'user' | 'gpt'
}

interface RecordingTranscriptState {
  segments: TranscriptSegment[]
  /** UI only: show segments from this index; full segments still uploaded with behavior */
  displayStartIndex: number
  isListening: boolean
  transcriptActive: boolean
  lastError: string | null
  /** true when backend sent gpt_thinking (agent is asking) */
  gptThinking: boolean
}

const initialState: RecordingTranscriptState = {
  segments: [],
  displayStartIndex: 0,
  isListening: false,
  transcriptActive: false,
  lastError: null,
  gptThinking: false,
}

const recordingTranscriptSlice = createSlice({
  name: 'recordingTranscript',
  initialState,
  reducers: {
    appendSegment(state, action: PayloadAction<TranscriptSegment>) {
      const seg = action.payload
      const existing = state.segments.findIndex((s) => s.id === seg.id)
      if (existing >= 0) {
        state.segments[existing] = seg
      } else {
        state.segments.push(seg)
      }
    },
    setListening(state, action: PayloadAction<boolean>) {
      state.isListening = action.payload
    },
    clearTranscript(state) {
      state.segments = []
      state.displayStartIndex = 0
    },
    /** Clear UI only: show only segments added after this point; full segments still uploaded */
    resetTranscriptDisplay(state) {
      state.displayStartIndex = state.segments.length
    },
    setTranscriptActive(state, action: PayloadAction<boolean>) {
      state.transcriptActive = action.payload
    },
    setTranscriptError(state, action: PayloadAction<string | null>) {
      state.lastError = action.payload
    },
    setGptThinking(state, action: PayloadAction<boolean>) {
      state.gptThinking = action.payload
    },
  },
})

export const { appendSegment, setListening, clearTranscript, resetTranscriptDisplay, setTranscriptActive, setTranscriptError, setGptThinking } = recordingTranscriptSlice.actions
export default recordingTranscriptSlice.reducer
