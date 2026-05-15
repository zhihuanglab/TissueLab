import { create, useStore } from 'zustand';

import { useSignupModalStore, SignupModalStore } from './slice/signupModal';
import { useWorkflowHistoryStore, WorkflowHistoryStore } from './slice/workflowHistory';
import {
  useWorkflowGraphChatBridgeStore,
  WorkflowGraphChatBridgeStore,
} from './slice/workflowGraphChatBridge';

type AppStore = SignupModalStore & WorkflowHistoryStore & WorkflowGraphChatBridgeStore;

const useRootStore = create<AppStore>((...a) => ({
  ...useSignupModalStore(...a),
  ...useWorkflowHistoryStore(...a),
  ...useWorkflowGraphChatBridgeStore(...a),
}));

export const useSignupModal = <Tab>(
  selector?: (state: SignupModalStore) => Tab
) => useStore(useRootStore, selector!);

export const useWorkflowHistory = <Tab>(
  selector?: (state: WorkflowHistoryStore) => Tab
) => useStore(useRootStore, selector!);

// Export the store instance for use outside of React components
export const signupModalStore = useRootStore;

export default useRootStore;
