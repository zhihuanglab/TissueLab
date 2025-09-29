export type FileTaskStatus = 'idle' | 'queued' | 'running' | 'completed' | 'error';

export interface FileTaskState {
  status: FileTaskStatus;
  progress: number;
  error?: string | null;
  startedAt?: number;
  completedAt?: number;
}
