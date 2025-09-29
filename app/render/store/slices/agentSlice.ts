import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface WorkflowStep {
    step: number
    model: string
    input: string
}

interface AgentState {
    workflow: WorkflowStep[]
}

const initialState: AgentState = {
    workflow: [],
}

const AgentSlice = createSlice({
    name: 'agentSlice',
    initialState,
    reducers: {
        setWorkflow(state, action: PayloadAction<WorkflowStep[]>) {
            state.workflow = action.payload
        },
    },
})

export const {
    setWorkflow
} = AgentSlice.actions

export default AgentSlice.reducer
