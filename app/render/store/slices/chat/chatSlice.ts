import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export interface ChatMessage {
  id: number;
  sender: string;
  content: unknown;
  type: string;
}

interface ChatState {
  isGenerating: boolean;
  messages: ChatMessage[];
}

const createWelcomeMessage = (): ChatMessage => ({
  id: Date.now(),
  sender: "bot",
  type: "welcome",
  content:
    "Welcome to TissueLab! I'm TissueLab Agent — here to help you navigate and use this platform. I can answer questions, design research workflows, and analyze results. Let me know what you need help with!",
});

const initialState: ChatState = {
  isGenerating: false,
  messages: [createWelcomeMessage()],
};

export const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    addMessage: (state, action: PayloadAction<ChatMessage>) => {
      state.messages.push(action.payload);
    },
    setMessages: (state, action: PayloadAction<ChatMessage[]>) => {
      const next = action.payload;
      state.messages = next.length > 0 ? next : [createWelcomeMessage()];
    },
    clearMessages: (state) => {
      state.messages = [createWelcomeMessage()];
    },
    setIsGenerating: (state, action: PayloadAction<boolean>) => {
      state.isGenerating = action.payload;
    },
    updateMessageContent: (
      state,
      action: PayloadAction<{ id: number; content: unknown }>,
    ) => {
      const msg = state.messages.find((m) => m.id === action.payload.id);
      if (msg) {
        msg.content = action.payload.content;
      }
    },
  },
});

export const { addMessage, setMessages, clearMessages, setIsGenerating, updateMessageContent } =
  chatSlice.actions;
export default chatSlice.reducer;
