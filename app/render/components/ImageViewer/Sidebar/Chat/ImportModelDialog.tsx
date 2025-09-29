import React, { useState, useEffect } from "react"
import Image from "next/image"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { Label } from "@/components/ui/label"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import http from '@/utils/http';

interface NodesExtendedPayload {
  nodes: Record<string, { displayName?: string; description?: string; icon?: string; factory?: string }>;
  category_map: Record<string, string[]>;
  category_display_names: Record<string, string>;
}

type ImportModelDialogProps = {
  onImport: (modelConfig: { 
    model: string; 
    input: string;
    nodeType: string;
  }) => void
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
    .toUpperCase();
  return (
    <div 
      className="w-full h-full flex items-center justify-center text-white"
      style={{ backgroundColor: '#6352a3' }}
    >
      <div className="w-full h-full flex items-center justify-center p-2 text-center">
        <span className="font-medium">{initials}</span>
      </div>
    </div>
  );
};

const getNodeDescription = (nodeName: string, nodesMeta: Record<string, any>) => 
  nodesMeta?.[nodeName]?.description || `${nodeName} model`;

export const ImportModelDialog: React.FC<ImportModelDialogProps> = ({ onImport }) => {
  const [selectedModel, setSelectedModel] = useState<string>("")
  const [selectedNode, setSelectedNode] = useState<string>("")
  const [open, setOpen] = useState(false)
  const [factoryModels, setFactoryModels] = useState<Record<string, string[]>>({});
  const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});
  const [nodesMeta, setNodesMeta] = useState<Record<string, any>>({});
  const [runningNodes, setRunningNodes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const fetchFactoryModels = async () => {
      try {
        const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`);
        const payload = response.data;
        const data: NodesExtendedPayload = payload?.data || ({} as any);
        setFactoryModels(data?.category_map || {});
        setCategoryNames(data?.category_display_names || {});
        setNodesMeta(data?.nodes || {});
      } catch (error) {
        console.error('Error fetching nodes metadata:', error);
      }
    };

    const fetchNodePorts = async () => {
      try {
        const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`);
        const portsData = resp.data;
        const nodes = portsData?.data?.nodes || {};
        const runningMap: Record<string, boolean> = {};
        Object.keys(nodes).forEach((name) => {
          runningMap[name] = !!nodes[name]?.running;
        });
        setRunningNodes(runningMap);
      } catch (e) {
        console.error('Error fetching node ports:', e);
      }
    };

    fetchFactoryModels();
    fetchNodePorts();
  }, []);

  useEffect(() => {
    setSelectedNode("");
  }, [selectedModel]);  

  const getAvailableNodes = () => {
    if (!selectedModel || !factoryModels[selectedModel as keyof typeof factoryModels]) {
      return [];
    }
    const nodes = factoryModels[selectedModel as keyof typeof factoryModels];
    return nodes;
  };

  const handleImport = () => {
    if (selectedModel && selectedNode) {
      onImport({
        model: selectedModel,
        input: "",
        nodeType: selectedNode,
      })
      setOpen(false)
      setSelectedModel("")
      setSelectedNode("")
    }
  }

  let modalExpanded = selectedModel && getAvailableNodes().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="flex items-center">
          <Plus className="h-4 w-4 mr-2" />
          Import Existing Model
        </Button>
      </DialogTrigger>
      <DialogContent className={`pt-[24px] pb-[10px] px-[10px] transition-all duration-200 gap-0 ${
        modalExpanded 
          ? 'sm:max-w-[800px]' 
          : 'sm:max-w-[425px]'
      }`}>
        <DialogHeader>
          <DialogTitle>Import Existing Model</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className={`grid ${modalExpanded ? 'grid-cols-10' : 'grid-cols-4'} items-center gap-4`}>
            <Label htmlFor="model-select" className="text-right">
              Agent
            </Label>
            <Select
              value={selectedModel}
              onValueChange={setSelectedModel}
            >
              <SelectTrigger id="model-select" className={`${modalExpanded ? 'col-span-9' : 'col-span-3'}`}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(factoryModels).map(([key]) => (
                  <SelectItem key={key} value={key}>
                    {categoryNames[key] || key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          {modalExpanded && (
            <div className="grid grid-cols-10 items-start gap-4">
              <Label className="text-right">Model</Label>
              <div className="col-span-9 flex flex-col gap-[12px] h-[260px] overflow-y-auto overflow-x-hidden scrollbar-hide shadow-md border rounded-xl p-[12px] bg-neutral-50/50">
                {getAvailableNodes().map((node: string) => {
                  const exists = Object.prototype.hasOwnProperty.call(runningNodes, node);
                  const isRunning = exists ? !!runningNodes[node] : false;
                  return (
                    <div
                      key={node}
                      className={`rounded-xl shadow-sm border transition-shadow bg-white ${
                        selectedNode === node ? 'outline outline-panelColor' : 'outline-border'
                      } ${!exists ? 'opacity-50' : ''} cursor-pointer hover:shadow-lg`}
                      onClick={() => { setSelectedNode(node); }}
                      title={!exists ? 'Inactive. Activate in AI Model Zoo first.' : (isRunning ? 'Running' : 'Stopped (registered)')}
                    >
                      <div className="flex items-start gap-3 p-3">
                        <div className="flex-shrink-0 h-16 w-16 items-center justify-center rounded-md bg-muted overflow-hidden">
                          {getNodeIcon(node, nodesMeta?.[node]?.icon)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-normal font-medium break-words flex items-center gap-2">
                            <span>{nodesMeta?.[node]?.displayName || node}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${!exists ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
                              {!exists ? 'Inactive' : 'Active'}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground font-light break-words">{getNodeDescription(node, nodesMeta)}</div>
                          {/* I/O under description */}
                          {(() => {
                            const meta = nodesMeta?.[node] || {};
                            const inText = (meta?.inputs || '').toString().trim();
                            const outText = (meta?.outputs || '').toString().trim();
                            if (!inText && !outText) return null;
                            return (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {inText && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">Consumes: {inText}</span>
                                )}
                                {outText && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">Produces: {outText}</span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            onClick={handleImport}
            disabled={!selectedModel || !selectedNode}
          >
            Import Model
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}