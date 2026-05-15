"use client";
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/router'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft } from "lucide-react"
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Folder } from "lucide-react"
import { VisualSchemaEditorDialog } from "@/components/imageViewer/RightSidebar/Agent/Workflow/VisualSchemaEditorDialog"
import { WorkflowPanel, ContentItem } from "@/store/slices/chat/workflowSlice"

interface RegisterCustomNodeRequest {
  model_name: string;
  python_version: string;
  service_path: string;
  dependency_path: string;
  factory: string;
  model?: string;
  description?: string | null;
  port?: number | null;
  env_name?: string | null;
  install_dependencies?: boolean;
  inputs?: string | null;
  outputs?: string | null;
  is_remote?: boolean;
  remote_host?: string | null;
  mnt_path?: string | null;
}

type RegisterCustomNodeSuccess = {
  status?: string;
  model_name?: string;
  env_name?: string;
  log_path?: string;
  port?: number;
};

async function registerCustomNode(params: RegisterCustomNodeRequest): Promise<RegisterCustomNodeSuccess> {
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, {
    method: 'POST',
    body: JSON.stringify(params),
    returnAxiosFormat: true,
  });
  return response.data as RegisterCustomNodeSuccess;
}

export default function CreateCustomNodePage() {
  const router = useRouter()
  const [nodeName, setNodeName] = useState("")
  const [servicePath, setServicePath] = useState("")
  const [dependencyPath, setDependencyPath] = useState("")
  const [factory, setFactory] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pythonVersion, setPythonVersion] = useState("3.9")
  const [description, setDescription] = useState<string>("")
  const [envName, setEnvName] = useState<string>("")
  const [step, setStep] = useState<number>(0)
  const [enableRemote, setEnableRemote] = useState<boolean>(false)
  const [remoteHost, setRemoteHost] = useState<string>("")
  const [port, setPort] = useState<string>("")
  const [mntPath, setMntPath] = useState<string>("")
  const [showLogs, setShowLogs] = useState<boolean>(false)
  const [logText, setLogText] = useState<string>("")
  const logTimerRef = useRef<any>(null)
  const statusCancelRef = useRef<boolean>(false)
  const [inputsText, setInputsText] = useState<string>("")
  const [outputsText, setOutputsText] = useState<string>("")
  const [createCustomPanel, setCreateCustomPanel] = useState<boolean>(false)
  const [customPanel, setCustomPanel] = useState<WorkflowPanel | null>(null)
  const [latestPanelData, setLatestPanelData] = useState<WorkflowPanel | null>(null)
  const [availableCategories, setAvailableCategories] = useState<Record<string, string[]>>({})
  const [categoryDisplayNames, setCategoryDisplayNames] = useState<Record<string, string>>({})
  
  const lowerPath = (servicePath || '').trim().toLowerCase()
  const isPyService = lowerPath.endsWith('.py')

  const getNodeTypeFromFactory = (factoryValue: string) => {
    if (!factoryValue) return "CustomNode";
    return categoryDisplayNames[factoryValue] || factoryValue;
  }

  const resetForm = () => {
    if (logTimerRef.current) {
      clearInterval(logTimerRef.current)
      logTimerRef.current = null
    }
    statusCancelRef.current = true
    setNodeName("")
    setPythonVersion("3.9")
    setServicePath("")
    setDependencyPath("")
    setDescription("")
    setEnvName("")
    setInputsText("")
    setOutputsText("")
    setError(null)
    setSuccess(null)
    setLogText("")
    setShowLogs(false)
    setStep(0)
    setCreateCustomPanel(false)
    setCustomPanel(null)
    setLatestPanelData(null)
    setNameValidationError(null)
    setIsCheckingName(false)
    setEnableRemote(false)
    setRemoteHost("")
    setPort("")
    setMntPath("")
    const firstCategory = Object.keys(availableCategories)[0] || ""
    setFactory(firstCategory)
  }

  useEffect(() => {
    return () => {
      if (logTimerRef.current) {
        clearInterval(logTimerRef.current)
        logTimerRef.current = null
      }
      statusCancelRef.current = true
    }
  }, [])

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
          method: 'GET',
          returnAxiosFormat: true,
        });
        const data = response.data as {
          category_map?: Record<string, string[]>
          category_display_names?: Record<string, string>
        }
        if (data) {
          setAvailableCategories(data.category_map || {});
          setCategoryDisplayNames(data.category_display_names || {});
        }
      } catch (error) {
        console.error('Error fetching categories:', error);
        setAvailableCategories({});
        setCategoryDisplayNames({});
      }
    };

    fetchCategories();
  }, [])

  useEffect(() => {
    if (Object.keys(availableCategories).length > 0 && !factory) {
      const firstCategory = Object.keys(availableCategories)[0]
      setFactory(firstCategory)
    }
  }, [availableCategories, factory])

  useEffect(() => {
    if (customPanel && factory) {
      const newType = categoryDisplayNames[factory] || factory || "CustomNode"
      // Only update if the type actually changed to avoid infinite loops
      if (customPanel.type !== newType) {
        const updatedPanel = {
          ...customPanel,
          type: newType
        };
        setCustomPanel(updatedPanel);
        setLatestPanelData(updatedPanel);
      }
    }
  }, [factory, categoryDisplayNames]) // Removed customPanel from dependencies

  const [nameValidationError, setNameValidationError] = useState<string | null>(null)
  const [isCheckingName, setIsCheckingName] = useState(false)
  const validationTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current)
    }

    const validateNodeName = async () => {
      if (!nodeName || nodeName.length < 2) {
        setNameValidationError(null)
        setIsCheckingName(false)
        return
      }

      setIsCheckingName(true)
      try {
        const nodeExists = await checkNodeNameExists(nodeName)
        
        if (nodeExists) {
          setNameValidationError(`Node name "${nodeName}" already exists (case-insensitive)`)
        } else {
          if (createCustomPanel && step > 0) {
            const panelExists = await checkCustomPanelExists(nodeName)
            if (panelExists) {
              setNameValidationError(`Custom panel "${nodeName}" already exists (case-insensitive)`)
            } else {
              setNameValidationError(null)
            }
          } else {
            setNameValidationError(null)
          }
        }
      } catch (error) {
        console.error('Validation error:', error)
        setNameValidationError(null)
      } finally {
        setIsCheckingName(false)
      }
    }

    validationTimeoutRef.current = setTimeout(validateNodeName, 500)
    
    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current)
      }
    }
  }, [nodeName, createCustomPanel, step])

  const stopLogPolling = () => {
    if (logTimerRef.current) {
      clearInterval(logTimerRef.current)
      logTimerRef.current = null
    }
  }

  const startLogPolling = (modelName: string) => {
    try {
      setShowLogs(true)
      stopLogPolling()
      logTimerRef.current = setInterval(async () => {
        try {
          const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/logs/tail?model_name=${encodeURIComponent(modelName)}&n=200`, {
            method: 'GET',
            returnAxiosFormat: true,
          })
          const data = resp.data
          const tail = data?.data?.tail || ''
          setLogText(tail)
        } catch (e) {
          // ignore transient errors
        }
      }, 1000)
    } catch {}
  }

  const validateCustomPanel = (panel: WorkflowPanel): string | null => {
    if (!panel.content || panel.content.length === 0) {
      return "Custom panel must have at least one field";
    }

    for (const field of panel.content) {
      if (field.type !== 'tips' && (!field.key || field.key.trim() === '')) {
        return "All fields except tips must have a key. Please fill in all key fields.";
      }
    }

    return null;
  }

  const checkNodeNameExists = async (nodeName: string): Promise<boolean> => {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      const data = response.data as { nodes?: Record<string, unknown> }
      if (data?.nodes) {
        const existingNodeNames = Object.keys(data.nodes);
        return existingNodeNames.some(existingName => 
          existingName.toLowerCase() === nodeName.toLowerCase()
        );
      }
      return false;
    } catch (error) {
      console.error('Error checking node name:', error);
      return false;
    }
  };

  const checkCustomPanelExists = async (nodeName: string): Promise<boolean> => {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_all_panel_configs`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      if (response.data && typeof response.data === 'object') {
        const existingPanelNames = Object.keys(response.data as Record<string, unknown>);
        return existingPanelNames.some(existingName => 
          existingName.toLowerCase() === nodeName.toLowerCase()
        );
      }
      return false;
    } catch (error) {
      return false;
    }
  };

  const handleCreate = async () => {
    try {
      if (createCustomPanel && customPanel) {
        const validationError = validateCustomPanel(customPanel);
        if (validationError) {
          setError(validationError);
          return;
        }
      }

      if (nameValidationError) {
        setError(nameValidationError);
        return;
      }

      setIsLoading(true)
      setError(null)
      setSuccess(null)
      setLogText("")
      setShowLogs(true)
      setStep(4)
      statusCancelRef.current = false
      const inputsVal = (inputsText || '').trim() || undefined
      const outputsVal = (outputsText || '').trim() || undefined
      
      const result = await registerCustomNode({
        model_name: nodeName,
        python_version: pythonVersion,
        service_path: servicePath,
        dependency_path: dependencyPath,
        factory: factory,
        model: nodeName,
        description: description || undefined,
        env_name: envName || undefined,
        install_dependencies: !!dependencyPath,
        inputs: inputsVal,
        outputs: outputsVal,
        // Remote vs local: use is_remote as the single source of truth.
        is_remote: enableRemote,
        remote_host: enableRemote && remoteHost ? remoteHost : undefined,
        port: enableRemote && port ? Number(port) : undefined,
        mnt_path: enableRemote ? mntPath : undefined,
      })

      if (result?.log_path) {
        startLogPolling(nodeName)
      }

      try {
        const start = Date.now();
        const timeoutMs = 600000;
        while (!statusCancelRef.current && (Date.now() - start < timeoutMs)) {
          try {
            const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
              method: 'GET',
              returnAxiosFormat: true,
            });
            const d = payloadFromAxiosAppResponse<{ nodes?: Record<string, { running?: boolean }> }>(resp) ?? {};
            const nodes = d.nodes || {};
            if (nodes[nodeName]?.running) {
              break;
            }
          } catch {}
          await new Promise(res => setTimeout(res, 1000));
        }
      } catch {}

      setSuccess(`Successfully registered node "${nodeName}"!`)
      
      if (createCustomPanel && latestPanelData) {
        try {
          const panelToSave: WorkflowPanel = {
            ...latestPanelData,
            id: nodeName,
            title: latestPanelData.title || nodeName,
            type: getNodeTypeFromFactory(factory),
          };
          
          try {
            const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_panel_config`, {
              method: 'POST',
              body: JSON.stringify({
                model_name: nodeName,
                panel_config: {
                  title: panelToSave.title,
                  panel: panelToSave.content
              }
            }),
            returnAxiosFormat: true,
          });
            
            if (response.data) {
              console.log('Custom panel saved to backend JSON:', response.data);
            }
          } catch (backendError) {
            console.error('Failed to save panel to backend:', backendError);
          }
        } catch (error) {
          console.error('Failed to save custom panel:', error);
        }
      }
      
      try { window.dispatchEvent(new CustomEvent('model-zoo-refresh', { detail: { model: nodeName } })) } catch {}

    } catch (error) {
      setError(getErrorMessage(error, 'Failed to register custom node'))
    } finally {
      setIsLoading(false)
    }
  }

  // Memoize default panel to prevent infinite re-renders
  const defaultPanel = useMemo(() => ({
    id: nodeName,
    title: nodeName || "Custom Panel",
    type: getNodeTypeFromFactory(factory),
    progress: 0,
    content: [
      { key: "", type: "input", value: "" } as ContentItem,
    ],
    ui: null,
  }), [nodeName, factory])

  // Memoize panel prop to prevent ref updates
  const panelProp = useMemo(() => customPanel || defaultPanel, [customPanel, defaultPanel])

  // Stable callback for onSave
  const handlePanelSave = useCallback((updatedPanel: WorkflowPanel) => {
    const updatedPanelWithFactoryType = {
      ...updatedPanel,
      type: getNodeTypeFromFactory(factory)
    };
    setLatestPanelData(updatedPanelWithFactoryType);
    setCustomPanel(updatedPanelWithFactoryType);
  }, [factory])

  return (
    <div className="bg-background">
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-6 max-w-7xl">
        {/* Back Button */}
        <div className="mb-4 sm:mb-6 sticky top-0 z-10 bg-background pt-2 -mt-2 pb-2">
          <button
            onClick={() => router.push('/community?tab=factories')}
            className="flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            <span>Back</span>
          </button>
        </div>

        {/* Page Title */}
        <div className="mb-6 max-w-4xl mx-auto">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground mb-2">Create Custom Node</h1>
          {step < 4 && (
            <div className="mt-4 flex items-center justify-start gap-1.5">
              {(() => {
                // Map actual step to display step (always show 3 steps, skip step 1)
                const getDisplayStep = () => {
                  if (step === 0) return 0; // Step 1: Basics
                  if (step === 1) return 0; // Step 1 (Environment) - don't show as separate step
                  if (step === 2) return 1; // Step 2: Categorization
                  if (step === 3) return 2; // Step 3: Custom Panel Creation
                  return 0;
                };
                const displayStep = getDisplayStep();
                // Always show 3 steps
                return [0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`${i <= displayStep ? 'bg-primary' : 'bg-muted'} h-1.5 w-8 rounded-full transition-colors`}
                  />
                ));
              })()}
            </div>
          )}
        </div>

        {/* Form Content */}
        <div className="space-y-6 max-w-4xl mx-auto">
            {/* Step 1: Basics */}
            {step === 0 && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="node-name" className="text-right">Node Name</Label>
                  <div className="col-span-3">
                    <Input 
                      id="node-name" 
                      value={nodeName} 
                      onChange={(e) => setNodeName(e.target.value)} 
                      className={`${nameValidationError ? 'border-red-500' : ''}`}
                      placeholder="Enter unique node name" 
                    />
                    {nameValidationError && (
                      <div className="text-red-500 text-xs mt-1">{nameValidationError}</div>
                    )}
                    {isCheckingName && (
                      <div className="text-gray-500 text-xs mt-1">Checking name availability...</div>
                    )}
                    {!nameValidationError && !isCheckingName && nodeName && nodeName.length >= 2 && (
                      <div className="text-green-500 text-xs mt-1">✓ Name is available</div>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-4 items-center gap-4 pt-4">
                  <Label className="text-right">Remote Connection</Label>
                  <div className="col-span-3 flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="enable-remote"
                      checked={enableRemote}
                      onChange={(e) => setEnableRemote(e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="enable-remote" className="cursor-pointer">Connect to remote service</Label>
                  </div>
                </div>
                {!enableRemote && (
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="service-path" className="text-right">Service Path</Label>
                    <div className="col-span-3 flex gap-2">
                      <Input id="service-path" value={servicePath} onChange={(e) => setServicePath(e.target.value)} className="flex-1" placeholder="Enter .py or binary file path" />
                      <Button type="button" size="icon" variant="outline" onClick={async () => {
                        try {
                          const result = await (window as any).electron.invoke('open-file-dialog');
                          if (result?.filePaths?.length) setServicePath(result.filePaths[0]);
                        } catch (error) {
                          console.error('Error selecting file:', error);
                        }
                      }}>
                        <Folder className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Environment (only for .py services) */}
            {step === 1 && isPyService && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="dependency-path" className="text-right">Dependency Path</Label>
                  <div className="col-span-3 flex gap-2">
                    <Input id="dependency-path" value={dependencyPath} onChange={(e) => setDependencyPath(e.target.value)} className="flex-1" placeholder="/abs/path/to/requirements.txt (optional)" />
                    <Button type="button" size="icon" variant="outline" onClick={async () => {
                      try {
                        const result = await (window as any).electron.invoke('open-file-dialog');
                        if (result?.filePaths?.length) setDependencyPath(result.filePaths[0]);
                      } catch (error) { console.error('Error selecting file:', error); }
                    }}>
                      <Folder className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="python-version" className="text-right">Python Version</Label>
                  <Select onValueChange={setPythonVersion} value={pythonVersion}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select a Python version" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3.9">3.9</SelectItem>
                      <SelectItem value="3.10">3.10</SelectItem>
                      <SelectItem value="3.11">3.11</SelectItem>
                      <SelectItem value="3.12">3.12</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!enableRemote && (
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="env-name" className="text-right">Conda Env (optional)</Label>
                    <Input id="env-name" value={envName} onChange={(e) => setEnvName(e.target.value)} className="col-span-3" placeholder="Leave blank to auto-create env" />
                  </div>
                )}
                {enableRemote && (
                  <>
                    <div className="grid grid-cols-4 items-center gap-4">
                      <Label htmlFor="remote-host" className="text-right">Remote Host <span className="text-destructive">*</span></Label>
                      <Input 
                        id="remote-host" 
                        value={remoteHost} 
                        onChange={(e) => setRemoteHost(e.target.value)} 
                        className="col-span-3" 
                        placeholder="192.168.1.100 or hostname" 
                      />
                    </div>
                    <div className="grid grid-cols-4 items-center gap-4">
                      <Label htmlFor="port" className="text-right">Port <span className="text-destructive">*</span></Label>
                      <Input 
                        id="port" 
                        value={port} 
                        onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g,''))} 
                        className="col-span-3" 
                        placeholder="required for remote" 
                      />
                    </div>
                    <div className="grid grid-cols-4 items-center gap-4">
                      <Label htmlFor="mnt-path" className="text-right">Mount Path (optional)</Label>
                      <Input 
                        id="mnt-path" 
                        value={mntPath} 
                        onChange={(e) => setMntPath(e.target.value)} 
                        className="col-span-3" 
                        placeholder="/mnt/shared (optional)" 
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Step 3: Categorization & Custom Panel */}
            {step === 2 && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="factory" className="text-right">Factory</Label>
                  <div className="col-span-3">
                    <Select value={factory} onValueChange={setFactory}>
                      <SelectTrigger><SelectValue placeholder="Select factory type" /></SelectTrigger>
                      <SelectContent>
                        {Object.keys(availableCategories).map((categoryKey) => (
                          <SelectItem key={categoryKey} value={categoryKey}>
                            {categoryDisplayNames[categoryKey] || categoryKey}
                          </SelectItem>
                        ))}
                        <SelectItem value="Custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-4 items-start gap-4">
                  <Label htmlFor="description" className="text-right mt-2">Description</Label>
                  <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} className="col-span-3" placeholder="What does this node do?" />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="inputs" className="text-right">Inputs</Label>
                  <Input id="inputs" value={inputsText} onChange={(e) => setInputsText(e.target.value)} className="col-span-3" placeholder="optional" />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="outputs" className="text-right">Outputs</Label>
                  <Input id="outputs" value={outputsText} onChange={(e) => setOutputsText(e.target.value)} className="col-span-3" placeholder="optional" />
                </div>
              </div>
            )}

            {/* Step 4: Custom Panel Creation */}
            {step === 3 && (
              <div className="space-y-4">
                <div className="text-sm font-medium mb-4">Create Custom Panel (Optional)</div>
                <div className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="create-panel"
                      checked={createCustomPanel}
                      onChange={(e) => setCreateCustomPanel(e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="create-panel">Create a custom workflow panel for this node</Label>
                  </div>
                  {createCustomPanel && (
                    <div>
                      <VisualSchemaEditorDialog
                        panel={panelProp}
                        onSave={handlePanelSave}
                        disableNodeTypeEdit={true}
                        inline={true}
                        storageKey="tissuelab_custom_tasknode_panels"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 5: Creating */}
            {step === 4 && (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">{isPyService ? 'Creating Task Node...' : 'Starting Task Node...'}</div>
                <div className="text-xs text-muted-foreground">{isPyService ? 'Please wait while the environment is prepared and dependencies are installed.' : 'Launching the service binary/spec. This may take a moment.'}</div>
              </div>
            )}

            {error && (<div className="text-red-500 text-sm mt-2">{error}</div>)}
            {success && (<div className="text-green-500 text-sm mt-2">{success}</div>)}
            
            {(!showLogs && step === 4) && (
              <div className="mt-3 border rounded bg-slate-50 px-2 py-1 text-xs text-slate-600 flex items-center justify-between">
                <span>Setup Logs hidden</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setShowLogs(true)}>Show</Button>
              </div>
            )}

            {showLogs && (
              <div className="mt-3 border rounded overflow-hidden">
                <div className="px-2 py-1 text-xs bg-slate-900 text-slate-300 flex items-center justify-between">
                  <span>Setup Logs</span>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-300 hover:text-white hover:bg-slate-700" onClick={() => setShowLogs(false)}>Hide</Button>
                  </div>
                </div>
                <div className="bg-slate-950 h-64 overflow-x-auto overflow-y-auto">
                  <div className="inline-block min-w-full w-max">
                    <pre className="m-0 p-2 text-xs font-mono whitespace-pre text-slate-100 leading-5 select-text">
                      {logText || 'Creating task node...'}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end items-center pt-6">
              <div className="flex gap-2">
                {step > 0 && step < 4 && (
                  <Button type="button" variant="outline" onClick={() => {
                    setError(null);
                    setStep(step === 3 ? 2 : (step === 2 ? (isPyService ? 1 : 0) : step - 1));
                  }} disabled={isLoading}>Back</Button>
                )}
                {step < 3 && (
                  <Button type="button" onClick={() => setStep(step === 0 ? (isPyService ? 1 : 2) : step + 1)} disabled={isLoading || (step === 0 && (!nodeName || !servicePath || !!nameValidationError)) || (step === 2 && !factory)}>Next</Button>
                )}
                {step === 3 && (
                  <Button type="button" onClick={handleCreate} disabled={!nodeName || !factory || !!nameValidationError || isLoading || (!enableRemote && !servicePath) || (enableRemote && (!remoteHost || !port))}>{isLoading ? 'Creating...' : 'Create Node'}</Button>
                )}
                {step === 4 && (
                  <Button type="button" variant="outline" onClick={() => { resetForm(); router.push('/community?tab=factories') }} disabled={isLoading}>{success ? 'Done' : 'Close'}</Button>
                )}
              </div>
            </div>
        </div>
      </div>
    </div>
  )
}
