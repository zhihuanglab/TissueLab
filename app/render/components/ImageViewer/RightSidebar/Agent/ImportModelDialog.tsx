import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils"
import { Plus } from "lucide-react"
import Image from "next/image"
import { useRouter } from "next/router"
import React, { useCallback, useEffect, useMemo, useState } from "react"

interface NodeMeta {
  displayName?: string;
  description?: string;
  icon?: string;
  factory?: string;
  ui?: Record<string, any>;
  inputs?: string;
  outputs?: string;
  source?: string;
  panel?: Array<{ key: string; type: string; value: string; label?: string; placeholder?: string }>;
}

interface NodesExtendedPayload {
  nodes: Record<string, NodeMeta>;
  category_map: Record<string, string[]>;
  category_display_names: Record<string, string>;
}

// Pseudo-category that surfaces a curated short-list at the top of the left rail.
const FREQUENT_CATEGORY_KEY = "__frequent__";
const FREQUENT_CATEGORY_LABEL = "Frequently Used Models";
const FREQUENT_NODE_IDS = ["ClassificationNode", "PatchClassifier", "VISTA"];

type ImportModelDialogProps = {
  currentPath?: string | null;
  onImport: (modelConfig: {
    model: string;
    input: string;
    nodeType: string;
    ui?: Record<string, any> | null;
    customNodeKey?: string;
    panel?: Array<{ key: string; type: string; value: string; label?: string; placeholder?: string }> | null;
    displayName?: string;
  }) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: React.RefObject<{ open: () => void }>;
  existingPanelTypes?: string[];
}

const getNodeIcon = (nodeName: string, iconUrl?: string) => {
  if (iconUrl) {
    return <Image src={iconUrl} alt={`${nodeName} icon`} className="w-full h-full object-cover" width={24} height={24}/>;
  }
  const initials = nodeName
    .split(/(?=[A-Z0-9])|[\s_-]/)
    .filter(word => word.length > 0)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  // Use primary color from CSS variable for icon background
  const primaryColor = typeof window !== 'undefined' 
    ? getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    : '249 35% 48%'; // Fallback
  return (
    <div 
      className="w-full h-full flex items-center justify-center text-primary-foreground"
      style={{ backgroundColor: `hsl(${primaryColor})` }}
    >
      <div className="w-full h-full flex items-center justify-center p-2 text-center">
        <span className="font-medium">{initials}</span>
      </div>
    </div>
  );
};

const getNodeDescription = (nodeName: string, nodesMeta: Record<string, any>) => 
  nodesMeta?.[nodeName]?.description || `${nodeName} model`;

export const ImportModelDialog: React.FC<ImportModelDialogProps> = ({
  currentPath,
  onImport,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  triggerRef,
  existingPanelTypes,
}) => {
  const [selectedModel, setSelectedModel] = useState<string>("")
  const [selectedNode, setSelectedNode] = useState<string>("")
  const [internalOpen, setInternalOpen] = useState(false)
  const [showWarning, setShowWarning] = useState(false)
  
  // Use external open state if provided, otherwise use internal state
  const open = externalOpen !== undefined ? externalOpen : internalOpen
  const setOpen = externalOnOpenChange || setInternalOpen
  const [factoryModels, setFactoryModels] = useState<Record<string, string[]>>(
    modelRegistryFallback.category_map as Record<string, string[]>
  );
  const [categoryNames, setCategoryNames] = useState<Record<string, string>>(
    modelRegistryFallback.category_display_names as Record<string, string>
  );
  const [nodesMeta, setNodesMeta] = useState<Record<string, NodeMeta>>(
    modelRegistryFallback.nodes as Record<string, NodeMeta>
  );
  const [runningNodes, setRunningNodes] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(modelRegistryFallback.nodes).map((name) => [name, true]))
  );
  const [customPanels, setCustomPanels] = useState<Record<string, any>>({});
  const [activatingNodes, setActivatingNodes] = useState<Set<string>>(new Set());
  const router = useRouter();

  // Reusable fetch for running node status
  const fetchNodePorts = useCallback(async () => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, { method: 'GET', returnAxiosFormat: true });
      const inner = payloadFromAxiosAppResponse<{ nodes?: Record<string, { running?: boolean }> }>(resp) ?? {};
      const nodes = inner.nodes || {};
      const runningMap: Record<string, boolean> = { 'GPT-4o Agent': true };
      Object.keys(nodes).forEach((name) => { runningMap[name] = !!nodes[name]?.running; });
      setRunningNodes(runningMap);
    } catch (e) {
      console.error('Error fetching node ports:', e);
    }
  }, []);

  // Initial data load
  useEffect(() => {
    (async () => {
      try {
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
          method: 'GET',
          returnAxiosFormat: true,
        });
        const data: NodesExtendedPayload = (payloadFromAxiosAppResponse<NodesExtendedPayload>(response) ||
          {}) as NodesExtendedPayload;
        setFactoryModels(data?.category_map || {});
        setCategoryNames(data?.category_display_names || {});
        setNodesMeta(data?.nodes || {});
      } catch (error) {
        console.error('Error fetching nodes metadata:', error);
      }
      await fetchNodePorts();
      loadCustomPanels();
    })();
  }, [fetchNodePorts]);

  // Live updates: re-fetch on dialog open, SSE subscription, and model-zoo-refresh
  useEffect(() => {
    // Refresh when dialog opens
    if (open) {
      fetchNodePorts();
      // Clear stale activating states - nodes may have finished while dialog was closed
      setActivatingNodes(new Set());
    }

    // SSE subscription for activation events (only when dialog is open)
    let es: EventSource | null = null;
    if (open) {
      es = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/activation/events`);
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          const modelName = payload?.model;
          const status = payload?.status;
          
          if (modelName && status === 'starting') {
            // Mark node as activating
            setActivatingNodes(prev => new Set(prev).add(modelName));
          }
          
          if (status === 'ready' || status === 'failed') {
            // Clear activating state and refresh node ports
            if (modelName) {
              setActivatingNodes(prev => {
                const next = new Set(prev);
                next.delete(modelName);
                return next;
              });
            } else {
              // If modelName is missing, clear all activating states to prevent stale entries
              setActivatingNodes(new Set());
            }
            fetchNodePorts();
          }
        } catch {}
      };
      es.onerror = (error) => {
        console.error('[ImportModelDialog] activation SSE connection error', error);
      };
    }

    // Listen for model-zoo-refresh events
    const handleRefresh = () => { loadCustomPanels(); fetchNodePorts(); };
    window.addEventListener('model-zoo-refresh', handleRefresh);

    return () => {
      if (es) { try { es.close(); } catch {} }
      window.removeEventListener('model-zoo-refresh', handleRefresh);
    };
  }, [open, fetchNodePorts]);

  const loadCustomPanels = async () => {
    try {
      // Load custom panels from backend instead of localStorage
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_all_panel_configs`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      const panelsPayload = payloadFromAxiosAppResponse<Record<string, unknown>>(response);
      if (panelsPayload && typeof panelsPayload === 'object') {
        setCustomPanels(panelsPayload);
      }
    } catch (error) {
      console.error('Failed to load custom panels:', error);
    }
  };

  useEffect(() => {
    setSelectedNode("");
  }, [selectedModel]);

  // Cache available nodes and node type mapping
  const { availableNodes, nodeTypeMap: computedNodeTypeMap } = useMemo(() => {
    if (!selectedModel) {
      return { availableNodes: [], nodeTypeMap: {} };
    }

    const availableNodes: string[] = [];
    const newNodeTypeMap: Record<string, 'factory' | 'custom'> = {};

    // Pseudo-category — pull a curated short list from across all factories.
    if (selectedModel === FREQUENT_CATEGORY_KEY) {
      FREQUENT_NODE_IDS.forEach((node) => {
        if (nodesMeta?.[node] || customPanels[node]) {
          availableNodes.push(node);
          newNodeTypeMap[node] = customPanels[node] ? 'custom' : 'factory';
        }
      });
      return { availableNodes, nodeTypeMap: newNodeTypeMap };
    }

    // Add custom panels for the selected agent
    Object.keys(customPanels).forEach(node => {
      const panelData = customPanels[node];
      if (panelData && panelData.factory === selectedModel) {
        availableNodes.push(node);
        newNodeTypeMap[node] = 'custom';
      }
    });

    // Add factory models for the selected agent
    if (factoryModels[selectedModel as keyof typeof factoryModels]) {
      const nodes = factoryModels[selectedModel as keyof typeof factoryModels];
      nodes.forEach(node => {
        // Skip if custom panel already exists with same name (custom panels take priority)
        if (!newNodeTypeMap[node]) {
          availableNodes.push(node);
          newNodeTypeMap[node] = 'factory';
        }
      });
    }

    return { availableNodes, nodeTypeMap: newNodeTypeMap };
  }, [selectedModel, factoryModels, customPanels, nodesMeta]);


  const handleImport = () => {
    if (selectedModel && selectedNode) {
      let nodeMeta: NodeMeta = {};
      let nodeType = selectedNode;
      
      const nodeTypeFromMap = computedNodeTypeMap[selectedNode];
      // Builtin nodes (source === 'builtin') are never custom panels even if they have a panel field
      const isBuiltin = nodesMeta?.[selectedNode]?.source === 'builtin';
      const isCustomPanel = nodeTypeFromMap === 'custom' && !isBuiltin;

      if (isCustomPanel && customPanels[selectedNode]) {
        const customPanel = customPanels[selectedNode];
        // Use description from nodesMeta if available, otherwise fallback to default
        const metaFromNodes = nodesMeta?.[selectedNode] || {};
        nodeMeta = {
          displayName: customPanel.title,
          description: metaFromNodes.description || `Custom panel for ${selectedNode}`,
          ui: customPanel.ui
        };
        nodeType = customPanel.type || selectedNode;
      } else {
        nodeMeta = nodesMeta?.[selectedNode] || {};
      }

      onImport({
        model: selectedModel,
        input: "",
        nodeType: nodeType,
        ui: nodeMeta?.ui || null,
        customNodeKey: isCustomPanel ? selectedNode : undefined,
        panel: !isCustomPanel ? (nodesMeta?.[selectedNode]?.panel ?? null) : null,
        displayName: nodeMeta?.displayName,
      })
      setOpen(false)
      setSelectedModel("")
      setSelectedNode("")
    }
  }

  const agentKeys = useMemo(
    () => [FREQUENT_CATEGORY_KEY, ...Object.keys(factoryModels)],
    [factoryModels]
  );
  const resolveCategoryName = (key: string) =>
    key === FREQUENT_CATEGORY_KEY ? FREQUENT_CATEGORY_LABEL : (categoryNames[key] || key);

  // Reset selection state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedModel("")
      setSelectedNode("")
    }
  }, [open]);

  // Auto-select first agent when dialog opens
  useEffect(() => {
    if (open && agentKeys.length > 0 && !selectedModel) {
      setSelectedModel(agentKeys[0]);
    }
  }, [open, agentKeys, selectedModel]);

  const handleTriggerClick = () => {
    // Check if current path is in sample directory
    if (isPublicReadOnlyPath(currentPath ?? "")) {
      setShowWarning(true);
      return;
    }
    // Reset selection state, default to first agent if available
    setSelectedNode("");
    if (agentKeys.length > 0) {
      setSelectedModel(agentKeys[0]);
    } else {
      setSelectedModel("");
    }
    setOpen(true);
  };

  // Expose open method via ref if provided
  React.useImperativeHandle(triggerRef, () => ({
    open: handleTriggerClick
  }), [currentPath, agentKeys]);

  return (

    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          className="flex items-center w-full"
          onClick={(e) => {
            e.preventDefault();
            handleTriggerClick();
          }}
        >
          <Plus className="h-4 w-4" />
          Import Existing Model
        </Button>
      </DialogTrigger>
      <DialogContent
        className="pt-4 pb-3 px-4 gap-0 font-sans sm:max-w-[1200px] h-[600px] flex flex-col">
        <DialogHeader className="pb-2">
          <DialogTitle className="text-base">Import Existing Model</DialogTitle>
        </DialogHeader>

        {/* Three-column layout */}
        <div className="flex flex-1 gap-3 min-h-0">
          {/* Left column: Category list */}
          <div className="w-40 flex-shrink-0 flex flex-col border-r border-border pr-2">
            <div className="flex flex-col gap-0.5 overflow-y-auto scrollbar-hide">
              {agentKeys.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedModel(key)}
                  className={`px-2 py-1.5 text-xs rounded-[4px] text-left transition-colors duration-200 ${
                    selectedModel === key
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'bg-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                  }`}
                >
                  {resolveCategoryName(key)}
                </button>
              ))}
            </div>
          </div>

          {/* Middle column: Model cards grid */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
              <span>{resolveCategoryName(selectedModel)}</span>
              {selectedModel && (
                <span className="text-xs text-muted-foreground font-normal">
                  ({availableNodes.length} {availableNodes.length === 1 ? 'model' : 'models'})
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-hide">
              {availableNodes.length === 0 && (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                  No models available for this category.
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                {availableNodes.map((node: string) => {
                  const nodeType = computedNodeTypeMap[node] || 'factory';
                  const isCustomPanel = nodeType === 'custom';

                  const effectiveType = isCustomPanel && customPanels[node]
                    ? (customPanels[node].type || node)
                    : node;
                  const ONCE_ONLY_TYPES = new Set(['MuskEmbedding', 'MuskClassification', 'VISTA']);
                  const isAlreadyImported =
                    ONCE_ONLY_TYPES.has(effectiveType) &&
                    (existingPanelTypes?.includes(effectiveType) ?? false);

                  const exists = !isAlreadyImported && Object.prototype.hasOwnProperty.call(runningNodes, node);
                  const isRunning = exists ? !!runningNodes[node] : false;
                  const isActivating = activatingNodes.has(node);

                  let nodeMeta: NodeMeta = {};
                  if (isCustomPanel && customPanels[node]) {
                    const metaFromNodes = nodesMeta?.[node] || {};
                    nodeMeta = {
                      displayName: customPanels[node].title,
                      description: metaFromNodes.description || `Custom panel for ${node}`,
                      icon: metaFromNodes.icon
                    };
                  } else {
                    nodeMeta = nodesMeta?.[node] || {};
                  }

                  return (
                    <div
                      key={node}
                      className={`rounded-lg shadow-sm border transition-shadow bg-card cursor-pointer hover:shadow-md ${
                        selectedNode === node ? 'border-primary ring-1 ring-primary/20' : 'border-border'
                      } ${!exists || isActivating ? 'opacity-50' : ''}`}
                      onClick={() => { if (exists && !isActivating) setSelectedNode(node); }}
                      title={isAlreadyImported ? 'Already imported' : (isActivating ? 'Activating... Please wait.' : (!exists ? 'Inactive. Activate in AI Model Zoo first.' : (isRunning ? 'Running' : 'Stopped (registered but not running)')))}
                    >
                      <div className="flex flex-col items-center p-2 gap-1">
                        <div className="flex-shrink-0 h-10 w-10 items-center justify-center rounded-md bg-muted overflow-hidden">
                          {getNodeIcon(node, nodeMeta?.icon)}
                        </div>
                        <div className="text-xs font-medium text-center break-words w-full leading-tight">
                          {nodeMeta?.displayName || node}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Import button at bottom of middle column */}
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                onClick={handleImport}
                disabled={!selectedModel || !selectedNode}
                className="w-full"
              >
                Import Model
              </Button>
            </div>
          </div>

          {/* Right column: Model detail panel */}
          <div className="w-72 flex-shrink-0 flex flex-col border-l border-border pl-3">
            {selectedNode ? (
              <>
                {(() => {
                  const nodeType = computedNodeTypeMap[selectedNode] || 'factory';
                  const isCustomPanel = nodeType === 'custom';
                  let nodeMeta: NodeMeta = {};
                  if (isCustomPanel && customPanels[selectedNode]) {
                    const metaFromNodes = nodesMeta?.[selectedNode] || {};
                    nodeMeta = {
                      displayName: customPanels[selectedNode].title,
                      description: metaFromNodes.description || `Custom panel for ${selectedNode}`,
                      icon: metaFromNodes.icon
                    };
                  } else {
                    nodeMeta = nodesMeta?.[selectedNode] || {};
                  }
                  const meta = isCustomPanel ? customPanels[selectedNode] : (nodesMeta?.[selectedNode] || {});

                  return (
                    <div className="flex flex-col gap-2.5 h-full overflow-y-auto scrollbar-hide">
                      {/* Title */}
                      <h3 className="text-sm font-semibold">{nodeMeta?.displayName || selectedNode}</h3>

                      {/* Rating section - placeholder */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Rate:</span>
                        <div className="flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <span key={star} className="text-muted-foreground/30 text-sm">★</span>
                          ))}
                        </div>
                        <span className="text-[10px] text-muted-foreground ml-auto">No rating yet</span>
                      </div>

                      {/* Description section */}
                      <div>
                        <div className="text-xs font-medium mb-0.5 text-muted-foreground">Description:</div>
                        <div className="text-xs text-foreground/80 leading-relaxed">
                          {nodeMeta?.description || getNodeDescription(selectedNode, nodesMeta)}
                        </div>
                      </div>

                      {/* Associated classifier count - placeholder */}
                      <div>
                        <div className="text-xs font-medium mb-0.5 text-muted-foreground">Associated classifiers:</div>
                        <div className="text-xs text-foreground/80">
                          {meta?.outputs ? (meta.outputs.toString().match(/\d+/) || ['0'])[0] : 'N/A'}
                        </div>
                      </div>

                      {/* Tutorial section - placeholder */}
                      <div>
                        <div className="text-xs font-medium mb-0.5 text-muted-foreground">Watch tutorial:</div>
                        <div className="aspect-video bg-muted rounded-md flex items-center justify-center border border-border">
                          <div className="flex flex-col items-center gap-1 text-muted-foreground">
                            <div className="w-8 h-8 rounded-full bg-muted-foreground/10 flex items-center justify-center">
                              <span className="text-base">▶</span>
                            </div>
                            <div className="text-[10px]">Tutorial coming soon</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select a model to view details
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Warning dialog for sample directory if user try to add AI analysis in workflow for sample data*/}
    <AlertDialog open={showWarning} onOpenChange={setShowWarning}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sample Data is Read-Only</AlertDialogTitle>
          <AlertDialogDescription>
            To run analysis, please copy it to your <strong>Personal</strong> folder first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}