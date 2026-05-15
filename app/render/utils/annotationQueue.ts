/**
 * Queue-based sequential IO operations for batch annotation processing
 * 
 * This module provides a queue system to handle rapid annotation operations,
 * ensuring sequential processing to avoid conflicts and improve performance.
 */

import { apiFetch } from '@/utils/common/apiFetch';
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { AppDispatch, store } from "@/store";
import {
  scheduleCoalescedClassificationAfterAnnotation,
  scheduleCoalescedPatchClassificationAfterAnnotation,
} from "@/utils/workflowUtils";

export type AnnotationType = 'cell' | 'patch';

export interface CellAnnotationTask {
  type: 'cell';
  payload: {
    path: string;
    region_geometry: { x1: number; y1: number; x2: number; y2: number };
    matching_indices: number[];
    classification: string;
    color: string;
    method: string;
    annotator: string;
    ui_nuclei_classes: string[];
    ui_nuclei_colors: string[];
    ui_organ: string | null;
  };
  headers?: Record<string, string>;
  workflowConfig?: {
    classifierPath?: string | null;
    saveClassifierPath?: string | null;
  };
  onSuccess?: (response: any) => void;
  onError?: (error: any) => void;
  optimisticUpdate?: () => void;
  revertOptimisticUpdate?: () => void;
}

export interface PatchAnnotationTask {
  type: 'patch';
  payload: {
    path: string;
    start_x: number;
    start_y: number;
    end_x: number;
    end_y: number;
    classification: string;
    color: string;
    method: string;
    annotator: string;
    polygon_points?: number[][];
  };
  onSuccess?: (response: any) => void;
  onError?: (error: any) => void;
  optimisticUpdate?: () => void;
  revertOptimisticUpdate?: () => void;
}

export type AnnotationTask = CellAnnotationTask | PatchAnnotationTask;

interface WorkflowTriggerConfig {
  zarrPath: string;
  type: 'cell' | 'patch';
}

class AnnotationQueue {
  private queue: AnnotationTask[] = [];
  private processing: boolean = false;
  private workflowTriggerTimer: NodeJS.Timeout | null = null;
  private pendingWorkflowConfig: WorkflowTriggerConfig | null = null;
  private dispatch: AppDispatch | null = null;
  private updateAfterEveryAnnotation: boolean = false;
  private updatePatchAfterEveryAnnotation: boolean = false;

  // Debounce delay for workflow triggers (ms)
  private readonly WORKFLOW_DEBOUNCE_DELAY = 2000; // 2 seconds

  // Batch processing: collect annotations for a short period before processing
  private batchTimer: NodeJS.Timeout | null = null;
  private batchDelay: number = 150; // 150ms batch window
  private pendingBatch: {
    cell: Map<string, CellAnnotationTask[]>; // key: path + classification + color
    patch: Map<string, PatchAnnotationTask[]>; // key: path
  } = {
    cell: new Map(),
    patch: new Map(),
  };

  /**
   * Initialize the queue with Redux dispatch
   */
  initialize(dispatch: AppDispatch) {
    this.dispatch = dispatch;
  }

  /**
   * Update workflow trigger settings
   */
  updateWorkflowSettings(
    updateAfterEveryAnnotation: boolean,
    updatePatchAfterEveryAnnotation: boolean
  ) {
    this.updateAfterEveryAnnotation = updateAfterEveryAnnotation;
    this.updatePatchAfterEveryAnnotation = updatePatchAfterEveryAnnotation;
  }

  /**
   * Add an annotation task to the queue
   * Uses batching to merge rapid annotations
   */
  enqueue(task: AnnotationTask) {
    // Apply optimistic update immediately for responsive UI
    if (task.optimisticUpdate) {
      task.optimisticUpdate();
    }

    // Add to batch for potential merging
    this.addToBatch(task);

    // Reset batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Process batch after delay (allows merging rapid annotations)
    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, this.batchDelay);
  }

  /**
   * Add task to batch for potential merging
   */
  private addToBatch(task: AnnotationTask) {
    if (task.type === 'cell') {
      // Create key: path + classification + color (same class annotations can be merged)
      const key = `${task.payload.path}|${task.payload.classification}|${task.payload.color}`;
      if (!this.pendingBatch.cell.has(key)) {
        this.pendingBatch.cell.set(key, []);
      }
      this.pendingBatch.cell.get(key)!.push(task);
    } else {
      // Patch annotations: group by path only (each patch annotation is unique)
      const key = task.payload.path;
      if (!this.pendingBatch.patch.has(key)) {
        this.pendingBatch.patch.set(key, []);
      }
      this.pendingBatch.patch.get(key)!.push(task);
    }
  }

  /**
   * Flush batch: merge and process annotations
   * All annotations in the batch window are processed together
   */
  private flushBatch() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Collect all tasks from batch
    const allCellTasks: CellAnnotationTask[] = [];
    const allPatchTasks: PatchAnnotationTask[] = [];

    // Collect cell annotations (merge same class)
    for (const [key, tasks] of Array.from(this.pendingBatch.cell.entries())) {
      if (tasks.length === 0) continue;

      if (tasks.length === 1) {
        allCellTasks.push(tasks[0]);
      } else {
        // Multiple annotations of same class, merge them
        const mergedTask = this.mergeCellAnnotations(tasks);
        allCellTasks.push(mergedTask);
      }
    }

    // Collect patch annotations
    for (const [key, tasks] of Array.from(this.pendingBatch.patch.entries())) {
      allPatchTasks.push(...tasks);
    }

    // Clear batch
    this.pendingBatch.cell.clear();
    this.pendingBatch.patch.clear();

    // Process all tasks in parallel (not sequentially)
    // This ensures batch window annotations are sent together
    if (allCellTasks.length > 0 || allPatchTasks.length > 0) {
      this.processBatchInParallel([...allCellTasks, ...allPatchTasks]);
    }
  }

  /**
   * Process batch tasks in parallel
   * This ensures all annotations in the batch window are sent together
   */
  private async processBatchInParallel(tasks: AnnotationTask[]) {
    // Process all tasks in parallel
    const promises = tasks.map(task => 
      this.processTask(task).catch(error => {
        console.error('[AnnotationQueue] Error processing batch task:', error);
        if (task.onError) {
          task.onError(error);
        }
        if (task.revertOptimisticUpdate) {
          task.revertOptimisticUpdate();
        }
        return null; // Continue processing other tasks even if one fails
      })
    );

    // Wait for all tasks to complete
    await Promise.all(promises);
  }

  /**
   * Merge multiple cell annotations of the same class into one request
   */
  private mergeCellAnnotations(tasks: CellAnnotationTask[]): CellAnnotationTask {
    if (tasks.length === 0) {
      throw new Error('Cannot merge empty task list');
    }

    if (tasks.length === 1) {
      return tasks[0];
    }

    // Use first task as base
    const baseTask = tasks[0];

    // Merge all matching_indices
    const mergedIndices: number[] = [];
    const allOptimisticUpdates: (() => void)[] = [];
    const allRevertUpdates: (() => void)[] = [];
    const allSuccessCallbacks: ((response: any) => void)[] = [];
    const allErrorCallbacks: ((error: any) => void)[] = [];

    for (const task of tasks) {
      mergedIndices.push(...task.payload.matching_indices);
      if (task.optimisticUpdate) allOptimisticUpdates.push(task.optimisticUpdate);
      if (task.revertOptimisticUpdate) allRevertUpdates.push(task.revertOptimisticUpdate);
      if (task.onSuccess) allSuccessCallbacks.push(task.onSuccess);
      if (task.onError) allErrorCallbacks.push(task.onError);
    }

    // Remove duplicates
    const uniqueIndices = Array.from(new Set(mergedIndices));

    return {
      ...baseTask,
      payload: {
        ...baseTask.payload,
        matching_indices: uniqueIndices,
      },
      optimisticUpdate: () => {
        allOptimisticUpdates.forEach(fn => fn());
      },
      revertOptimisticUpdate: () => {
        allRevertUpdates.forEach(fn => fn());
      },
      onSuccess: (response: any) => {
        allSuccessCallbacks.forEach(fn => fn(response));
      },
      onError: (error: any) => {
        allErrorCallbacks.forEach(fn => fn(error));
      },
    };
  }

  /**
   * Process the queue sequentially
   * Note: This is now mainly used for non-batch scenarios
   * Batch processing uses processBatchInParallel instead
   */
  private async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      try {
        await this.processTask(task);
      } catch (error) {
        console.error('[AnnotationQueue] Error processing task:', error);
        if (task.onError) {
          task.onError(error);
        }
        // Revert optimistic update on error
        if (task.revertOptimisticUpdate) {
          task.revertOptimisticUpdate();
        }
      }
    }

    this.processing = false;
  }

  /**
   * Process a single annotation task
   */
  private async processTask(task: AnnotationTask) {
    if (task.type === 'cell') {
      await this.processCellAnnotation(task);
    } else {
      await this.processPatchAnnotation(task);
    }
  }

  /**
   * Process cell annotation
   */
  private async processCellAnnotation(task: CellAnnotationTask) {
    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`;
    
    try {
      const response = await apiFetch(saveUrl, {
        method: 'POST',
        body: JSON.stringify(task.payload),
        headers: task.headers,
        returnAxiosFormat: true,
      });
      
      if (response.status === 200) {
        // Success callback (response.data is unwrapped AppResponse payload)
        if (task.onSuccess) {
          task.onSuccess(response.data);
        }

        // Schedule workflow trigger if enabled
        if (this.updateAfterEveryAnnotation && this.dispatch && task.payload.ui_nuclei_classes) {
          this.scheduleWorkflowTrigger({
            zarrPath: task.payload.path,
            type: 'cell',
          });
        }
      } else {
        throw new Error(
          (response.data as { message?: string })?.message || 'Unknown save_annotation error'
        );
      }
    } catch (error) {
      if (task.revertOptimisticUpdate) {
        task.revertOptimisticUpdate();
      }
      throw error;
    }
  }

  /**
   * Process patch annotation
   */
  private async processPatchAnnotation(task: PatchAnnotationTask) {
    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_tissue`;
    
    const payload: any = {
      path: task.payload.path,
      start_x: task.payload.start_x,
      start_y: task.payload.start_y,
      end_x: task.payload.end_x,
      end_y: task.payload.end_y,
      classification: task.payload.classification,
      color: task.payload.color,
      method: task.payload.method,
      annotator: task.payload.annotator,
    };

    if (task.payload.polygon_points) {
      payload.polygon_points = task.payload.polygon_points;
    }

    try {
      const response = await apiFetch(saveUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        returnAxiosFormat: true,
      });
      
      if (response.status === 200) {
        if (task.onSuccess) {
          task.onSuccess(response.data);
        }

        // Schedule workflow trigger if enabled
        // Note: patch workflow config needs to be provided separately
        // as it's not included in the task payload
      } else {
        throw new Error(
          (response.data as { message?: string })?.message || 'Unknown save_tissue error'
        );
      }
    } catch (error) {
      if (task.revertOptimisticUpdate) {
        task.revertOptimisticUpdate();
      }
      throw error;
    }
  }

  /**
   * Schedule workflow trigger with debounce
   * This merges multiple rapid annotations into a single workflow trigger
   */
  private scheduleWorkflowTrigger(config: WorkflowTriggerConfig) {
    // Clear existing timer
    if (this.workflowTriggerTimer) {
      clearTimeout(this.workflowTriggerTimer);
    }

    // Update pending config (this will be the latest one)
    this.pendingWorkflowConfig = config;

    // Set new timer
    this.workflowTriggerTimer = setTimeout(() => {
      this.triggerWorkflow();
    }, this.WORKFLOW_DEBOUNCE_DELAY);
  }

  /**
   * Trigger the workflow with the latest pending config
   */
  private async triggerWorkflow() {
    if (!this.pendingWorkflowConfig || !this.dispatch) {
      return;
    }

    const config = this.pendingWorkflowConfig;
    this.pendingWorkflowConfig = null;
    this.workflowTriggerTimer = null;

    try {
      if (config.type === 'cell') {
        scheduleCoalescedClassificationAfterAnnotation(() => {
          const st = store.getState();
          if (!st.workflow.updateAfterEveryAnnotation) return null;
          if (!st.annotations.nucleiClasses?.length) return null;
          return { zarrPath: config.zarrPath, source: "annotation-queue" };
        });
      } else if (config.type === 'patch') {
        scheduleCoalescedPatchClassificationAfterAnnotation(() => {
          const st = store.getState();
          if (!st.workflow.updatePatchAfterEveryAnnotation) return null;
          return { zarrPath: config.zarrPath, source: "annotation-queue" };
        });
      }
    } catch (error) {
      console.error('[AnnotationQueue] Error triggering workflow:', error);
    }
  }

  /**
   * Manually trigger workflow for patch annotations
   * (Called from AnnotationPopup which has access to patch classification data)
   */
  async triggerPatchWorkflow(
    zarrPath: string,
    _patchClassificationData: { class_name: string[]; class_hex_color: string[] },
    _patchClassifierPath: string | null,
    _patchClassifierSavePath: string | null
  ) {
    if (!this.updatePatchAfterEveryAnnotation || !this.dispatch) {
      return;
    }

    this.scheduleWorkflowTrigger({
      zarrPath,
      type: 'patch',
    });
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Clear the queue (useful for cleanup)
   */
  clear() {
    this.queue = [];
    if (this.workflowTriggerTimer) {
      clearTimeout(this.workflowTriggerTimer);
      this.workflowTriggerTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingWorkflowConfig = null;
    this.pendingBatch.cell.clear();
    this.pendingBatch.patch.clear();
  }

  /**
   * Flush pending workflow trigger immediately
   */
  flushWorkflowTrigger() {
    if (this.workflowTriggerTimer) {
      clearTimeout(this.workflowTriggerTimer);
      this.workflowTriggerTimer = null;
    }
    if (this.pendingWorkflowConfig) {
      this.triggerWorkflow();
    }
  }
}

// Singleton instance
export const annotationQueue = new AnnotationQueue();

