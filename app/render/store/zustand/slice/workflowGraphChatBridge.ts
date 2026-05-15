import { StateCreator, StoreApi } from 'zustand';

/** Matches GeneratedWorkflowStep fields needed to rebuild the graph */
export type PendingWorkflowGraphApply = {
  steps: Array<{
    step: number;
    model: string;
    impl?: string | null;
    input?: unknown;
    prompt?: string;
    type?: string;
    ui?: Record<string, unknown> | null;
  }>;
  formattedPath: string;
};

const initialState = {
  pendingApplyFromChat: null as PendingWorkflowGraphApply | null,
};

type State = typeof initialState;

type Actions = {
  queueWorkflowFromChatCard: (payload: PendingWorkflowGraphApply) => void;
  clearPendingWorkflowFromChat: () => void;
};

export type WorkflowGraphChatBridgeStore = State & Actions;

const bridgeActions = (
  set: StoreApi<WorkflowGraphChatBridgeStore>['setState']
): Actions => ({
  queueWorkflowFromChatCard: (payload) => set({ pendingApplyFromChat: payload }),
  clearPendingWorkflowFromChat: () => set({ pendingApplyFromChat: null }),
});

export const useWorkflowGraphChatBridgeStore: StateCreator<WorkflowGraphChatBridgeStore> = (
  set,
  _get,
  _api
) => ({
  ...initialState,
  ...bridgeActions(set),
});
