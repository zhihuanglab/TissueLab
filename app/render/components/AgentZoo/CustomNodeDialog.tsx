"use client";
import React, { useState, useRef, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
 
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from '@/utils/http';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Folder } from "lucide-react"

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
}

interface RegisterCustomNodeResponse {
  code: number;
  data?: {
    status: string;
    model_name: string;
    env_name: string;
    port: number;
    log_path?: string;
  };
  message?: string;
}

async function registerCustomNode(params: RegisterCustomNodeRequest) {
  try {
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, params);
    const data: RegisterCustomNodeResponse = response.data;
    return data;
  } catch (error) {
    console.error('Error registering custom node:', error);
    return { code: 1, message: (error instanceof Error ? error.message : 'Failed to register custom node') } as RegisterCustomNodeResponse;
  }
}

const CustomNodeDialog: React.FC = () => {
	const [open, setOpen] = useState(false)
	const [nodeName, setNodeName] = useState("")
	const [servicePath, setServicePath] = useState("")
	const [dependencyPath, setDependencyPath] = useState("")
	const [factory, setFactory] = useState("TissueClassify")
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [success, setSuccess] = useState<string | null>(null)
	const [pythonVersion, setPythonVersion] = useState("3.9")
  const [description, setDescription] = useState<string>("")
  const [envName, setEnvName] = useState<string>("")
  const [step, setStep] = useState<number>(0)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState<boolean>(false)
  const [logText, setLogText] = useState<string>("")
  const logTimerRef = useRef<any>(null)
  const statusCancelRef = useRef<boolean>(false)
  // I/O specs (optional JSON arrays)
  const [inputsText, setInputsText] = useState<string>("")
  const [outputsText, setOutputsText] = useState<string>("")
  
  // Derived service type
  const lowerPath = (servicePath || '').trim().toLowerCase()
  const isPyService = lowerPath.endsWith('.py')

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
    setLogPath(null)
    setShowLogs(false)
    setStep(0)
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

  const stopLogPolling = () => {
    if (logTimerRef.current) {
      clearInterval(logTimerRef.current)
      logTimerRef.current = null
    }
  }

  const startLogPolling = (path: string) => {
    try {
      setLogPath(path)
      setShowLogs(true)
      stopLogPolling()
      logTimerRef.current = setInterval(async () => {
        try {
          const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/logs/tail?path=${encodeURIComponent(path)}&n=200`)
          const data = resp.data
          const tail = data?.data?.tail || ''
          setLogText(tail)
        } catch (e) {
          // ignore transient errors
        }
      }, 1000)
    } catch {}
  }

	const handleCreate = async () => {
		try {
			setIsLoading(true)
			setError(null)
			setSuccess(null)
			setLogText("")
			setLogPath(null)
			setShowLogs(true)
			setStep(3)
			statusCancelRef.current = false
			const inputsVal = (inputsText || '').trim() || undefined
			const outputsVal = (outputsText || '').trim() || undefined
			
			const result = await registerCustomNode({
				model_name: nodeName,
				python_version: pythonVersion,
				service_path: servicePath,
				dependency_path: dependencyPath,
				factory: factory,
				model: nodeName, // Use nodeName as model for custom nodes
        description: description || undefined,
        env_name: envName || undefined,
        install_dependencies: !!dependencyPath,
        inputs: inputsVal,
        outputs: outputsVal,
			})

			if (result?.data?.log_path) {
				startLogPolling(result.data.log_path)
			}

			if (result.code !== 0) {
				setError(result.message || 'Failed to register custom node')
				return
			}

			// For async start, begin status polling until running
			try {
				const start = Date.now();
				const timeoutMs = 600000; // 10 min for heavy installs
				while (!statusCancelRef.current && (Date.now() - start < timeoutMs)) {
					try {
						const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`);
						const d = resp.data;
						const nodes = d?.data?.nodes || {};
						if (nodes[nodeName]?.running) {
							break;
						}
					} catch {}
					await new Promise(res => setTimeout(res, 1000));
				}
			} catch {}

			setSuccess(`Successfully registered node "${nodeName}"!`)
			// Notify AIModelZoo to refresh
			try { window.dispatchEvent(new CustomEvent('model-zoo-refresh', { detail: { model: nodeName } })) } catch {}

		} catch (error) {
			setError(error instanceof Error ? error.message : 'Failed to register custom node')
		} finally {
			setIsLoading(false)
		}
	}

	return (
		<Dialog modal={false} open={open} onOpenChange={(v)=>{ setOpen(v); if (v) { resetForm() } }}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">Upload New Model</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-[500px] overflow-hidden gap-2">
				<DialogHeader>
					<DialogTitle className="mt-2">Create Custom Node</DialogTitle>
					{step < 3 && (
						<div className="mt-2 flex items-center justify-center gap-1.5 mx-auto">
							{[0, 1, 2].map((i) => (
								<div
									key={i}
									className={`${i <= step ? 'bg-slate-900' : 'bg-slate-300'} h-1.5 w-8 rounded-full`}
								/>
							))}
						</div>
					)}
				</DialogHeader>
				<div className="grid gap-4 py-4">
					{/* Step 1: Basics */}
					{step === 0 && (
						<>
							<div className="grid grid-cols-4 items-center gap-4">
								<Label htmlFor="node-name" className="text-right">Node Name</Label>
								<Input id="node-name" value={nodeName} onChange={(e) => setNodeName(e.target.value)} className="col-span-3" placeholder="Enter node name" />
							</div>
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
						</>
					)}

					{/* Step 2: Environment (only for .py services) */}
					{step === 1 && isPyService && (
						<>
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
							<div className="grid grid-cols-4 items-center gap-4">
								<Label htmlFor="env-name" className="text-right">Conda Env (optional)</Label>
								<Input id="env-name" value={envName} onChange={(e) => setEnvName(e.target.value)} className="col-span-3" placeholder="Leave blank to auto-create env" />
							</div>
						</>
					)}

					{/* Step 3: Categorization */}
					{step === 2 && (
						<>
							<div className="grid grid-cols-4 items-center gap-4">
								<Label htmlFor="factory" className="text-right">Factory</Label>
								<div className="col-span-3">
									<Select value={factory} onValueChange={setFactory}>
										<SelectTrigger><SelectValue placeholder="Select factory type" /></SelectTrigger>
										<SelectContent>
											<SelectItem value="TissueClassify">Tissue Classification</SelectItem>
											<SelectItem value="TissueSeg">Tissue Segmentation</SelectItem>
											<SelectItem value="NucleiSeg">Cell Segmentation + Embedding</SelectItem>
											<SelectItem value="NucleiClassify">Nuclei Classification</SelectItem>
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
						</>
					)}

					{/* Step 4: Creating */}
					{step === 3 && (
						<div className="flex flex-col gap-2">
							<div className="text-sm font-medium">{isPyService ? 'Creating Task Node...' : 'Starting Task Node...'}</div>
							<div className="text-xs text-muted-foreground">{isPyService ? 'Please wait while the environment is prepared and dependencies are installed.' : 'Launching the service binary/spec. This may take a moment.'}</div>
						</div>
					)}

					{error && (<div className="text-red-500 text-sm mt-2">{error}</div>)}
					{success && (<div className="text-green-500 text-sm mt-2">{success}</div>)}
					{/* Logs panel */}
					{(!showLogs && step === 3) && (
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
				</div>
				<div className="flex justify-end items-center">
					<div className="flex gap-2">
						{step > 0 && step < 3 && (
							<Button type="button" variant="outline" onClick={() => setStep(step === 2 ? (isPyService ? 1 : 0) : step - 1)} disabled={isLoading}>Back</Button>
						)}
						{step < 2 && (
							<Button type="button" onClick={() => setStep(step === 0 ? (isPyService ? 1 : 2) : step + 1)} disabled={isLoading || (step === 0 && (!nodeName || !servicePath))}>Next</Button>
						)}
						{step === 2 && (
							<Button type="button" onClick={handleCreate} disabled={!servicePath || !nodeName || isLoading}>{isLoading ? 'Creating...' : 'Create Node'}</Button>
						)}
						{step === 3 && (
							<Button type="button" variant="outline" onClick={() => { resetForm(); setOpen(false) }} disabled={isLoading}>{success ? 'Done' : 'Close'}</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default CustomNodeDialog
