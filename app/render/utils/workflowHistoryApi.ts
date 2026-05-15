import { apiFetch } from '@/utils/common/apiFetch';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { WorkflowPanel } from '@/store/slices/chat/workflowSlice';

const BASE = () => `${AI_SERVICE_API_ENDPOINT}/workflow_history/v1/workflow_history`;

export interface CloudWorkflowHistoryEntry {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  zarr_path: string;
  panels: WorkflowPanel[];
  output_path: string;
  color?: string;
  number?: number;
}

export interface SaveWorkflowHistoryParams {
  id?: string;
  name?: string;
  zarr_path: string;
  panels: WorkflowPanel[];
  output_path: string;
  color?: string;
  number?: number;
}

export async function saveWorkflowHistory(params: SaveWorkflowHistoryParams): Promise<string> {
  const res = await apiFetch(BASE(), {
    method: 'POST',
    body: JSON.stringify(params),
    returnAxiosFormat: true,
  });
  return res.data?.id as string;
}

export async function fetchWorkflowHistoryList(): Promise<CloudWorkflowHistoryEntry[]> {
  const res = await apiFetch(BASE(), {
    method: 'GET',
    returnAxiosFormat: true,
  });
  return (res.data?.entries ?? []) as CloudWorkflowHistoryEntry[];
}

export async function fetchWorkflowHistoryEntry(id: string): Promise<CloudWorkflowHistoryEntry> {
  const res = await apiFetch(`${BASE()}/${id}`, {
    method: 'GET',
    returnAxiosFormat: true,
  });
  return res.data as CloudWorkflowHistoryEntry;
}

export async function deleteWorkflowHistoryEntry(id: string): Promise<void> {
  await apiFetch(`${BASE()}/${id}`, {
    method: 'DELETE',
    returnAxiosFormat: true,
  });
}
