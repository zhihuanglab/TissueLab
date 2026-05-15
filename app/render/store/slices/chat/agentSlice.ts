import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface WorkflowStep {
    step: number
    model: string
    input: string
}

export type AgentName = "TLAgent" | "TL Discovery"

interface AgentState {
    workflow: WorkflowStep[]
    selectedAgent: AgentName
}

// Load selectedAgent from localStorage if available
const getInitialSelectedAgent = (): AgentName => {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('tl_selected_agent');
        if (saved === 'TLAgent' || saved === 'TL Discovery') {
            return saved as AgentName;
        }
    }
    return "TLAgent";
};

const initialState: AgentState = {
    workflow: [],
    selectedAgent: getInitialSelectedAgent(),
}

const AgentSlice = createSlice({
    name: 'agentSlice',
    initialState,
    reducers: {
        setWorkflow(state, action: PayloadAction<WorkflowStep[]>) {
            state.workflow = action.payload
        },
        setSelectedAgent: (state, action: PayloadAction<AgentName>) => {
            state.selectedAgent = action.payload;
            // Persist to localStorage
            if (typeof window !== 'undefined') {
                localStorage.setItem('tl_selected_agent', action.payload);
            }
        }
    },
})

export const {
    setWorkflow,
    setSelectedAgent
} = AgentSlice.actions

export default AgentSlice.reducer
