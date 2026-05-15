import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, } from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { ImportModelDialog } from "@/components/imageViewer/RightSidebar/Agent/ImportModelDialog"
import { SortablePanel } from "@/components/imageViewer/RightSidebar/Agent/Workflow/Card/SortablePanel"
import { WorkflowConfigSection } from "@/components/imageViewer/RightSidebar/Agent/Workflow/WorkflowConfigSection"
import { WorkflowHistoryActionsMenu } from "@/components/imageViewer/RightSidebar/Agent/Workflow/WorkflowHistoryActionsMenu"
import { WorkflowStatusSummary } from "@/components/imageViewer/RightSidebar/Agent/Workflow/WorkflowStatusSummary"
import { Button } from "@/components/ui/button"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { AppDispatch, RootState, store } from "@/store"
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from "@/utils/common/apiResponse"
import { hydrateCodingAgentPanelsIfEmpty } from "@/utils/workflow/persistCodingAgentScript"
import { useDispatch, useSelector } from "react-redux"

import NodeLogsDialog from '@/components/imageViewer/AgentZoo/NodeLogsDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { addMessage, setIsGenerating } from "@/store/slices/chat/chatSlice"
import {
  addPanel,
  deletePanel,
  initPanelsFromWorkflow,
  removeExecutionFromWorkflowIdMap,
  reorderPanels,
  resetWorkflowStatus,
  setHasCheckedInitialRestore,
  setIsRunning,
  setNodeLogsMeta,
  setNodeProgress,
  setWorkflowStageProgress,
  setOutputPath,
  setPanels,
  setQueueStatus,
  setNodePorts as setReduxNodePorts,
  setNodeStatus as setReduxNodeStatus,
  setRunningExecutionId,
  setRunningWorkflowZarrPath,
  setWorkflowStatus,
  updateExecutionToWorkflowIdMap,
  updatePanel,
  WorkflowPanel,
  setWorkflowCompletionHints,
} from "@/store/slices/chat/workflowSlice"
import { selectPatchClassificationData } from "@/store/slices/viewer/annotationSlice"
import { useWorkflowHistory } from "@/store/zustand/store"
import { getAuthToken } from "@/utils/common/authToken"
import EventBus from "@/utils/EventBus"
import { formatPath } from "@/utils/pathUtils"
import { getRestrictedDirectoryMessage, isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils"
import { buildStartWorkflowPayload } from "@/utils/workflow/buildStartWorkflowPayload"
import { registerWorkflowSseContainer } from "@/utils/workflow/workflowSseCoordinator"
import { runWorkflowCompletionShared } from "@/utils/workflow/workflowCompletionSideEffects"
import { ArrowBigDown, Loader2, Play, Save, Workflow } from "lucide-react"
import { toast } from "sonner"
import { ImportModelCard } from "./Workflow/Card/ImportModelCard"
import { ModelTreeCard, ModelTreeNode } from "./Workflow/Card/ModelTreeCard"
import { CHILD_TO_PARENT, MODEL_DEPENDENCIES, panelMap } from "./Workflow/constants"

export const WorkflowContainer = () => {
  const dispatch = useDispatch<AppDispatch>();

  useLayoutEffect(() => {
    return registerWorkflowSseContainer();
  }, []);

  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  // Get workflow state from Redux
  const panels = useSelector((state: RootState) => state.workflow.panels);
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);
  const nodePorts = useSelector((state: RootState) => state.workflow.nodePorts);
  const nodeProgress = useSelector((state: RootState) => state.workflow.nodeProgress);
  const nodeLogsMeta = useSelector((state: RootState) => state.workflow.nodeLogsMeta);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const workflowStatus = useSelector((state: RootState) => state.workflow.workflowStatus);
  const queuePosition = useSelector((state: RootState) => state.workflow.queuePosition);
  const queueTotal = useSelector((state: RootState) => state.workflow.queueTotal);
  const runningExecutionId = useSelector((state: RootState) => state.workflow.runningExecutionId);
  const runningWorkflowZarrPath = useSelector((state: RootState) => state.workflow.runningWorkflowZarrPath);
  const hasCheckedInitialRestore = useSelector((state: RootState) => state.workflow.hasCheckedInitialRestore);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);

  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

  const getDefaultOutputPath = (path: string) => {
    if (!path) return "";
    return path + '.zarr';
  };

  const rectangleCoords = useSelector(
      (state: RootState) => state.shape.shapeData?.rectangleCoords
  );

  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions);

  

  const [output_path, setOutput] = useState(getDefaultOutputPath(formattedPath ?? ""));
  const [x1, setX1] = useState("");
  const [y1, setY1] = useState("");
  const [x2, setX2] = useState("");
  const [y2, setY2] = useState("");

  // Track if user manually edited the output path to avoid overwriting their input on file switch
  const [didUserEditOutputPath, setDidUserEditOutputPath] = useState(false);
  const prevDefaultOutputPathRef = useRef<string>(getDefaultOutputPath(formattedPath ?? ""));

  // Node metadata (displayName etc.) for child panel titles when adding from "Import child" button
  const [nodesMeta, setNodesMeta] = useState<Record<string, { displayName?: string }>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, { method: 'GET', returnAxiosFormat: true });
        const nodes = res?.data?.nodes ?? {};
        if (!cancelled) setNodesMeta(nodes);
      } catch {
        if (!cancelled) setNodesMeta({});
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Unified coordinate handling: prioritize rectangleCoords, fallback to full image dimensions
  // This ensures that when user deletes a region, coordinates revert to full image coordinates
  useEffect(() => {
    if (rectangleCoords) {
      // User has selected a region, use rectangleCoords
      setX1(rectangleCoords.x1.toString());
      setY1(rectangleCoords.y1.toString());
      setX2(rectangleCoords.x2.toString());
      setY2(rectangleCoords.y2.toString());
    } else if (slideDimensions && slideDimensions.length === 2) {
      // No region selected, use default full image coordinates
      // dimensions are [width, height]
      setX1("0");
      setY1("0");
      setX2(slideDimensions[0].toString());
      setY2(slideDimensions[1].toString());
    } else {
      // No dimensions available yet, clear coordinates
      setX1("");
      setY1("");
      setX2("");
      setY2("");
    }
  }, [rectangleCoords, slideDimensions]);


  // Use ref to track if we're already updating to prevent infinite loops
  const isUpdatingPanelsRef = useRef(false);
  const panelsRef = useRef(panels);
  
  // Update panels ref whenever panels change
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);
  
  useEffect(() => {
    // When the selected file changes, update the default output path
    // Only update if the user hasn't customized it or it still equals the previous default
    const newDefault = getDefaultOutputPath(formattedPath ?? "");
    const prevDefault = prevDefaultOutputPathRef.current;
    const shouldUpdate = !didUserEditOutputPath || output_path === prevDefault || !output_path;
    if (shouldUpdate && newDefault !== output_path) {
      setOutput(newDefault);
    }
    prevDefaultOutputPathRef.current = newDefault;
    
    // Update Redux store with the output path
    dispatch(setOutputPath(output_path));
  }, [formattedPath, didUserEditOutputPath, output_path, dispatch]);

  useEffect(() => {
    // Prevent infinite loops by checking if we're already updating
    if (isUpdatingPanelsRef.current || panelsRef.current.length === 0) {
      return;
    }
    
    let needsUpdate = false;
    const updatedPanels = panelsRef.current.map(panel => {
      // Create a copy of the panel object
      const updatedPanel = { ...panel };
      let contentModified = false;
      
      // Check if path needs to be added
      const hasPath = panel.content.some(item => item.key === 'path');
      const expectedPathValue = currentPath ?? "";
      if (!hasPath && panel.type !== 'GPT-4o Agent' && panel.title !== panelMap.NucleiClassify.title) {
        // Create a new content array with the additional item
        updatedPanel.content = [
          ...panel.content,
          { key: 'path', type: 'input', value: expectedPathValue }
        ];
        contentModified = true;
      } else if (hasPath) {
        // Check if path value needs to be updated
        const pathItem = panel.content.find(item => item.key === 'path');
        if (pathItem && pathItem.value !== expectedPathValue) {
          updatedPanel.content = panel.content.map(item => 
            item.key === 'path' 
              ? { ...item, value: expectedPathValue }
              : item
          );
          contentModified = true;
        }
      }

      // if (!panel.content.some(item => item.key === 'rate')) {
      //   const needsRate =
      //     (panel.title === panelMap.TissueSeg.title || panel.title === panelMap.TissueClassify.title) &&
      //     panel.type !== 'ClassificationNode'
      //   if (needsRate) {
      //     const rateItem = { key: 'rate', type: 'input', value: '16' }
      //     updatedPanel.content = contentModified
      //       ? [...updatedPanel.content, rateItem]
      //       : [...panel.content, rateItem]
      //     contentModified = true
      //   }
      // }
      
      if (contentModified) {
        needsUpdate = true;
      }
      
      // Only return the updated panel if we made changes
      return contentModified ? updatedPanel : panel;
    });
    
    // Only dispatch if there are actual changes
    if (needsUpdate) {
      isUpdatingPanelsRef.current = true;
      dispatch(setPanels(updatedPanels));
      // Reset the flag after the update is complete
      setTimeout(() => {
        isUpdatingPanelsRef.current = false;
      }, 0);
    }
    // Panel data is now persisted to model_registry via backend API
  }, [currentPath, dispatch]); // Now we can safely include panels in dependencies

  const sensors = useSensors(
      useSensor(PointerSensor),
      useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;

    if (active.id !== over.id) {
      const oldIndex = panels.findIndex((item) => item.id === active.id);
      const newIndex = panels.findIndex((item) => item.id === over.id);
      
      dispatch(reorderPanels({ oldIndex, newIndex }));
    };
  };

  const handleContentChange = (id: string, updatedPanel: WorkflowPanel) => {
    dispatch(updatePanel({ id, updatedPanel }));
    // Panel data is now persisted to model_registry via backend API
  };

  const handleDeleteModel = (id: string) => {
    dispatch(deletePanel(id));
  };

  const handleImportChild = (parentIndex: number, dep: typeof MODEL_DEPENDENCIES[string]) => {
    const panelConfig = panelMap[dep.childPanelKey];
    if (!panelConfig) return;
    const newPanels = [...panels];
    const content = dep.defaultContent
      ? dep.defaultContent.map(item => ({ ...item }))
      : panelConfig.defaultContent.map(item => ({ ...item }));
    const displayNameFromRegistry = nodesMeta[dep.childType]?.displayName;
    const panelTitle = displayNameFromRegistry ?? panelConfig.title;
    console.log('[handleImportChild]', {
      childType: dep.childType,
      childPanelKey: dep.childPanelKey,
      panelMapTitle: panelConfig.title,
      nodesMetaDisplayName: displayNameFromRegistry,
      finalPanelTitle: panelTitle,
    });
    const newPanel: WorkflowPanel = {
      id: 'temp',
      title: panelTitle,
      type: dep.childType,
      progress: 0,
      content,
      ui: null,
    };
    newPanels.splice(parentIndex + 1, 0, newPanel);
    dispatch(setPanels(newPanels.map((p, i) => ({ ...p, id: (i + 1).toString() }))));
  };

  const addHistoryEntry = useWorkflowHistory((s) => s.addEntry);
  const updateHistoryEntry = useWorkflowHistory((s) => s.updateEntry);
  const selectedHistoryId = useWorkflowHistory((s) => s.selectedHistoryId);
  const historyEntries = useWorkflowHistory((s) => s.entries);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Handle save workflow
  const handleSaveWorkflow = useCallback(() => {
    if (!saveName.trim() || panels.length === 0) {
      toast.error('Please enter a workflow name');
      return;
    }

    if (selectedHistoryId) {
      // Save as new entry (duplicate)
      addHistoryEntry(saveName.trim(), panels, output_path, currentPath ?? '');
      toast.success('Workflow saved as new entry');
    } else {
      // Save as new entry
      addHistoryEntry(saveName.trim(), panels, output_path, currentPath ?? '');
      toast.success('Workflow saved');
    }

    setSaveDialogOpen(false);
    setSaveName('');
  }, [saveName, panels, output_path, selectedHistoryId, addHistoryEntry]);

  // Get execution to workflow ID mapping from Redux
  const executionToWorkflowIdMap = useSelector((state: RootState) => state.workflow.executionToWorkflowIdMap);
  const executionToWorkflowIdMapRef = useRef<Record<string, string | null>>({});
  const runningExecutionIdRef = useRef<string | null>(null);
  const selectedHistoryIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    executionToWorkflowIdMapRef.current = executionToWorkflowIdMap;
  }, [executionToWorkflowIdMap]);
  
  useEffect(() => {
    runningExecutionIdRef.current = runningExecutionId;
  }, [runningExecutionId]);

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId;
  }, [selectedHistoryId]);

  // Get current workflow identifier (selectedHistoryId or null for current panels)
  const currentWorkflowId = selectedHistoryId;

  // Check if current workflow is the one that's running
  const isCurrentWorkflowRunning = useMemo(() => {
    if (!runningExecutionId) {
      // Backward compatibility: if no execution_id is set but workflow is running, consider it current
      return isRunning;
    }
    const workflowId = executionToWorkflowIdMap[runningExecutionId];
    return workflowId === currentWorkflowId;
  }, [runningExecutionId, executionToWorkflowIdMap, currentWorkflowId, isRunning]);


  const [isSubmitted, setIsSubmitted] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [selectedLogTarget, setSelectedLogTarget] = useState<{ node: string; logPath?: string; envName?: string; port?: number } | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const hasInitTrackingRef = useRef<boolean>(false);
  const hasRestoredWorkflowRef = useRef<boolean>(false);
  /** True after the initial restore (current_workflow_status) has finished; avoids showing empty UI while loading */
  const [isInitialRestoreDone, setIsInitialRestoreDone] = useState(hasCheckedInitialRestore);

  // Poll gateway paused flag (skip in Electron environment and local development)

  
  // Modify the checkWorkflowCompletion function to return whether all nodes are complete
  const checkWorkflowCompletion = useCallback((statusData: Record<string, number>) => {
    if (panels.length === 0 || Object.keys(statusData).length === 0) {
      return false;
    }
    const expectedNodes = panels.map((panel) => panel.type);
    return expectedNodes.every((nodeType) => {
      if (!nodeType) return false;
      const status = statusData[nodeType];
      // Missing key must not count as finished (avoids false positives vs graph/SSE key names).
      if (status === undefined) return false;
      return status === 2 || status === -1;
    });
  }, [panels]);

  // Function to establish SSE connection and listen for node status updates
  const setupNodeStatusTracking = useCallback(async () => {
    // Close any existing connection and ensure it's fully closed
    if (eventSourceRef.current) {
      try {
        eventSourceRef.current.close();
      } catch (e) {
        // Ignore errors when closing (connection may already be closed)
      }
      eventSourceRef.current = null; // Clear ref to ensure old connection is fully removed
    }

    // Local-only build: backend resolves uid from /v1/get_status server-side
    // (no token verification). Always open the EventSource — passing the
    // Firebase token when available is purely informational.
    let eventSource: EventSource;
    try {
      const authToken = await getAuthToken().catch(() => null);
      const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
      eventSource = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_status${qs}`);
    } catch (error) {
      console.error('Failed to open SSE for workflow status:', error);
      throw new Error('Failed to open workflow status stream');
    }
    eventSourceRef.current = eventSource;
    
    // Flag to track if we've detected workflow completion
    let workflowCompleteDetected = false;

    // Set up event listeners
    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Only process SSE updates if current workflow is the one running
        // Check by comparing current workflow identifier with the running execution's identifier
        // This ensures isolation between different workflow instances
        // Use refs to access latest state without adding to dependency array
        // Always read from the Redux store: refs lag one frame and can leave a stale execution_id
        // mapped to a history workflowId while the user runs the graph (null) — then every SSE frame is dropped.
        const wfSnap = store.getState().workflow;
        const currentRunningExecutionId = wfSnap.runningExecutionId;
        const currentMap = wfSnap.executionToWorkflowIdMap;
        const currentWorkflowId = selectedHistoryIdRef.current;

        if (currentRunningExecutionId) {
          const runningWorkflowId = currentMap[currentRunningExecutionId];
          // null = untagged run (default panels or Workflow Graph). Those must not be dropped just
          // because a history entry is selected in the Workflow tab UI.
          if (runningWorkflowId != null && runningWorkflowId !== currentWorkflowId) {
            console.log('[WorkflowContainer] Ignoring SSE update - current workflow does not match running execution');
            return;
          }
        }
        if (data.node_progress) {
          // Some SSE frames only include node_progress without node_status.
          // Apply progress immediately so Graph/Workflow UI keeps updating in real time.
          dispatch(setNodeProgress(data.node_progress));
        }
        if (data.stage_progress && typeof data.stage_progress === "object") {
          dispatch(setWorkflowStageProgress(data.stage_progress as Record<string, Record<string, number>>));
        }
        if (data.node_status) {
          const previousStatus = { ...store.getState().workflow.nodeStatus };

          dispatch(setReduxNodeStatus(data.node_status));
          
          // Emit event when node status changes to completed/failed (execute endpoint finished)
          // This is used to notify cancellation operations that execute has completed
          Object.keys(data.node_status).forEach(nodeType => {
            const status = data.node_status[nodeType];
            const previousNodeStatus = previousStatus[nodeType];
            
            // Only emit if status changed to completed/failed (not if it was already completed)
            // Also emit if status is cancelled (-2) to handle cancellation completion
            if ((status === 2 || status === -1 || status === -2) && previousNodeStatus !== status) {
              console.log('[WorkflowContainer] Emitting node-execute-completed for node:', nodeType, 'status:', status, 'previous:', previousNodeStatus);
              EventBus.emit('node-execute-completed', { nodeType, nodeStatus: data.node_status });
            }
          });
          
          // Handle queue status
          if (data.node_status._workflow_status === 'queued') {
            dispatch(setWorkflowStatus('queued'));
            if (data.node_status._queue_position !== undefined && data.node_status._queue_total !== undefined) {
              dispatch(setQueueStatus({
                position: data.node_status._queue_position,
                total: data.node_status._queue_total
              }));
            }
          } else if (data.node_status._workflow_status === 'running') {
            dispatch(setWorkflowStatus('running'));
          } else if (data.node_status._workflow_status === 'completed') {
            // When backend says completed, check if all nodes are actually complete
            // If so, set to 'idle' instead of 'completed' (will be handled by useEffect or workflow_complete check)
            if (panels.length > 0 && Object.keys(data.node_status).length > 0) {
              const expectedNodes = panels.map(panel => panel.type);
              const allFinished = expectedNodes.every(nodeType => {
                const status = data.node_status[nodeType];
                return status === 2 || status === -1;
              });
              if (allFinished) {
                // All nodes are finished, will be handled by workflow_complete check or useEffect
                // Don't set to 'completed' here, let the completion logic handle it
              } else {
                dispatch(setWorkflowStatus('completed'));
              }
            } else {
              dispatch(setWorkflowStatus('completed'));
            }
          } else if (data.node_status._workflow_status === 'error') {
            dispatch(setWorkflowStatus('error'));
          }
          
          if (data.workflow_complete === true) {
            workflowCompleteDetected = true;
            // Close SSE before awaiting completion: otherwise further frames can re-dispatch node_status
            // while Redux updates run and worsen re-entrancy (incl. max update depth with dnd-kit / Radix refs).
            if (eventSourceRef.current) {
              eventSourceRef.current.close();
              eventSourceRef.current = null;
            }
            await runWorkflowCompletionShared(dispatch, store.getState);
            return;
          }

          const allNodesComplete = checkWorkflowCompletion(data.node_status);

          if (allNodesComplete) {
            workflowCompleteDetected = true;
            if (eventSourceRef.current) {
              eventSourceRef.current.close();
              eventSourceRef.current = null;
            }
            await runWorkflowCompletionShared(dispatch, store.getState);
          }
        }
      } catch (error) {
      }
    };

    eventSource.onerror = (error) => {
      // If workflow completion was detected, this is an expected connection close
      if (workflowCompleteDetected) {
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        return;
      }
      
      const snap = store.getState().workflow.nodeStatus;
      const allNodesFinished =
        Object.keys(snap).length > 0 &&
        Object.values(snap).every((status) => status === 2 || status === -1);
      
      if (allNodesFinished) {
        // Connection closed after nodes finished but without a `workflow_complete` frame — same
        // completion as runWorkflowCompletionShared (incl. workflow-graph-run-finished for overlay restore).
        workflowCompleteDetected = true;
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        void runWorkflowCompletionShared(dispatch, store.getState);
      } else {
        // This is an unexpected error during active workflow
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (eventSourceRef.current === eventSource) {
            setupNodeStatusTracking();
          }
        }, 5000);
      }
    };

    
  }, [dispatch, output_path, eventSourceRef, checkWorkflowCompletion]);
  
  // Clean up SSE connection when component unmounts
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // Function to close SSE connection and return a promise that resolves when closed
  const closeSSEConnection = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      if (eventSourceRef.current) {
        try {
          eventSourceRef.current.close();
        } catch (e) {
          // Ignore errors when closing
        }
        eventSourceRef.current = null;
      }
      hasInitTrackingRef.current = false;
      setTimeout(resolve, 100);
    });
  }, []);


  // Listen for close SSE connection events (e.g., from ClassificationPanelContent)
  useEffect(() => {
    const handleCloseSSE = () => {
      closeSSEConnection();
    };

    EventBus.on('close-sse-connection', handleCloseSSE);
    
    return () => {
      EventBus.off('close-sse-connection', handleCloseSSE);
    };
  }, [closeSSEConnection]);

  // Function to fetch node port information
  const fetchNodePorts = useCallback(async () => {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      if (response.status !== 200) {
        throw new Error(`Failed to fetch node ports: ${response.status}`);
      }
      
      const responseData = response.data as Record<string, any>;
      
      if (responseData?.nodes) {
        // Extract and store just the port and running status
        const portInfo: Record<string, { port: number, running: boolean }> = {};
        const logsMeta: Record<string, { logPath?: string; envName?: string; port?: number }> = {};
        
        Object.entries(responseData.nodes).forEach(([nodeName, info]: [string, any]) => {
          portInfo[nodeName] = {
            port: info.port,
            running: info.running || false
          };
          logsMeta[nodeName] = {
            port: info.port,
            envName: info.env_name,
            logPath: info.log_path
          };
        });
        
        dispatch(setReduxNodePorts(portInfo));
        dispatch(setNodeLogsMeta(logsMeta));
      }
    } catch (error) {
    }
  }, [dispatch]);

  // Fetch node ports info on mount so we can enable/disable Run button appropriately
  useEffect(() => {
    fetchNodePorts();
  }, [fetchNodePorts]);

  // Restore running/queued workflow state once on mount (e.g. after refresh); replace panels so they align and progress bar works
  useEffect(() => {
    if (hasCheckedInitialRestore) {
      setIsInitialRestoreDone(true);
      return;
    }
    if (hasRestoredWorkflowRef.current) return;
    hasRestoredWorkflowRef.current = true;
    let cancelled = false;
    let restoreRequestSucceeded = false;
    const restoreWorkflowState = async () => {
      try {
        const res = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/current_workflow_status`, {
          method: 'GET',
        }) as { code?: number; data?: { active?: boolean; execution_id?: string; status?: string; steps?: { model: string }[]; zarr_path?: string; node_status?: Record<string, number>; node_progress?: Record<string, number>; queue_position?: number; queue_total?: number } };
        restoreRequestSucceeded = true;
        const snapshot = res?.data;
        if (cancelled || !snapshot?.active || !snapshot.execution_id) return;

        // Restore workflow details (panels) so UI aligns and progress bar shows correctly
        if (snapshot.steps?.length) {
          const modelToPanelKey = (model: string) => {
            if (panelMap[model]) return model;
            const entry = Object.entries(panelMap).find(([, c]) => c.defaultType === model);
            return entry ? entry[0] : model;
          };
          const workflow = snapshot.steps.map((s, i) => ({
            step: i + 1,
            model: modelToPanelKey(s.model),
            input: (s as { input?: string }).input ?? '',
          }));
          const formattedPathForRestore = snapshot.zarr_path ? formatPath(snapshot.zarr_path) : formattedPath;
          dispatch(initPanelsFromWorkflow({ workflow, formattedPath: formattedPathForRestore }));
          hydrateCodingAgentPanelsIfEmpty(dispatch, store.getState().workflow.panels, formattedPathForRestore);
        }

        dispatch(setRunningExecutionId(snapshot.execution_id));
        dispatch(setRunningWorkflowZarrPath(snapshot.zarr_path ?? null));
        dispatch(updateExecutionToWorkflowIdMap({ executionId: snapshot.execution_id, workflowId: null }));
        dispatch(setWorkflowStatus((snapshot.status === 'queued' || snapshot.status === 'running') ? snapshot.status : 'idle'));
        if (snapshot.node_status) dispatch(setReduxNodeStatus(snapshot.node_status));
        if (snapshot.node_progress) dispatch(setNodeProgress(snapshot.node_progress));
        if (snapshot.queue_position !== undefined && snapshot.queue_total !== undefined) {
          dispatch(setQueueStatus({ position: snapshot.queue_position, total: snapshot.queue_total }));
        }
        dispatch(setIsRunning(true));
        hasInitTrackingRef.current = false;
        setupNodeStatusTracking();
        hasInitTrackingRef.current = true;
      } catch (_) {
        // No auth or API error: leave state as-is
      }
    };
    restoreWorkflowState().finally(() => {
      if (!cancelled) {
        // Only mark the global "checked" flag after a successful fetch.
        // This allows auth/network failures to be retried on remount.
        if (restoreRequestSucceeded) {
          dispatch(setHasCheckedInitialRestore(true));
        }
        setIsInitialRestoreDone(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch, setupNodeStatusTracking, formattedPath, hasCheckedInitialRestore]);

  const handleCancelWorkflow = async () => {
    console.log('[WorkflowContainer] handleCancelWorkflow called');
    setIsCancelling(true);

    try {
      const cancelTarget = runningWorkflowZarrPath || output_path;
      if (!cancelTarget) {
        throw new Error("No running workflow path");
      }
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_workflow`, {
        method: 'POST',
        body: JSON.stringify({ zarr_path: cancelTarget }),
        headers: {
          'Content-Type': 'application/json',
        },
        returnAxiosFormat: true,
      });

      console.log('[WorkflowContainer] Cancel response:', response.data);

      const rawCode = response.data?.code;
      const hasAppCode = rawCode !== undefined && rawCode !== null;
      const code = Number(rawCode);
      const ok =
        response.status === 200 &&
        response.data?.success !== false &&
        (!hasAppCode || (Number.isFinite(code) && code === 0));
      if (ok) {
        console.log('[WorkflowContainer] Cancel successful');
        
        // For queued workflows, cancellation is immediate - no need to wait
        // Backend has already removed the workflow from queue and updated positions
        console.log('[WorkflowContainer] Workflow cancelled, proceeding with state reset');

        // Close SSE connection after all nodes are done
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        // Reset workflow state
        // Note: Do NOT reset nodeLogsMeta as it contains static node information needed for logs
        dispatch(resetWorkflowStatus());
        dispatch(setIsRunning(false));
        dispatch(setWorkflowStatus('idle'));
        const currentExecutionId = runningExecutionIdRef.current;
        dispatch(setReduxNodeStatus({}));
        dispatch(setNodeProgress({}));
        dispatch(setQueueStatus({ position: 0, total: 0 }));
        dispatch(setRunningExecutionId(null));
        
        // Clean up execution_id mapping
        if (currentExecutionId) {
          dispatch(removeExecutionFromWorkflowIdMap(currentExecutionId));
        }

        // Delay SSE close event to ensure state is reset first
        setTimeout(() => {
          EventBus.emit('close-sse-connection');
        }, 50);

        EventBus.emit("workflow-graph-run-aborted");

        // Show success message in chat
        dispatch(addMessage({
          id: Date.now(),
          content: "Workflow cancelled successfully",
          sender: "bot",
          type: "success" as any,
        } as any));

        // Also show toast notification
        toast.success("Workflow cancelled successfully", {
          duration: 3000,
          description: "The workflow has been stopped and all running tasks have been cancelled."
        });
      } else {
        // Extract error message from response
        const errorMsg = response.data?.message || response.data?.error || 'Unknown error';

        dispatch(addMessage({
          id: Date.now(),
          content: errorMsg,
          sender: "bot",
          type: "error" as any,
        } as any));

        toast.error(errorMsg, {
          duration: 5000
        });
      }
    } catch (error) {
      console.error('Error cancelling workflow:', error);
      const errorMessage = getErrorMessage(error, 'Error cancelling workflow');

      dispatch(addMessage({
        id: Date.now(),
        content: errorMessage,
        sender: "bot",
        type: "error" as any,
      } as any));

      toast.error(errorMessage, {
        duration: 5000
      });
    } finally {
      setIsCancelling(false);
    }
  };

  const handleRunWorkflow = async () => {
    // Check if in samples or data directory
    if (isPublicReadOnlyPath(currentPath ?? "")) {
      dispatch(addMessage({
        id: Date.now(),
        content: getRestrictedDirectoryMessage('run workflow'),
        sender: "bot",
        type: "error" as any,
      } as any));
      return;
    }

    setIsSubmitted(true);
    
    setTimeout(() => {
      setIsSubmitted(false);
    }, 3000);

    // Use panels from selected history entry if available, otherwise use Redux panels
    // This ensures we only run the workflow for the currently selected history entry
    const selectedEntry = selectedHistoryId
      ? historyEntries.find((e) => e.id === selectedHistoryId)
      : undefined;
    const panelsToRun = selectedEntry?.panels || panels;
    const outputPathToRun = selectedEntry?.outputPath || output_path;

    // If no panels to run, return early
    if (panelsToRun.length === 0) {
      toast.error('No panels to run');
      setIsSubmitted(false);
      return;
    }

    // Reset just the status before starting a new workflow run
    dispatch(resetWorkflowStatus());

    EventBus.emit("workflow-graph-run-start");

    const { payload: workflowPayload } = buildStartWorkflowPayload(
      panelsToRun,
      outputPathToRun ?? "",
      {
        currentPath,
        nucleiClasses,
        currentOrgan,
        reduxPatchClassificationData,
        x1,
        y1,
        x2,
        y2,
        shapeData,
      }
    );

    dispatch(
      setWorkflowCompletionHints({
        refreshTissuePatches: panelsToRun.some((p) => p.title === "Tissue Classification"),
      })
    );

    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
        method: 'POST',
        body: JSON.stringify(workflowPayload),
        returnAxiosFormat: true,
      });

      if (response.status !== 200) {
        const errorText = response.data;
        throw new Error(`HTTP Error: ${response.status} - ${errorText}`);
      }

      const resultData = response.data as Record<string, any>;
      if (response.status === 200) {
        // Get execution_id from response (if available)
        const executionId = resultData?.execution_id;
        
        if (executionId) {
          // Store execution_id and map it to current workflow identifier
          dispatch(setRunningExecutionId(executionId));
          dispatch(updateExecutionToWorkflowIdMap({ 
            executionId, 
            workflowId: selectedHistoryId // null for current panels, or history entry ID
          }));
        }
        
        dispatch(setIsGenerating(true));
        dispatch(setIsRunning(true));
        dispatch(setRunningWorkflowZarrPath(outputPathToRun ?? null));
        
        // Close any existing SSE connection before starting a new one
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        
        // Fetch node ports information
        await fetchNodePorts();
        
        // Start tracking node statuses via SSE
        setupNodeStatusTracking();
        hasInitTrackingRef.current = true;
      }
      EventBus.emit("switchTab", "workflow");
    } catch (error) {
      EventBus.emit("workflow-graph-run-aborted");
    }
  };

  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only log space key events for debugging
      if (event.key === " ") {
        console.log('[WorkflowContainer] Space key detected in capture phase');
      }
      
      // Check if the event target is actually an input element in real-time
      // instead of relying on isTyping state which might get stale
      const target = event.target as HTMLElement;
      const isActuallyTyping = 
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.tagName === 'SELECT' || 
        target.isContentEditable;
      
      if (event.key === " ") {
        console.log('[WorkflowContainer] Target element:', {
          tagName: target.tagName,
          isContentEditable: target.isContentEditable,
          className: target.className,
          id: target.id,
          isActuallyTyping: isActuallyTyping
        });
      }
      
      if (isActuallyTyping && event.key === " ") {
        console.log('[WorkflowContainer] 🛑 Space key intercepted - preventing propagation (user is typing in input)');
        event.stopPropagation();
      } else if (event.key === " ") {
        console.log('[WorkflowContainer] ✅ Space key allowed to propagate');
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []); // Remove isTyping dependency since we check target directly

  // Reconnect to SSE when component mounts or isRunning changes
  useEffect(() => {
    // If a workflow is running but we don't have an active connection, reconnect
    if (isRunning && !eventSourceRef.current) {
      console.log('[WorkflowContainer] useEffect: isRunning=true but no SSE connection, reconnecting');
      // Deduplicate: only fetch ports once per run
      const doReconnect = async () => {
        if (!hasInitTrackingRef.current) {
          await fetchNodePorts();
        }
        setupNodeStatusTracking();
        hasInitTrackingRef.current = true;
      };
      doReconnect();
    }
  }, [isRunning, fetchNodePorts, setupNodeStatusTracking]);

  /** Graph (or other) started a run while this component owns tasks/v1/get_status — refresh the stream. */
  useEffect(() => {
    const handleRuntimeStarted = () => {
      if (eventSourceRef.current) {
        try {
          eventSourceRef.current.close();
        } catch {
          /* ignore */
        }
        eventSourceRef.current = null;
      }
      hasInitTrackingRef.current = false;
      if (store.getState().workflow.isRunning) {
        void (async () => {
          await fetchNodePorts();
          await setupNodeStatusTracking();
          hasInitTrackingRef.current = true;
        })();
      }
    };
    EventBus.on("workflow-runtime-started", handleRuntimeStarted);
    return () => {
      EventBus.off("workflow-runtime-started", handleRuntimeStarted);
    };
  }, [fetchNodePorts, setupNodeStatusTracking]);

  const isWorkflowComplete = useMemo(() => {
    if (panels.length === 0) return false;
    const expectedNodes = panels.map(p => p.type);
    if (expectedNodes.length === 0) return false;
    return expectedNodes.every((nodeType) => {
      if (!nodeType) return false;
      const status = nodeStatus[nodeType];
      if (status === undefined) return false;
      return status === 2 || status === -1;
    });
  }, [panels, nodeStatus]);

  // Check if all nodes are finished when nodeStatus changes (e.g., when a node is cancelled)
  useEffect(() => {
    if (panels.length === 0 || Object.keys(nodeStatus).length === 0 || !isRunning) {
      return;
    }

    const expectedNodes = panels.map(p => p.type);
    const allFinished = expectedNodes.every((nodeType) => {
      if (!nodeType) return false;
      const status = nodeStatus[nodeType];
      if (status === undefined) return false;
      return status === 2 || status === -1;
    });

    if (allFinished) {
      // All nodes are finished, close SSE connection and reset workflow status (same as normal completion)
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      dispatch(setIsRunning(false));
            dispatch(setWorkflowStatus('idle'));
            dispatch(setReduxNodeStatus({}));
            dispatch(setNodeProgress({}));
            dispatch(setQueueStatus({ position: 0, total: 0 }));
            const currentExecutionId = runningExecutionIdRef.current;
            dispatch(setRunningExecutionId(null));
            
            // Clean up execution_id mapping
            if (currentExecutionId) {
              dispatch(removeExecutionFromWorkflowIdMap(currentExecutionId));
            }
          }
  }, [panels, nodeStatus, isRunning, dispatch, eventSourceRef]);

  // Open logs dialog for a specific panel by id
  const handleOpenLogs = useCallback((panelId: string) => {
    try {
      const targetPanel = panels.find(p => p.id === panelId);
      if (!targetPanel) return;
      const nodeName = targetPanel.type;
      const meta = nodeLogsMeta?.[nodeName] || {} as any;
      setSelectedLogTarget({ node: nodeName, logPath: meta.logPath, envName: meta.envName, port: meta.port });
      setLogDialogOpen(true);
    } catch {}
  }, [panels, nodeLogsMeta]);

  return (
      <div
        className="flex flex-col h-full overflow-y-auto scrollbar-hide"
        onFocusCapture={(e) => {
          const t = e.target as HTMLElement;
          if (!t) return;
          const tag = t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
            setIsTyping(true);
          }
        }}
        onBlurCapture={(e) => {
          const t = e.target as HTMLElement;
          if (!t) return;
          const tag = t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
            setIsTyping(false);
          }
        }}
      >
        <div className="relative min-h-[50vh] flex-1 overflow-y-auto pb-[300px] mb-12 px-2 pt-2 scrollbar-hide">
            {/* Start card: workflow execution entry at top - always visible */}
            {(() => {
              const selectedEntry = selectedHistoryId
                ? historyEntries.find((e) => e.id === selectedHistoryId)
                : undefined;
              const cardTitle = selectedEntry?.name || 'Workflow';
              const cardColor = selectedEntry?.color
                ? `hsl(var(--${selectedEntry.color}))`
                : undefined;
              const hasInactiveNodes = panels.some(p => {
                // GPT-4o Agent is always considered active
                if (p.type === 'GPT-4o Agent') return false;
                // Check if node exists in nodePorts (active state)
                return !nodePorts || !nodePorts[p.type];
              });
              const isInRestricted = isPublicReadOnlyPath(currentPath ?? "");
              return (
                <div className="rounded-2xl border border-border/50 bg-card text-card-foreground shadow-sm flex flex-col transition-shadow hover:shadow-lg">
                  {/* Card header */}
                  <div className="flex items-center justify-between px-4 pt-3 pb-3 rounded-t-2xl bg-muted/80 mb-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Workflow
                        className="h-4 w-4 flex-shrink-0"
                        style={{ color: cardColor ?? undefined }}
                      />
                      <span
                        className="text-sm font-medium truncate"
                        style={{ color: cardColor ?? undefined }}
                      >
                        {cardTitle}
                      </span>
                    </div>
                    {selectedHistoryId && (
                      <WorkflowHistoryActionsMenu
                        entryId={selectedHistoryId}
                        entryName={selectedEntry?.name ?? ''}
                      />
                    )}
                  </div>
                  {/* Card body */}
                  <div className="px-4 pb-4 flex flex-col gap-2">
                      {/* Save buttons */}
                      {selectedHistoryId ? (
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            className="flex-1 h-9 gap-1.5 text-sm"
                            disabled={panels.length === 0 || (isRunning && isCurrentWorkflowRunning)}
                            onClick={() => {
                              updateHistoryEntry(selectedHistoryId, panels, output_path);
                              toast.success('Changes saved');
                            }}
                          >
                            <Save className="h-4 w-4" />
                            Save change
                          </Button>
                          <Button
                            variant="secondary"
                            className="flex-1 h-9 gap-1.5 text-sm"
                            disabled={panels.length === 0 || (isRunning && isCurrentWorkflowRunning)}
                            onClick={() => {
                              setSaveName('');
                              setSaveDialogOpen(true);
                            }}
                          >
                            <Save className="h-4 w-4" />
                            Save as...
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="secondary"
                          className="w-full h-9 gap-1.5 text-sm"
                          disabled={panels.length === 0 || (isRunning && isCurrentWorkflowRunning)}
                          onClick={() => {
                            setSaveName('');
                            setSaveDialogOpen(true);
                          }}
                        >
                          <Save className="h-4 w-4" />
                          Save Workflow
                        </Button>
                      )}
                      {/* Run button */}
                      <Button
                        onClick={handleRunWorkflow}
                        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-md h-9 gap-1.5"
                        disabled={isSubmitted || hasInactiveNodes || isInRestricted || isRunning || panels.length === 0}
                      >
                        {isSubmitted ? (
                          <>Submitted!</>
                        ) : (
                          <>
                            <Play className="h-4 w-4" />
                            Run Workflow
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })()}
              <div className="flex justify-center py-1">
                <ArrowBigDown 
                  className={`h-5 w-5 fill-current ${panels.length === 0 ? 'text-muted-foreground/35' : 'text-muted-foreground/70'}`} 
                  aria-hidden 
                />
              </div>

              {/* Initial load: show spinner until restore check completes; then show ImportModelCard or panels */}
              {panels.length === 0 && !isInitialRestoreDone && (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
                  <span className="text-sm">Loading workflow…</span>
                </div>
              )}
              {panels.length === 0 && isInitialRestoreDone && (
                <ImportModelCard
                  onTriggerClick={() => {
                    if (isPublicReadOnlyPath(currentPath ?? "")) {
                      toast.error(getRestrictedDirectoryMessage('import model'));
                      return;
                    }
                    setImportDialogOpen(true);
                  }}
                />
              )}

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={panels} strategy={verticalListSortingStrategy}>
                  {(() => {
                    // Build tree nodes from flat panels using MODEL_DEPENDENCIES (recursive)
                    const claimedAsChild = new Set<string>();
                    const treeNodes: ModelTreeNode[] = [];

                    const buildNode = (panelIndex: number): ModelTreeNode => {
                      const panel = panels[panelIndex];
                      const dep = MODEL_DEPENDENCIES[panel.type];
                      const children: ModelTreeNode[] = [];

                      if (dep) {
                        const nextIndex = panelIndex + 1;
                        const next = nextIndex < panels.length ? panels[nextIndex] : null;
                        if (next && next.type === dep.childType) {
                          claimedAsChild.add(next.id);
                          children.push(buildNode(nextIndex));
                        }
                      }

                      const canAddChild = dep && children.length === 0
                        ? { buttonLabel: dep.buttonLabel, onAdd: () => handleImportChild(panelIndex, dep) }
                        : undefined;

                      return { id: panel.id, panel, children, canAddChild };
                    };

                    for (let i = 0; i < panels.length; i++) {
                      if (claimedAsChild.has(panels[i].id)) continue;
                      treeNodes.push(buildNode(i));
                    }

                    return treeNodes.map((treeNode, index) => (
                      <Fragment key={treeNode.id}>
                        {index > 0 && (
                          <div className="flex justify-center py-1">
                            <ArrowBigDown className="h-5 w-5 text-muted-foreground/70 fill-current" aria-hidden />
                          </div>
                        )}
                        <ModelTreeCard
                          node={treeNode}
                          renderPanel={(panel, collapsed) => (
                            <SortablePanel
                              panel={panel}
                              onContentChange={handleContentChange}
                              onDelete={handleDeleteModel}
                              nodeStatus={isCurrentWorkflowRunning ? nodeStatus : {}}
                              nodeProgress={isCurrentWorkflowRunning ? nodeProgress : {}}
                              nodePortsInfo={nodePorts}
                              zarrPath={output_path}
                              logMetadata={nodeLogsMeta?.[panel.type]}
                              onShowLogs={handleOpenLogs}
                              collapsed={collapsed}
                            />
                          )}
                        />
                      </Fragment>
                    ));
                  })()}
                </SortableContext>
              </DndContext>
        </div>

        <div className="absolute bottom-0 left-0 right-0 bg-card border-t border-border/50">
          {/* Show workflow status as soon as user submits (Preparing), then SSE tells us queued/running */}
          {isCurrentWorkflowRunning ? (
            <WorkflowStatusSummary
              panels={panels}
              nodeStatus={nodeStatus}
              nodeProgress={nodeProgress}
              setNodeStatus={(status) => dispatch(setReduxNodeStatus(status))}
              zarrPath={runningWorkflowZarrPath ?? output_path}
              workflowStatus={workflowStatus}
              queuePosition={queuePosition}
              queueTotal={queueTotal}
              onCancel={handleCancelWorkflow}
              isCancelling={isCancelling}
            />
          ) : (
            <>
              {panels.length > 0 && (
                <WorkflowConfigSection
                  outputPath={output_path}
                  onOutputPathChange={(value) => {
                    setOutput(value);
                    setDidUserEditOutputPath(true);
                  }}
                  panels={panels}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  onX1Change={setX1}
                  onY1Change={setY1}
                  onX2Change={setX2}
                  onY2Change={setY2}
                  onFocus={() => setIsTyping(true)}
                  onBlur={() => setIsTyping(false)}
                />
              )}
              <div className="flex items-center justify-center py-2 pb-7 px-4 gap-1.5 w-full">
                <ImportModelDialog
                  currentPath={currentPath}
                  open={importDialogOpen}
                  onOpenChange={setImportDialogOpen}
                  existingPanelTypes={panels.map(p => p.type)}
                  onImport={async (modelConfig) => {
                    const newId = (panels.length + 1).toString();

                    // Handle custom panels differently
                    const isCustomPanel = (modelConfig as any).customNodeKey !== undefined;
                    if (isCustomPanel) {
                      // For custom panels, we need to get the panel configuration from backend
                      try {
                        // Use customNodeKey if provided, otherwise fallback to nodeType
                        const customPanelKey = (modelConfig as any).customNodeKey || modelConfig.nodeType;
                        
                        // Get panel config from backend
                        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_panel_config/${customPanelKey}`, {
                          method: 'GET',
                          returnAxiosFormat: true,
                        });
                        const data = response.data as Record<string, any>;
                        
                        if (data?.panel_config) {
                          const customPanel = data.panel_config;
                          const newPanel: WorkflowPanel = {
                            id: 'temp',
                            title: customPanel.title,
                            type: customPanelKey,
                            progress: 0,
                            content: customPanel.panel.map((item: any) => ({
                              ...item,
                              value: modelConfig.input || item.value
                            })),
                            ui: customPanel.ui || null
                          };
                          // Backtrack up CHILD_TO_PARENT to auto-import all missing ancestors
                          const ancestorsToAdd: WorkflowPanel[] = [];
                          let ct = customPanelKey;
                          while (CHILD_TO_PARENT[ct]) {
                            const pInfo = CHILD_TO_PARENT[ct];
                            if (panels.some(p => p.type === pInfo.parentType)) break;
                            const pCfg = panelMap[pInfo.parentPanelKey];
                            if (!pCfg) break;
                            ancestorsToAdd.unshift({
                              id: 'temp',
                              title: pCfg.title,
                              type: pInfo.parentType,
                              progress: 0,
                              content: pCfg.defaultContent.map(item => ({ ...item })),
                              ui: null,
                            });
                            ct = pInfo.parentType;
                          }
                          console.log("Import chain:", ancestorsToAdd.map(a => a.type), newPanel.type);
                          if (ancestorsToAdd.length > 0) {
                            const merged = [...panels, ...ancestorsToAdd, newPanel]
                              .map((p, i) => ({ ...p, id: (i + 1).toString() }));
                            dispatch(setPanels(merged));
                          } else {
                            dispatch(addPanel({ ...newPanel, id: newId }));
                          }
                          return;
                        }
                      } catch (error) {
                        console.error('Failed to load custom panel:', error);
                      }
                    }

                    // Handle regular panels
                    const panelConfig = panelMap[modelConfig.model];
                    if (panelConfig) {
                      const resolvedType = modelConfig.nodeType || panelConfig.defaultType;

                      // Backtrack up CHILD_TO_PARENT to collect all missing ancestors
                      const missingAncestors: WorkflowPanel[] = [];
                      let currentType = resolvedType;
                      while (CHILD_TO_PARENT[currentType]) {
                        const info = CHILD_TO_PARENT[currentType];
                        if (panels.some(p => p.type === info.parentType)) break;
                        const ancestorConfig = panelMap[info.parentPanelKey];
                        if (!ancestorConfig) break;
                        missingAncestors.unshift({
                          id: 'temp',
                          title: ancestorConfig.title,
                          type: info.parentType,
                          progress: 0,
                          content: ancestorConfig.defaultContent.map(item => ({ ...item })),
                          ui: null,
                        });
                        currentType = info.parentType;
                      }
                      if (missingAncestors.length > 0) {
                        const childContent = (modelConfig as any).panel
                          ? (modelConfig as any).panel.map((item: any) => ({ ...item }))
                          : panelConfig.defaultContent.map(item => ({ ...item, value: modelConfig.input }));
                        const panelTitle = (modelConfig as any).displayName ?? panelConfig.title;
                        const childPanel: WorkflowPanel = {
                          id: 'temp',
                          title: panelTitle,
                          type: resolvedType,
                          progress: 0,
                          content: childContent,
                          ui: modelConfig.ui || null,
                        };
                        const merged = [...panels, ...missingAncestors, childPanel]
                          .map((p, i) => ({ ...p, id: (i + 1).toString() }));
                        dispatch(setPanels(merged));
                        return;
                      }

                      const resolvedContent = (modelConfig as any).panel
                        ? (modelConfig as any).panel.map((item: any) => ({ ...item }))
                        : panelConfig.defaultContent.map(item => ({ ...item, value: modelConfig.input }));
                      const panelTitle = (modelConfig as any).displayName ?? panelConfig.title;
                      const newPanel: WorkflowPanel = {
                        id: newId,
                        title: panelTitle,
                        type: resolvedType,
                        progress: 0,
                        content: resolvedContent,
                        ui: modelConfig.ui || null
                      };
                      dispatch(addPanel(newPanel));
                    }
                  }}
                />

              </div>
            </>
          )}
        </div>
        {/* Logs dialog for workflow panels */}
        <NodeLogsDialog
          open={logDialogOpen}
          onOpenChange={setLogDialogOpen}
          env={selectedLogTarget?.envName}
          port={selectedLogTarget?.port}
          node={selectedLogTarget?.node}
          pollMs={2000}
        />
        {/* Save Workflow Dialog */}
        <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selectedHistoryId ? 'Save Workflow As' : 'Save Workflow'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="workflow-name" className="text-sm font-medium">
                  Workflow Name
                </label>
                <Input
                  id="workflow-name"
                  placeholder="Enter workflow name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && saveName.trim()) {
                      handleSaveWorkflow();
                    }
                  }}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setSaveDialogOpen(false);
                  setSaveName('');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveWorkflow}
                disabled={!saveName.trim() || panels.length === 0}
              >
                Save
              </Button>
            </div>
          </DialogContent>
        </Dialog>


      </div>
  );
};
