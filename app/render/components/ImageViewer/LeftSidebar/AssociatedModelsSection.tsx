import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, Plus, RefreshCw } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { setAssociatedModels } from '@/store/slices/fileManagerSlice';
import {
  setSelectedModelForPath,
  setAvailableModelsForPath,
  validateAllSelections,
  selectSelectedModelForPath,
} from '@/store/slices/chat/modelSelectionSlice';
import { listFiles } from '@/utils/dashboard/fileManager.service';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/common/apiFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { getAuthToken } from '@/utils/common/authToken';
import { toast } from 'sonner';
import type { FileTaskState } from '../fileTaskTypes';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import EventBus from '@/utils/EventBus';
import { isPublicReadOnlyPath, getRestrictedDirectoryMessage } from '@/utils/sampleDirectoryUtils';

interface TaskNodeInfo {
  name: string;
  running?: boolean;
  factory?: string;
  port?: number;
}

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}

// Helper function to find model files (tlcls) in the current directory
const findModelFiles = (fileList: FileItem[]): FileItem[] => {
  return fileList
    .filter(file => !file.is_dir && (
      file.name.toLowerCase().endsWith('.tlcls')
    ));
};

// Helper function to get model type description based on file extension
const getModelTypeDescription = (fileName: string): string => {
  const extension = fileName.toLowerCase().split('.').pop();
  switch (extension) {
    case 'tlcls':
      return 'TissueLab Classifier (.tlcls)';
    default:
      return 'Model File';
  }
};

const truncateFileName = (fileName: string, maxLength: number = 25) => {
  if (fileName.length <= maxLength) return fileName;
  const extension = fileName.split('.').pop() || '';
  const nameWithoutExt = fileName.slice(0, fileName.length - extension.length - 1);
  if (nameWithoutExt.length <= maxLength - 5) return fileName;
  const endChars = 3;
  const truncatedLength = maxLength - extension.length - endChars - 6;
  if (truncatedLength < 3) {
    const start = nameWithoutExt.slice(0, maxLength - extension.length - 4);
    return `${start}...${extension ? `.${extension}` : ''}`;
  }
  const start = nameWithoutExt.slice(0, truncatedLength);
  const end = nameWithoutExt.slice(-endChars);
  return `${start}...${end}${extension ? `.${extension}` : ''}`;
};

interface AssociatedModelsSectionProps {
  selectedFolder: string;
  electron?: any;
  imageFiles: FileItem[];
  fileTaskStates: Record<string, FileTaskState>;
  setFileTaskStates: React.Dispatch<React.SetStateAction<Record<string, FileTaskState>>>;
}

const AssociatedModelsSection: React.FC<AssociatedModelsSectionProps> = ({
  selectedFolder,
  electron,
  imageFiles,
  fileTaskStates,
  setFileTaskStates,
}) => {
  // Local Electron-only build: cloud file source no longer exists.
  const isWebMode = false;
  const dispatch = useDispatch();
  const [modelsMinimized, setModelsMinimized] = useState(true);
  const [modelFiles, setModelFiles] = useState<FileItem[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const batchIdRef = useRef(0);
  const fileTaskStatesRef = useRef(fileTaskStates);
  const [availableTaskNodes, setAvailableTaskNodes] = useState<TaskNodeInfo[]>([]);
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [nodeDialogModel, setNodeDialogModel] = useState<string | null>(null);
  const [selectedTaskNodeName, setSelectedTaskNodeName] = useState<string | null>(null);
  const [nodeDialogError, setNodeDialogError] = useState<string | null>(null);
  const [applyingModelName, setApplyingModelName] = useState<string | null>(null);
  
  // Helper function to check if a task node is a classification node
  // Only allow nodes with TissueClassify or NucleiClassify factories
  const isClassificationNode = useCallback((node: TaskNodeInfo): boolean => {
    return node.factory === 'TissueClassify' || node.factory === 'NucleiClassify';
  }, []);
  
  // Filter available task nodes to only include classification nodes
  const classificationTaskNodes = React.useMemo(() => {
    return availableTaskNodes.filter(isClassificationNode);
  }, [availableTaskNodes, isClassificationNode]);
  
  // New classifier creation states
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newClassifierName, setNewClassifierName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Calculate queue statistics
  const queueStats = React.useMemo(() => {
    const stats = {
      total: imageFiles.length,
      queued: 0,
      running: 0,
      completed: 0,
      error: 0,
      idle: 0,
    };
    
    imageFiles.forEach(file => {
      const taskState = fileTaskStates[file.path];
      if (taskState) {
        stats[taskState.status]++;
      } else {
        stats.idle++;
      }
    });
    
    return stats;
  }, [imageFiles, fileTaskStates]);

  // Ensure we're running on client side
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    fileTaskStatesRef.current = fileTaskStates;
  }, [fileTaskStates]);

  const mergeFileTaskUpdates = useCallback((updates: Record<string, Partial<FileTaskState>>) => {
    setFileTaskStates(prev => {
      const next: Record<string, FileTaskState> = { ...prev };
      for (const [path, partial] of Object.entries(updates)) {
        const previous = next[path] ?? {
          status: 'idle',
          progress: 0,
          error: null,
        };

        const { progress: partialProgress, ...rest } = partial;
        const progress = typeof partialProgress === 'number' && Number.isFinite(partialProgress)
          ? Math.max(0, Math.min(100, partialProgress))
          : previous.progress;

        next[path] = {
          ...previous,
          ...rest,
          progress,
        };
      }
      return next;
    });
  }, [setFileTaskStates]);

  const cleanupEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const fetchTaskNodes = useCallback(async () => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      if (resp.status !== 200) return;
      const data = resp.data;
      const nodes = (data?.data?.nodes ?? {}) as Record<string, any>;
      const list: TaskNodeInfo[] = Object.entries(nodes).map(([name, info]) => ({
        name,
        running: !!info?.running,
        factory: info?.factory,
        port: typeof info?.port === 'number' ? info.port : undefined,
      }));
      setAvailableTaskNodes(list);
    } catch (e) {
      // non-fatal
    }
  }, [setAvailableTaskNodes]);

  const openNodeDialog = useCallback((modelName: string) => {
    setNodeDialogModel(modelName);
    setNodeDialogError(null);
    // Set a default selection if possible - only from classification nodes
    const running = classificationTaskNodes.find(n => n.running);
    setSelectedTaskNodeName(running?.name || classificationTaskNodes[0]?.name || null);
    setNodeDialogOpen(true);
    // Ensure we refresh nodes on open
    fetchTaskNodes();
  }, [classificationTaskNodes, fetchTaskNodes]);

  const trackWorkflowToCompletion = useCallback((filePath: string, batchId: number) => {
    return new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      if (!isClient || typeof window === 'undefined') {
        resolve({ success: true });
        return;
      }

      cleanupEventSource();

      // Local-only build: backend resolves uid server-side, no token required.
      let eventSource;
      try {
        const authToken = await getAuthToken().catch(() => null);
        const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
        eventSource = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_status${qs}`);
      } catch (error) {
        console.error('Failed to open SSE for workflow tracking:', error);
        resolve({ success: false, error: 'Failed to open workflow status stream' });
        return;
      }
      eventSourceRef.current = eventSource;
      let resolved = false;

      const finish = (result: { success: boolean; error?: string }) => {
        if (!resolved) {
          resolved = true;
          cleanupEventSource();
          resolve(result);
        }
      };

      eventSource.onmessage = (event) => {
        if (batchIdRef.current !== batchId) {
          finish({ success: false, error: 'Batch cancelled' });
          return;
        }

        if (!event.data) {
          return;
        }

        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch (err) {
          return;
        }

        console.log('SSE data received from Sidebar:', data);

        if (data.node_status) {
          const nodeStatus = data.node_status as Record<string, number>;
          const nodeProgress = (data.node_progress ?? {}) as Record<string, number>;
          const statuses = Object.values(nodeStatus);
          const hasFailure = statuses.some(status => status === -1);

          const progressValues = Object.values(nodeProgress);
          let avgProgress = progressValues.length > 0
            ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)
            : 0;

          if (!Number.isFinite(avgProgress)) {
            avgProgress = 0;
          }

          if (avgProgress <= 0) {
            const totalNodes = Object.keys(nodeStatus).length;
            if (totalNodes > 0) {
              const completedNodes = statuses.filter(status => status === 2).length;
              const runningNodes = statuses.filter(status => status === 1).length;
              if (completedNodes === totalNodes) {
                avgProgress = 100;
              } else if (runningNodes > 0 || completedNodes > 0) {
                avgProgress = Math.max(10, Math.round((completedNodes / totalNodes) * 100));
              }
            }
          }

          if (!hasFailure && data.workflow_complete !== true) {
            avgProgress = Math.min(avgProgress, 99);
          }

          // Handle queue status from SSE
          if (data.node_status._workflow_status === 'queued') {
            mergeFileTaskUpdates({
              [filePath]: {
                status: 'queued',
                progress: 0,
                error: null,
                queuePosition: data.node_status._queue_position,
                queueTotal: data.node_status._queue_total,
              },
            });
          } else if (hasFailure) {
            mergeFileTaskUpdates({
              [filePath]: {
                status: 'error',
                progress: avgProgress,
                error: 'Workflow failed',
                completedAt: Date.now(),
              },
            });
            finish({ success: false, error: 'Workflow failed' });
            return;
          } else if (avgProgress > 0) {
            mergeFileTaskUpdates({
              [filePath]: {
                status: 'running',
                progress: avgProgress,
                error: null,
              },
            });
          }
        }

        if (data.workflow_complete === true) {
          mergeFileTaskUpdates({
            [filePath]: {
              progress: 100,
            },
          });
          finish({ success: true });
        }

        if (data.error) {
          const message = typeof data.error === 'string' ? data.error : 'Workflow error';
          mergeFileTaskUpdates({
            [filePath]: {
              status: 'error',
              error: message,
              completedAt: Date.now(),
            },
          });
          finish({ success: false, error: message });
        }
      };

      eventSource.onerror = () => {
        mergeFileTaskUpdates({
          [filePath]: {
            status: 'error',
            error: 'Lost connection to workflow status stream.',
            completedAt: Date.now(),
          },
        });
        finish({ success: false, error: 'Lost connection to workflow status stream.' });
      };
    });
  }, [cleanupEventSource, isClient, mergeFileTaskUpdates]);

  const { associatedModels } = useSelector((state: RootState) => state.fileManager);
  
  // Get current path from Redux store to auto-navigate to the folder containing the opened image
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  // Get selected model for current path
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    // In web mode, empty string means root directory
    if (isWebMode && targetPath === '') {
      targetPath = '';
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  // Function to refresh associated models for current folder
  const refreshAssociatedModels = useCallback(async () => {
    const currentPath = selectedFolder || '';
    // In web mode, empty string means root directory, so it's valid
    if (!isWebMode && !currentPath) return;

    setIsRefreshing(true);
    try {
      let result: FileItem[] = [];
      
      if (isWebMode) {
        result = await listFiles(currentPath);
      } else if (electron) {
        result = await electron.listLocalFiles(currentPath);
      } else {
        return;
      }

      // Find and update associated model files
      const foundModelFiles = findModelFiles(result);
      setModelFiles(foundModelFiles);
      const modelNames = foundModelFiles.map(file => file.name);
      dispatch(setAssociatedModels(modelNames));
      
      // Update available models for this path
      dispatch(setAvailableModelsForPath({ path: currentPath, models: modelNames }));
      
      // Validate existing selections
      dispatch(validateAllSelections());
      
      // Do not auto-select any model by default
    } catch (err: any) {
      console.error('Error refreshing associated models:', err);
      dispatch(setAssociatedModels([]));
      dispatch(setAvailableModelsForPath({ path: currentPath, models: [] }));
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedFolder, isWebMode, electron, dispatch]);

  // Handle expand button click
  const handleModelsExpandClick = useCallback(() => {
    const newMinimizedState = !modelsMinimized;
    setModelsMinimized(newMinimizedState);
    
    // If expanding, refresh associated models
    if (newMinimizedState === false) {
      refreshAssociatedModels();
      fetchTaskNodes();
    }
  }, [modelsMinimized, refreshAssociatedModels, fetchTaskNodes]);

  // Handle model selection
  const handleModelClick = useCallback((modelName: string) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    
    // In web mode, empty string means root directory, so it's valid
    if (!isWebMode && !targetPath) {
      console.warn('No target path, returning');
      return;
    }
    
    // Toggle selection using the pre-fetched selected model
    const newSelection = selectedModelForCurrentPath === modelName ? null : modelName;
    dispatch(setSelectedModelForPath({ path: targetPath, modelName: newSelection }));
  }, [selectedFolder, currentPath, selectedModelForCurrentPath, dispatch, isWebMode]);

  // Handle apply all models
  const handleApplyAll = useCallback(async (modelName: string, taskNodeOverride?: string) => {
    if (!isClient || typeof window === 'undefined' || typeof fetch === 'undefined') {
      return;
    }

    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath) || isPublicReadOnlyPath(selectedFolder)) {
      toast.error(getRestrictedDirectoryMessage('apply classifier to all files'));
      return;
    }

    if (isBatchRunning) {
      toast.info('A batch is already running. Please wait for it to finish.');
      return;
    }

    if (!imageFiles || imageFiles.length === 0) {
      toast.info('No image files found in this folder.');
      return;
    }

    const modelFile = modelFiles.find(file => file.name === modelName);
    if (!modelFile) {
      toast.error('Model file not found', { description: modelName });
      return;
    }

    // Refresh task nodes list before resolving (same as import dialog does)
    // Fetch latest nodes directly to ensure we have the most up-to-date status
    let latestClassificationNodes: TaskNodeInfo[] = [];
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      if (resp.status === 200) {
        const data = resp.data;
        const nodes = (data?.data?.nodes ?? {}) as Record<string, any>;
        const allNodes: TaskNodeInfo[] = Object.entries(nodes).map(([name, info]) => ({
          name,
          running: !!info?.running,
          factory: info?.factory,
          port: typeof info?.port === 'number' ? info.port : undefined,
        }));
        // Filter to classification nodes only (same logic as classificationTaskNodes)
        latestClassificationNodes = allNodes.filter(n => n.factory === 'TissueClassify' || n.factory === 'NucleiClassify');
      }
    } catch (e) {
      // Fallback to current state if fetch fails
      latestClassificationNodes = classificationTaskNodes;
    }
    // Also update state for UI consistency
    await fetchTaskNodes();

    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }

    if (!isWebMode && !targetPath) {
      toast.info('Select a folder before applying the model.');
      return;
    }

    setIsBatchRunning(true);
    setApplyingModelName(modelName);
    batchIdRef.current += 1;
    const currentBatchId = batchIdRef.current;

    mergeFileTaskUpdates(
      imageFiles.reduce((acc, file) => {
        acc[file.path] = {
          status: 'queued',
          progress: 0,
          error: null,
          startedAt: undefined,
          completedAt: undefined,
        };
        return acc;
      }, {} as Record<string, Partial<FileTaskState>>),
    );

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const resolveTaskNodeName = (modelFile: FileItem, nodes: TaskNodeInfo[]): string | null => {
      const isXgb = false;
      const isTlcls = modelFile.name.toLowerCase().endsWith('.tlcls');
      const runningNodes = nodes.filter(n => n.running);
      const prefer = (pred: (n: TaskNodeInfo) => boolean) => runningNodes.find(pred) || nodes.find(pred);

      // Heuristics: map by extension or factory
      if (isTlcls) {
        const cls = prefer(n => /classification/i.test(n.name));
        if (cls) return cls.name;
      }
      // Fallback by factory category
      const tissueClassify = prefer(n => n.factory === 'TissueClassify');
      if (tissueClassify) return tissueClassify.name;
      // Last resort: any running classification node
      if (runningNodes.length > 0) return runningNodes[0].name;
      return nodes.length > 0 ? nodes[0].name : null;
    };

    const sendRequest = async (imageFile: FileItem) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const zarrPath = `${imageFile.path}.zarr`;
      const modelFile = modelFiles.find(file => file.name === modelName)!;
      const taskNode = taskNodeOverride || resolveTaskNodeName(modelFile, latestClassificationNodes);
      if (!taskNode) {
        return { success: false, error: 'No available TaskNode found. Please activate a classifier node.' } as const;
      }

      const payload = {
        zarr_path: zarrPath,
        step1: {
          model: taskNode,
          input: {
            prompt: '',
            path: imageFile.path,
            classifier_path: modelFile.path,
            save_classifier_path: null,
          },
        },
      };

      try {
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
          method: 'POST',
          body: JSON.stringify(payload),
          returnAxiosFormat: true,
        });

        if (response.status !== 200) {
          const errorText = response.data;
          throw new Error(`HTTP ${response.status}${errorText ? ` - ${errorText}` : ''}`);
        }

        const json = response.data;
        const code = json?.code;
        if (typeof code === 'number' && code !== 0) {
          const message = json?.message || 'Failed to start workflow';
          throw new Error(message);
        }
        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error, 'Start workflow request failed');
        console.error(`Failed to start workflow for ${imageFile.name}:`, error);
        return { success: false, error: message };
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    };

    try {
      for (let index = 0; index < imageFiles.length; index++) {
        if (batchIdRef.current !== currentBatchId) {
          break;
        }

        const imageFile = imageFiles[index];
        mergeFileTaskUpdates({
          [imageFile.path]: {
            status: 'running',
            progress: index === 0 ? 5 : 10,
            error: null,
            startedAt: Date.now(),
            completedAt: undefined,
          },
        });

        const requestResult = await sendRequest(imageFile);
        if (!requestResult.success) {
          mergeFileTaskUpdates({
            [imageFile.path]: {
              status: 'error',
              progress: 0,
              error: requestResult.error ?? 'Failed to start workflow',
              completedAt: Date.now(),
            },
          });
          toast.error(requestResult.error ?? 'Failed to start workflow');

          continue;
        }

        const trackingResult = await trackWorkflowToCompletion(imageFile.path, currentBatchId);
        if (!trackingResult.success) {
          const message = trackingResult.error || 'Workflow failed';
          mergeFileTaskUpdates({
            [imageFile.path]: {
              status: 'error',
              error: message,
              completedAt: Date.now(),
            },
          });
          toast.error(message);
        } else {
          mergeFileTaskUpdates({
            [imageFile.path]: {
              status: 'completed',
              progress: 100,
              error: null,
              completedAt: Date.now(),
            },
          });
          // If this file is currently open, trigger a viewer refresh to show updated annotations
          try {
            if (currentPath && (currentPath === imageFile.path || `${currentPath}.zarr` === `${imageFile.path}.zarr`)) {
              const zarrPath = `${imageFile.path}.zarr`;
              EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
            }
          } catch {}
        }

        if (batchIdRef.current !== currentBatchId) {
          break;
        }

      }

      if (batchIdRef.current === currentBatchId) {
        const completedAll = imageFiles.every(file => fileTaskStatesRef.current[file.path]?.status === 'completed');
        const failedAny = imageFiles.some(file => fileTaskStatesRef.current[file.path]?.status === 'error');

        if (completedAll) {
          const folderLabel = targetPath || (isWebMode ? 'root directory' : 'current folder');
          toast.success('Classifier applied to all images', {
            description: `${imageFiles.length} file${imageFiles.length === 1 ? '' : 's'} processed in ${folderLabel}.`,
          });
        } else if (failedAny) {
          toast.info('Batch processing finished with some errors.');
        } else {
          toast.success('Batch processing finished.');
        }
      }
    } catch (error) {
      const message = getErrorMessage(error, 'Unexpected error during batch processing.');
      console.error('Error in sequential processing:', error);
      toast.error(message);
    } finally {
      if (batchIdRef.current === currentBatchId) {
        setIsBatchRunning(false);
        setApplyingModelName(null);
        cleanupEventSource();
      }
    }
  }, [
    isClient,
    isBatchRunning,
    imageFiles,
    modelFiles,
    selectedFolder,
    currentPath,
    isWebMode,
    mergeFileTaskUpdates,
    trackWorkflowToCompletion,
    cleanupEventSource,
    availableTaskNodes,
    classificationTaskNodes,
    fetchTaskNodes,
  ]);

  const handleConfirmRun = useCallback(async () => {
    if (!nodeDialogModel) {
      setNodeDialogError('No model selected.');
      return;
    }
    if (!selectedTaskNodeName) {
      setNodeDialogError('Please select a TaskNode.');
      return;
    }
    setNodeDialogOpen(false);
    await handleApplyAll(nodeDialogModel, selectedTaskNodeName);
  }, [nodeDialogModel, selectedTaskNodeName, handleApplyAll]);

  // Create empty classifier file function
  const createEmptyClassifierFile = useCallback(async (filePath: string) => {
    try {
      const emptyClassifier = {
        version: "1.0",
        created_at: new Date().toISOString(),
        model_type: "classification",
        status: "empty",
        description: "Empty classifier file - needs training",
        classes: [],
        metadata: {
          created_by: "TissueLab",
          requires_training: true
        }
      };
      
      if (isWebMode) {
        // For web mode, we'll create a file using the existing upload API
        try {
          // Create a Blob with the classifier data
          const classifierContent = JSON.stringify(emptyClassifier, null, 2);
          const blob = new Blob([classifierContent], { type: 'application/json' });
          
          // Create a File object
          const fileName = filePath.split('/').pop() || 'classifier.tlcls';
          const file = new File([blob], fileName, { type: 'application/json' });
          
          // Use the existing uploadFiles function
          const { uploadFiles } = await import('@/utils/dashboard/fileManager.service');
          const dt = new DataTransfer();
          dt.items.add(file);
          const files = dt.files;
          
          // Get the directory path (remove filename from filePath)
          const directoryPath = filePath.substring(0, filePath.lastIndexOf('/'));
          
          await uploadFiles(directoryPath, files, () => {}, false);
          
        } catch (apiError) {
          console.warn('File creation failed, falling back to simulation:', apiError);
          // Fallback to simulation if API fails
          console.log(`[AssociatedModelsSection] Would create empty classifier file at: ${filePath}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        // For electron mode, use electron API
        const isElectron = typeof window !== 'undefined' && (window as any).electron;
        if (isElectron) {
          try {
            await (window as any).electron.invoke('write-file', {
              filePath: filePath,
              content: JSON.stringify(emptyClassifier, null, 2)
            });
          } catch (electronError) {
            console.warn('Electron file creation failed, falling back to simulation:', electronError);
            // Fallback to simulation if electron fails
            console.log(`[AssociatedModelsSection] Would create empty classifier file at: ${filePath}`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          // Fallback: simulate file creation
          console.log(`[AssociatedModelsSection] Would create empty classifier file at: ${filePath}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      return Promise.resolve();
    } catch (error) {
      console.error('[AssociatedModelsSection] Error creating empty classifier file:', error);
      throw error;
    }
  }, [isWebMode]);

  // Handle create new classifier
  const handleCreateNewClassifier = useCallback(async () => {
    if (!newClassifierName.trim()) {
      toast.error('Please enter a classifier name');
      return;
    }

    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath) || isPublicReadOnlyPath(selectedFolder)) {
      toast.error(getRestrictedDirectoryMessage('create new classifier'));
      return;
    }
    
    setIsCreating(true);
    
    try {
      const fileName = newClassifierName.endsWith('.tlcls') ? newClassifierName : `${newClassifierName}.tlcls`;
      let fullPath = '';
      if (isWebMode) {
        fullPath = `${selectedFolder || ''}/${fileName}`.replace(/\/+/g, '/');
      } else if (electron && typeof electron.invoke === 'function') {
        try {
          fullPath = await electron.invoke('path-join', selectedFolder || '', fileName);
        } catch (e) {
          const sep = (selectedFolder || '').includes('\\') ? '\\' : '/';
          fullPath = `${selectedFolder || ''}${sep}${fileName}`;
        }
      } else {
        const sep = (selectedFolder || '').includes('\\') ? '\\' : '/';
        fullPath = `${selectedFolder || ''}${sep}${fileName}`;
      }
      
      // Create empty classifier file
      await createEmptyClassifierFile(fullPath);
      
      // Refresh the model list
      await refreshAssociatedModels();
      
      // Select the newly created classifier
      dispatch(setSelectedModelForPath({ path: selectedFolder, modelName: fileName }));
      
      setShowCreateDialog(false);
      setNewClassifierName('');
      
      toast.success('New classifier created', {
        description: `Created ${fileName} in current folder`,
      });
      
    } catch (error) {
      console.error('Failed to create classifier:', error);
      toast.error(getErrorMessage(error, 'Failed to create classifier'));
    } finally {
      setIsCreating(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newClassifierName, selectedFolder, isWebMode, createEmptyClassifierFile, refreshAssociatedModels, dispatch]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      cleanupEventSource();
    };
  }, [cleanupEventSource]);

  return (
    <>
    <div className="border-t border-border bg-card">
      <div className="flex items-center justify-between p-2 border-b border-border h-12">
        <span className="text-xs font-medium text-foreground">Associated models under this folder</span>
        <div className="flex items-center gap-2">
          <button 
            onClick={refreshAssociatedModels}
            disabled={isRefreshing}
            className="flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-200 disabled:opacity-50"
            title="Refresh classifiers"
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="ml-1">Refresh</span>
          </button>
          <button 
            onClick={() => setShowCreateDialog(true)}
            className="flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-200"
            title="Create new classifier"
          >
            <Plus className="h-3 w-3" />
            <span className="ml-1">New</span>
          </button>
          <button 
            onClick={handleModelsExpandClick}
            className="flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors duration-200"
          >
            <div className="transition-transform duration-300 ease-in-out">
              {modelsMinimized ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </div>
            <span className="ml-1">{modelsMinimized ? 'Expand' : 'Minimize'}</span>
          </button>
        </div>
      </div>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
        modelsMinimized ? 'max-h-0 opacity-0' : 'max-h-[220px] opacity-100'
      }`}>
        <ScrollArea className="h-[180px]">
          {/* Queue Status Summary */}
          {queueStats.total > 0 && (queueStats.queued > 0 || queueStats.running > 0 || queueStats.completed > 0 || queueStats.error > 0) && (
            <div className="p-2 bg-muted border-b border-border">
              <div className="text-xs text-muted-foreground mb-1">Processing Status</div>
              <div className="flex items-center gap-3 text-[10px]">
                {queueStats.queued > 0 && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-warning"></div>
                    <span className="text-warning">{queueStats.queued} Queued</span>
                  </div>
                )}
                {queueStats.running > 0 && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
                    <span className="text-primary">{queueStats.running} Running</span>
                  </div>
                )}
                {queueStats.completed > 0 && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-success"></div>
                    <span className="text-success">{queueStats.completed} Completed</span>
                  </div>
                )}
                {queueStats.error > 0 && (
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-destructive"></div>
                    <span className="text-destructive">{queueStats.error} Failed</span>
                  </div>
                )}
              </div>
            </div>
          )}
          
          {associatedModels.length > 0 ? (
            <>
              {/* Model Rows */}
              <div>
                {associatedModels.map((model, index) => {
                  const isSelected = selectedModelForCurrentPath === model;
                  return (
                    <div 
                      key={index} 
                      className={`relative p-3 border-b border-border transition-colors duration-200 cursor-pointer ${
                        isSelected
                          ? 'bg-primary/10'
                          : 'hover:bg-accent/40'
                      }`}
                      onClick={() => {
                        handleModelClick(model);
                      }}
                    >
                      {isSelected && (
                        <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
                      )}
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <div className="text-xs font-medium text-foreground hover:text-foreground/80 hover:underline truncate leading-tight">
                              {truncateFileName(model, 35)}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {getModelTypeDescription(model)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isSelected && (
                              <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0"></span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openNodeDialog(model);
                              }}
                              disabled={isBatchRunning}
                              className={`px-2 py-1 text-xs rounded transition-colors duration-200 flex-shrink-0 ${
                                isBatchRunning ? 'bg-primary/40 text-primary-foreground/80 cursor-not-allowed' : 'bg-primary text-primary-foreground hover:bg-primary/90'
                              }`}
                              title={`Apply All ${model}`}
                            >
                              {isBatchRunning
                                ? (applyingModelName === model ? 'Applying...' : 'Waiting...')
                                : 'Apply All'}
                            </button>
                          </div>
                        </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full p-3">
              <div className="text-center">
                <div className="text-xs text-muted-foreground mb-1">No associated models found</div>
                <div className="text-xs text-muted-foreground/80">Models will appear here when available</div>
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
    <Dialog modal={true} open={nodeDialogOpen} onOpenChange={setNodeDialogOpen}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Select TaskNode</DialogTitle>
        </DialogHeader>
        <div className="mt-2 text-xs text-muted-foreground">
          Choose a TaskNode service to execute the selected classifier model for all images in this folder.
        </div>
        <div className="mt-3">
          <div className="text-xs text-muted-foreground mb-1">Available TaskNodes</div>
          <Select value={selectedTaskNodeName ?? undefined} onValueChange={setSelectedTaskNodeName}>
            <SelectTrigger className="h-8">
              <SelectValue placeholder={classificationTaskNodes.length === 0 ? 'No classification nodes available' : 'Select a TaskNode'} />
            </SelectTrigger>
            <SelectContent>
              {classificationTaskNodes.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">No classification TaskNodes found. Activate a TissueClassify or NucleiClassify node in Agent Zoo.</div>
              ) : (
                classificationTaskNodes.map(n => (
                  <SelectItem key={n.name} value={n.name}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{n.name}</span>
                      <span className={`text-[10px] ${n.running ? 'text-success' : 'text-muted-foreground'}`}>{n.running ? 'Running' : 'Stopped'}</span>
                    </div>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {nodeDialogError && (
            <div className="mt-2 text-xs text-destructive">{nodeDialogError}</div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setNodeDialogOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={handleConfirmRun} disabled={!selectedTaskNodeName}>Run</Button>
        </div>
      </DialogContent>
    </Dialog>
    
    {/* Create New Classifier Dialog */}
    <Dialog modal={true} open={showCreateDialog} onOpenChange={setShowCreateDialog}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Create New Classifier</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Classifier Name</div>
            <Input
              value={newClassifierName}
              onChange={(e) => setNewClassifierName(e.target.value)}
              placeholder="Enter classifier name (e.g., my_classifier)"
              className="h-8"
              disabled={isCreating}
            />
          </div>
          <div className="text-xs text-muted-foreground/80">
            File will be saved as: {newClassifierName ? (newClassifierName.endsWith('.tlcls') ? newClassifierName : `${newClassifierName}.tlcls`) : 'name.tlcls'}
          </div>
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => {
              setShowCreateDialog(false);
              setNewClassifierName('');
            }}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button 
            size="sm" 
            onClick={handleCreateNewClassifier}
            disabled={!newClassifierName.trim() || isCreating}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
};

export default AssociatedModelsSection;
