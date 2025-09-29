import React, {useEffect, useState, useRef, useCallback, useMemo} from "react"
import {closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors,} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"

import { Card, CardContent } from "@/components/ui/card"

import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {ImportModelDialog} from "./ImportModelDialog"
import {useDispatch, useSelector} from "react-redux";
import {AppDispatch, RootState} from "@/store";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import http from '@/utils/http';
import { CoordinateBox } from "./Workflow/CoordinateBox"
import { WorkflowStatusSummary } from "./Workflow/WorkflowStatusSummary"
import { SortablePanel } from "./Workflow/SortablePanel"

import EventBus from "@/utils/EventBus"
import {setIsGenerating, addMessage} from "@/store/slices/chatSlice";
import { setClassificationEnabled, requestClassification } from "@/store/slices/annotationSlice"
import {
  setPanels,
  updatePanel,
  deletePanel,
  addPanel,
  reorderPanels,
  setNodeStatus as setReduxNodeStatus,
  setNodePorts as setReduxNodePorts,
  setNodeProgress,
  setNodeLogsMeta,
  setIsRunning,
  resetWorkflowStatus,
  WorkflowPanel,
  ContentItem,
  resetWorkflow
} from "@/store/slices/workflowSlice";
import { formatPath } from "@/utils/pathUtils"
import { panelMap } from "./Workflow/constants"
import { Check, Info, Play } from "lucide-react"
import { selectPatchClassificationData } from "@/store/slices/annotationSlice";
import NodeLogsDialog from '@/components/AgentZoo/NodeLogsDialog'

export const WorkflowContainer = () => {
  const dispatch = useDispatch<AppDispatch>();
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  // Get workflow state from Redux
  const panels = useSelector((state: RootState) => state.workflow.panels);
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);
  const nodePorts = useSelector((state: RootState) => state.workflow.nodePorts);
  const nodeProgress = useSelector((state: RootState) => state.workflow.nodeProgress);
  const nodeLogsMeta = useSelector((state: RootState) => state.workflow.nodeLogsMeta);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);

  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

  const getDefaultOutputPath = (path: string) => {
    if (!path) return "";
    return path + '.h5';
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


  useEffect(() => {
    if (rectangleCoords) {
      setX1(rectangleCoords.x1.toString());
      setY1(rectangleCoords.y1.toString());
      setX2(rectangleCoords.x2.toString());
      setY2(rectangleCoords.y2.toString());
    } else {
      setX1("");
      setY1("");
      setX2("");
      setY2("");
    }
  }, [rectangleCoords]);

  useEffect(() => {
    if (slideDimensions && slideDimensions.length === 2) {
      // dimensions are [width, height]
      setX1("0");
      setY1("0");
      setX2(slideDimensions[0].toString());
      setY2(slideDimensions[1].toString());
    } else {
      setX1("");
      setY1("");
      setX2("");
      setY2("");
    }
  }, [slideDimensions]);


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
  }, [formattedPath, didUserEditOutputPath, output_path]);

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
      if (!hasPath && panel.type !== 'Scripts' && panel.title !== panelMap.NucleiClassify.title) {
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
  };

  const handleDeleteModel = (id: string) => {
    dispatch(deletePanel(id));
  };

  const [isSubmitted, setIsSubmitted] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [selectedLogTarget, setSelectedLogTarget] = useState<{ node: string; logPath?: string; envName?: string; port?: number } | null>(null);
  
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const hasInitTrackingRef = useRef<boolean>(false);

  // Poll gateway paused flag (skip in Electron environment and local development)

  
  // Modify the checkWorkflowCompletion function to return whether all nodes are complete
  const checkWorkflowCompletion = useCallback((statusData: Record<string, number>) => {
    // If there are no panels or no status data, return false
    if (panels.length === 0 || Object.keys(statusData).length === 0) {
      return false;
    }

    // Generate an array of expected node types based on panels
    const expectedNodes = panels.map(panel => panel.type);
    
    // Check if all expected nodes have status 2 (completed) or -1 (failed)
    const allFinished = expectedNodes.every(nodeType => {
      const status = statusData[nodeType];
      return status === 2 || status === -1;
    });
    
    // Check if at least one node has failed
    const hasFailedNodes = expectedNodes.some(nodeType => {
      const status = statusData[nodeType];
      return status === -1;
    });
    
    if (allFinished) {
      // Close the overall workflow status SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      
      // Update UI
      dispatch(setIsRunning(false));
      
      return true;
    }
    
    return false;
  }, [panels, dispatch, eventSourceRef]);

  // Function to establish SSE connection and listen for node status updates
  const setupNodeStatusTracking = useCallback(() => {
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Create a new EventSource connection for overall workflow status
    const eventSource = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_status`);
    eventSourceRef.current = eventSource;
    
    // Flag to track if we've detected workflow completion
    let workflowCompleteDetected = false;

    // Set up event listeners
    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.node_status) {
          dispatch(setReduxNodeStatus(data.node_status));
          
          // Update node progress if available
          if (data.node_progress) {
            dispatch(setNodeProgress(data.node_progress));
          }
          
          // Check if the backend explicitly signals workflow completion
          if (data.workflow_complete === true) {
            workflowCompleteDetected = true;
            
            // Perform completion sequence for segmentation refresh
            try {
              await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {
                path: output_path
              });
              EventBus.emit("refresh-websocket-path", { path: output_path.replace('.h5', ''), forceReload: true });
            } catch (e) {
            }

            // Close the connection properly
            if (eventSourceRef.current) {
              eventSourceRef.current.close();
              eventSourceRef.current = null;
            }
            dispatch(setIsRunning(false));
            return;
          }
          
          // Also check our client-side workflow completion logic
          // This serves as a backup in case we miss the workflow_complete flag
          const allNodesComplete = checkWorkflowCompletion(data.node_status);
          
          if (allNodesComplete) {
            workflowCompleteDetected = true;

            
            try {
              // step 1: reload
              const reload_response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {
                path: output_path
              });

              // step 2: trigger a full refresh of the canvas
              EventBus.emit("refresh-websocket-path", { path: output_path.replace('.h5', ''), forceReload: true });
              

              // step 3: fetch generated script (if any) from backend answer endpoint and inject into Code Calculation panel
              try {
                const answerResp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`);
                const answerJson = answerResp.data;
                const answer = answerJson?.data?.answer;
                if (typeof answer === 'string' && answer.includes('def analyze_medical_image')) {
                  const nextPanels = panelsRef.current.map(p => {
                    if (p.title === panelMap.Scripts.title) {
                      const existing = p.content.find(c => c.key === 'generated_script');
                      const newContent = existing
                        ? p.content.map(c => c.key === 'generated_script' ? { ...c, value: answer } : c)
                        : [...p.content, { key: 'generated_script', type: 'text', value: answer } as any];
                      return { ...p, content: newContent };
                    }
                    return p;
                  });
                  dispatch(setPanels(nextPanels));
                  try {
                    dispatch(addMessage({
                      id: Date.now(),
                      content: "Your workflow finished. Your code is ready in Workflow → Scripts. Open it there to review and click Run Code to produce the final answer.",
                      sender: "bot",
                      type: "workflow-finished-hint" as any,
                    } as any));
                  } catch (e) {}
                }
              } catch (e) {
              }

            } catch (error) {
            }
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
      
      // Check if all nodes are complete based on current status
      const allNodesFinished = Object.values(nodeStatus).length > 0 && 
        Object.values(nodeStatus).every(status => status === 2 || status === -1);
      
      if (allNodesFinished) {
        // This is expected - just clean up
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        dispatch(setIsRunning(false));
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

    
  }, [dispatch, nodeStatus, output_path, eventSourceRef, checkWorkflowCompletion]);
  
  // Clean up SSE connection when component unmounts
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  // Function to fetch node port information
  const fetchNodePorts = useCallback(async () => {
    try {
      const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`);
      if (response.status !== 200) {
        throw new Error(`Failed to fetch node ports: ${response.status}`);
      }
      
      const responseData = response.data;
      
      if (responseData?.data?.nodes) {
        // Extract and store just the port and running status
        const portInfo: Record<string, { port: number, running: boolean }> = {};
        const logsMeta: Record<string, { logPath?: string; envName?: string; port?: number }> = {};
        
        Object.entries(responseData.data.nodes).forEach(([nodeName, info]: [string, any]) => {
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

  const handleStopWorkflow = async () => {
    try {
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_workflow`, {
        h5_path: output_path
      });

      if (response.status !== 200) {
        const errorText = response.data;
        throw new Error(`HTTP Error: ${response.status} - ${errorText}`);
      }

      const resultData = response.data;
      if (resultData.success || resultData.message === "Success") {
        // Close SSE connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        
        // Update UI state
        dispatch(setIsRunning(false));
        dispatch(setIsGenerating(false));
        
        
        
        // Show user feedback with restart information
        const restartInfo = resultData.data?.restarted_nodes ? ` Restarted ${resultData.data.restarted_nodes.length} nodes: ${resultData.data.restarted_nodes.join(', ')}.` : '';
        dispatch(addMessage({
          id: Date.now(),
          content: `Workflow stopped successfully. ${resultData.data?.stopped_processes ? `Stopped ${resultData.data.stopped_processes.length} processes.` : ''}${resultData.data?.rollback_performed ? ' Files have been rolled back to their state before workflow execution.' : ''}${restartInfo}`,
          sender: "bot",
          type: "workflow-stopped" as any,
        } as any));
        
        // Refresh node ports information after restart
        try {
          await fetchNodePorts();
        } catch (error) {
        }
        
        // No explicit UI status change to "stopped"; just rely on refreshed ports/status from backend.
      }
    } catch (error: unknown) {
      // Show error message to user
      const message = error instanceof Error ? error.message : String(error);
      dispatch(addMessage({
        id: Date.now(),
        content: `Failed to stop workflow: ${message}`,
        sender: "bot",
        type: "error" as any,
      } as any));
    }
  };

  const handleRunWorkflow = async () => {
    setIsSubmitted(true);
    
    setTimeout(() => {
      setIsSubmitted(false);
    }, 3000);

    // Reset just the status before starting a new workflow run
    dispatch(resetWorkflowStatus());

    const workflowPayload: any = { h5_path: output_path ?? "" };

    panels.forEach((panel, index) => {
      const stepKey = `step${index + 1}`;
      const modelName = panel.type || "Scripts";
      const inputObject: Record<string, any> = {};
      panel.content.forEach((contentItem) => {
        inputObject[contentItem.key] = contentItem.value;
      });
      
      if (currentPath) {
        inputObject["path"] = currentPath;
      }
      
      // Handle specific panel types and add their special parameters
      if (panel.title === "Tissue Classification") {
        // x_start, x_end, width, height
        const width = Number(x2) - Number(x1)
        const height = Number(y2) - Number(y1)
        inputObject.bbox = [Number(x1), Number(y1), width, height];
        if (inputObject.rate) {
          inputObject.rate = Number(inputObject.rate);
        }
      }
      
      if (panel.title === "Nuclei Classification") {
        inputObject.nuclei_classes = nucleiClasses.map((cls) => cls.name);
        inputObject.nuclei_colors = nucleiClasses.map((cls) => cls.color);
        
        const loadPath = panel.content.find(item => item.key === "classifier_path")?.value;
        const savePath = panel.content.find(item => item.key === "save_classifier_path")?.value;
        
        inputObject.classifier_path = loadPath || null;
        inputObject.save_classifier_path = savePath || null;
      }
      
      if (panel.title === "Tissue Classification") {
        if (reduxPatchClassificationData) {
          inputObject.tissue_classes = reduxPatchClassificationData.class_name;
          inputObject.tissue_colors = reduxPatchClassificationData.class_hex_color;
          
          // Add classifier paths
          const loadPath = panel.content.find(item => item.key === "classifier_path")?.value;
          const savePath = panel.content.find(item => item.key === "save_classifier_path")?.value;
          
          inputObject.classifier_path = loadPath || null;
          inputObject.save_classifier_path = savePath || null;
        }
      }
      
      if (panel.title === panelMap.NucleiSeg.title) {
        const targetMppItem = panel.content.find(item => item.key === "target_mpp");
        if (targetMppItem?.value && targetMppItem.value.trim() !== "") {
          const mppValue = parseFloat(targetMppItem.value);
          if (!isNaN(mppValue)) {
            inputObject.target_mpp = mppValue;
          }
        }
        // Add the general bbox from WorkflowContainer state
        if (x1 && y1 && x2 && y2 && !isNaN(Number(x1)) && !isNaN(Number(y1)) && !isNaN(Number(x2)) && !isNaN(Number(y2))) {
          const numX1 = Number(x1);
          const numY1 = Number(y1);
          const numX2 = Number(x2);
          const numY2 = Number(y2);
          const width = numX2 - numX1;
          const height = numY2 - numY1;
          if (width > 0 && height > 0) {
            inputObject.bbox = `${numX1},${numY1},${width},${height}`;
          }
        }
        if (shapeData?.polygonPoints) {
          inputObject.polygon_points = shapeData.polygonPoints;
        }
      }

      workflowPayload[stepKey] = { model: modelName, input: inputObject };
    });

    try {
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, workflowPayload);

      if (response.status !== 200) {
        const errorText = response.data;
        throw new Error(`HTTP Error: ${response.status} - ${errorText}`);
      }

      const resultData = response.data;
      if (resultData.message === "Success") {
        dispatch(setIsGenerating(true));
        dispatch(setIsRunning(true));
        
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
    }
  };

  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTyping && event.key === " ") {
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isTyping]);

  // Reconnect to SSE when component mounts
  useEffect(() => {
    // If a workflow is running but we don't have an active connection, reconnect
    if (isRunning && !eventSourceRef.current) {
      // Deduplicate: only fetch ports once per run
      const doReconnect = async () => {
        if (!hasInitTrackingRef.current) {
          await fetchNodePorts();
        }
        setupNodeStatusTracking();
      };
      doReconnect();
    }
  }, [isRunning, fetchNodePorts, setupNodeStatusTracking]);

  const isWorkflowComplete = useMemo(() => {
    if (panels.length === 0) return false;
    const expectedNodes = panels.map(p => p.type);
    if (expectedNodes.length === 0) return false;
    return expectedNodes.every(nodeType => {
      const status = nodeStatus[nodeType];
      return status === 2 || status === -1;
    });
  }, [panels, nodeStatus]);

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
        className="flex-col h-full overflow-y-auto scrollbar-hide"
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
        {!isWorkflowComplete && (
          <div className="absolute bottom-[130px] right-0 z-10 px-2 w-full">
            <div className="w-fit group hover:w-full ml-auto">
              <div className="flex items-center justify-center bg-white rounded-full h-8 w-8 border shadow-md cursor-pointer ml-auto transition-all duration-300 group-hover:hidden">
                <Info className="h-4 w-4 text-gray-500" />
              </div>
              <Card className="w-full border hidden group-hover:!block transition-all duration-300">
                <CardContent className="space-y-2 px-3 pb-3 pt-2">
                  <div className="space-y-1">
                    <Label htmlFor="output" className="text-sm">
                      Output
                    </Label>
                    <Input
                      id="output"
                      value={output_path}
                      onFocus={() => setIsTyping(true)}
                      onBlur={() => setIsTyping(false)}
                    onChange={(e) => { setOutput(e.target.value); setDidUserEditOutputPath(true); }}
                      className="h-8 text-sm"
                    />
                  </div>
                  {(panels.some(panel => panel.title === panelMap.TissueClassify.title || panel.title === panelMap.NucleiSeg.title || panel.title === panelMap.TissueSeg.title)) && (
                      <CoordinateBox
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
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        <div className="min-h-[50vh] flex-1 overflow-y-auto pb-[100px] pt-2 mb-12 px-2">
          {panels.length === 0 ? (
            <div className="h-full flex items-center justify-center pt-2">
              <p className="text-sm text-gray-400">Import your models below and then start your workflow.</p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={panels} strategy={verticalListSortingStrategy}>
                {panels.map((panel) => (
                    <SortablePanel
                        key={panel.id}
                        panel={panel}
                        onContentChange={handleContentChange}
                        onDelete={handleDeleteModel}
                        nodeStatus={nodeStatus}
                        nodePortsInfo={nodePorts}
                        h5Path={output_path}
                        logMetadata={nodeLogsMeta?.[panel.type]}
                        onShowLogs={handleOpenLogs}
                    />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
        
        <div className="absolute bottom-0 left-0 right-0 bg-white border-t">
          {Object.keys(nodeStatus).length > 0 ? (
            // Show workflow status when workflow is running
            <WorkflowStatusSummary 
              panels={panels}
              nodeStatus={nodeStatus}
              nodeProgress={nodeProgress}
              setNodeStatus={(status) => dispatch(setReduxNodeStatus(status))}
              onStopWorkflow={handleStopWorkflow}
              h5Path={output_path}
            />
          ) : (
            // Show import and run controls when no workflow is running
            <div className="flex justify-between flex-col items-center py-3 space-y-3">
              <ImportModelDialog
                onImport={(modelConfig) => {
                  const newId = (panels.length + 1).toString();
                  const panelConfig = panelMap[modelConfig.model];
                  const newPanel: WorkflowPanel = {
                    id: newId,
                    title: panelConfig.title, //same as modelConfig.model
                    type: modelConfig.nodeType || panelConfig.defaultType,
                    progress: 0,
                    content: panelConfig.defaultContent.map(item => ({
                      ...item,
                      value: modelConfig.input
                    }))
                  };
                  dispatch(addPanel(newPanel));
                }}
              />
              <div className="relative">
                {(() => {
                  const hasInactiveNodes = panels.some(p => {
                    if (p.type === 'Scripts') {
                      return false
                    }
                    return !nodePorts || !nodePorts[p.type]
                  });
                  return (
                    <Button 
                      onClick={handleRunWorkflow}
                      className="flex items-center bg-indigo-600 hover:bg-indigo-700 text-white shadow-md"
                      disabled={isSubmitted || hasInactiveNodes }
                    >
                      {isSubmitted ? (
                        <>
                          <Check className="h-4 w-4 mr-2"/>
                          Workflow Submitted!
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4 mr-2"/>
                          Run Workflow
                        </>
                      )}
                    </Button>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
        {/* Logs dialog for workflow panels */}
        <NodeLogsDialog
          open={logDialogOpen}
          onOpenChange={setLogDialogOpen}
          env={selectedLogTarget?.envName}
          port={selectedLogTarget?.port}
          logPath={selectedLogTarget?.logPath}
          pollMs={2000}
        />
      </div>
  );
};
