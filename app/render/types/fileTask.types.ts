export type FileTaskStatus = 'idle' | 'queued' | 'running' | 'completed' | 'error';

export interface FileTaskState {
  status: FileTaskStatus;
  progress: number;
  error?: string | null;
  startedAt?: number;
  completedAt?: number;
  queuePosition?: number; // Position in queue (1-based)
  queueTotal?: number;    // Total items in queue
}
