import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config"
import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { getAuthToken } from '@/utils/common/authToken'
import { Plus } from "lucide-react"
import Image from "next/image"
import { useRouter } from "next/router"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
const FREQUENT_NODE_IDS = ["NuClass", "MuskClassification", "VISTA"];

// Safety-net poll behind the activation SSE stream while the dialog is open.
// Same cadence as the Model Zoo page: every read runs the backend's remote
// health checks, so polling faster would flip busy remote nodes to offline sooner.
const NODE_PORTS_POLL_INTERVAL_MS = 30_000;

type ImportModelDialogProps = {
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
  onImport,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  triggerRef,
  existingPanelTypes,
}) => {
  const [selectedModel, setSelectedModel] = useState<string>("")
  const [selectedNode, setSelectedNode] = useState<string>("")
  const [internalOpen, setInternalOpen] = useState(false)
  
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
  // Node name → backend reports its process as running. Only running nodes can
  // be added; until the first read succeeds none is.
  const [runningNodes, setRunningNodes] = useState<Record<string, boolean>>({ 'GPT-4o Agent': true });
  const [customPanels, setCustomPanels] = useState<Record<string, any>>({});
  const router = useRouter();

  // Several reads can be in flight (mount, open, poll, SSE); only the latest
  // may write, or an older, emptier response overwrites a fresher one.
  const nodePortsSeq = useRef(0);
  const fetchNodePorts = useCallback(async () => {
    const seq = ++nodePortsSeq.current;
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, { method: 'GET', returnAxiosFormat: true });
      const nodes = payloadFromAxiosAppResponse<{ nodes?: Record<string, { running?: boolean; starting?: boolean }> }>(resp)?.nodes;
      if (seq !== nodePortsSeq.current) return;
      if (!nodes || typeof nodes !== 'object') return; // transient: keep the previous snapshot
      const runningMap: Record<string, boolean> = { 'GPT-4o Agent': true };
      Object.keys(nodes).forEach((name) => { runningMap[name] = !!nodes[name]?.running && !nodes[name]?.starting; });
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
    if (open) fetchNodePorts();

    // SSE subscription for activation events (only when dialog is open)
    let es: EventSource | null = null;
    let cancelled = false;
    if (open) {
      void (async () => {
        const token = await getAuthToken();
        if (cancelled || !token) return;
        es = new EventSource(
          `${AI_SERVICE_API_ENDPOINT}/tasks/v1/activation/events?token=${encodeURIComponent(token)}`,
        );
        es.onmessage = (ev) => {
          try {
            const payload = JSON.parse(ev.data || '{}');
            if (payload?.heartbeat === true) return;
            if (payload?.status === 'ready' || payload?.status === 'failed') fetchNodePorts();
          } catch {}
        };
        es.onerror = (error) => {
          console.error('[ImportModelDialog] activation SSE connection error', error);
        };
      })();
    }

    // Listen for model-zoo-refresh events
    const handleRefresh = () => { loadCustomPanels(); fetchNodePorts(); };
    window.addEventListener('model-zoo-refresh', handleRefresh);

    // While open, poll as a safety net: on the viewer page nothing else refreshes
    // the snapshot, and the SSE stream misses some activations (e.g. remote
    // auto-connect at startup). Pause while hidden, catch up when shown again.
    let poll: ReturnType<typeof setInterval> | null = null;
    const handleVisibility = () => { if (!document.hidden) fetchNodePorts(); };
    if (open) {
      poll = setInterval(() => { if (!document.hidden) fetchNodePorts(); }, NODE_PORTS_POLL_INTERVAL_MS);
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      cancelled = true;
      if (es) { try { es.close(); } catch {} }
      if (poll) clearInterval(poll);
      document.removeEventListener('visibilitychange', handleVisibility);
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
  }), [agentKeys]);

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
          <div className="w-40 shrink-0 flex flex-col border-r border-border pr-2">
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

                  const selectable = !isAlreadyImported && runningNodes[node] === true;

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
                      } ${selectable ? '' : 'opacity-50'}`}
                      onClick={() => { if (selectable) setSelectedNode(node); }}
                    >
                      <div className="flex flex-col items-center p-2 gap-1">
                        <div className="shrink-0 h-10 w-10 items-center justify-center rounded-md bg-muted overflow-hidden">
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
          <div className="w-72 shrink-0 flex flex-col border-l border-border pl-3">
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
    </>
  )
}