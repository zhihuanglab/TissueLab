import type { AppDispatch } from '@/store';
import { store } from '@/store';
import {
  initPanelsFromWorkflow,
  resetWorkflow,
  resetWorkflowStatus,
  setOutputPath,
} from '@/store/slices/chat/workflowSlice';
import { hydrateCodingAgentPanelsIfEmpty } from '@/utils/workflow/persistCodingAgentScript';
import { formatPath } from '@/utils/pathUtils';

export type WorkflowPreviewStep = {
  step: number;
  model: string;
  impl?: string | null;
  input?: unknown;
};

export type WorkflowPreviewPayload = {
  type: 'workflow-card';
  steps: WorkflowPreviewStep[];
};

export function isWorkflowPreviewPayload(content: unknown): content is WorkflowPreviewPayload {
  return Boolean(
    content &&
      typeof content === 'object' &&
      (content as WorkflowPreviewPayload).type === 'workflow-card' &&
      Array.isArray((content as WorkflowPreviewPayload).steps)
  );
}

/** Last chat message whose type or content is a workflow card (reverse scan). */
export function findLastWorkflowCardPayload(
  messages: { type: string; content: unknown }[]
): WorkflowPreviewPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'workflow-card' && isWorkflowPreviewPayload(m.content)) {
      return m.content;
    }
    if (isWorkflowPreviewPayload(m.content)) {
      return m.content;
    }
  }
  return null;
}

/** Load steps into Redux the same way as a fresh Agent workflow design response. */
export function applyWorkflowPreviewSteps(
  dispatch: AppDispatch,
  steps: WorkflowPreviewStep[],
  currentPath: string | null | undefined
): void {
  if (!steps?.length) return;
  const formattedPath = formatPath(currentPath ?? '');
  const workflow = steps.map((s) => ({
    step: s.step,
    model: s.model,
    impl: s.impl ?? undefined,
    input: s.input,
  }));
  dispatch(resetWorkflow());
  dispatch(resetWorkflowStatus());
  dispatch(initPanelsFromWorkflow({ workflow, formattedPath }));
  hydrateCodingAgentPanelsIfEmpty(dispatch, store.getState().workflow.panels, formattedPath);
  const out =
    !formattedPath ? '' : formattedPath.endsWith('.zarr') ? formattedPath : `${formattedPath}.zarr`;
  dispatch(setOutputPath(out));
}
