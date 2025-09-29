import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface Message {
  id: number;
  sender: string;
  content: string;
  type: string;
}

interface ChatState {
  isGenerating: boolean;
  messages: Message[];
}

const createWelcomeMessage = (): Message => ({
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
    addMessage: (state, action: PayloadAction<Message>) => {
      state.messages.push(action.payload);
    },
    clearMessages: (state) => {
      state.messages = [createWelcomeMessage()];
    },
    setIsGenerating: (state, action: PayloadAction<boolean>) => {
      state.isGenerating = action.payload;
    }
  },
});

export const { addMessage, clearMessages, setIsGenerating } = chatSlice.actions;
export default chatSlice.reducer;
