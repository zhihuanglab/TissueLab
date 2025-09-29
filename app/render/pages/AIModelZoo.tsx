"use client";
import React, { useState, useEffect, useRef } from 'react'
import styles from "@/styles/AIModelZoo.module.css"
import CustomNodeDialog from '@/components/AgentZoo/CustomNodeDialog'
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config'
import http from '@/utils/http';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { panelMap } from '@/components/ImageViewer/Sidebar/Chat/Workflow/constants'
import { Settings, SquareTerminal} from 'lucide-react'
import NodeLogsDialog from '@/components/AgentZoo/NodeLogsDialog'
import { toast } from 'sonner'
import { Progress } from '@/components/ui/progress'

const AIModelZoo = () => {
  const [categories, setCategories] = useState<Record<string, string[]>>({});
  const [nodeInfo, setNodeInfo] = useState<Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }>>({});
  const [activateOpen, setActivateOpen] = useState(false);
  const [activateFactory, setActivateFactory] = useState<string>('');
  const [activateNode, setActivateNode] = useState<string>('');
  const [servicePath, setServicePath] = useState('');
  const [envName, setEnvName] = useState('');
  const [envOptions, setEnvOptions] = useState<string[]>([]);
  const [port, setPort] = useState('');
  const [desc, setDesc] = useState('');
  const [activating, setActivating] = useState(false);
  const [nodesExtended, setNodesExtended] = useState<Record<string, any>>({});
  const [categoryDisplayNames, setCategoryDisplayNames] = useState<Record<string, string>>({});
  // Track per-node busy state to block rapid clicks and show loading
  const [busy, setBusy] = useState<Record<string, 'activating' | 'deactivating'>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  // Logs modal state
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsTarget, setLogsTarget] = useState<{ node: string; path: string; env?: string; port?: number } | null>(null);
  // Optional explicit status to communicate SSE progress ('starting' | 'ready' | 'failed')
  const [activationStatus, setActivationStatus] = useState<Record<string, 'starting' | 'ready' | 'failed'>>({});
  // Store failure metadata for logs button on failed state
  const [failedMeta, setFailedMeta] = useState<Record<string, { logPath?: string; env?: string; port?: number; message?: string }>>({});
  

  const fetchFactories = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_factory_models`);
      const data = resp.data;
      if (data.code === 0) setCategories(data.data || {});
    } catch (e) { console.error(e); }
  };

  const fetchRunning = async (): Promise<Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }>> => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`);
      const data = resp.data;
      const nodes = data?.data?.nodes || {};
      const info: Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }> = {};
      Object.entries(nodes).forEach(([name, meta]: any) => {
        info[name] = { running: !!meta?.running, envName: meta?.env_name, port: meta?.port, logPath: meta?.log_path };
      });
      setNodeInfo(info);
      return info;
    } catch (e) { console.error(e); return {}; }
  };

  const fetchNodesExtended = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`);
      const data = resp.data;
      // shape: { nodes, category_map, category_display_names }
      const nodes = data?.data?.nodes || {};
      const catMap = data?.data?.category_map || {};
      const catNames = data?.data?.category_display_names || {};
      if (Object.keys(catMap).length) setCategories(catMap);
      setNodesExtended(nodes);
      setCategoryDisplayNames(catNames);
    } catch (e) { console.error(e); }
  };

  const fetchBundlesCatalog = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/catalog`);
      const data = resp.data;
      return (data?.data?.bundles || []) as Array<any>;
    } catch (e) { console.error(e); return []; }
  };

  // Download progress toast handling
  const downloadToastIdRef = useRef<string | null>(null);
  const downloadStateRef = useRef<{ received: number; total: number; url?: string }>({ received: 0, total: 0 });
  useEffect(() => {
    const handler = (payload: any) => {
      try {
        if (!payload) return;
        const { state, receivedBytes, totalBytes, url, filePath } = payload || {};
        if (state === 'progressing') {
          downloadStateRef.current = { received: receivedBytes || 0, total: totalBytes || 0, url };
          const percent = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
          const content = (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>Downloading bundle...</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{Math.floor((receivedBytes || 0) / (1024 * 1024))} MB / {Math.max(1, Math.floor((totalBytes || 0) / (1024 * 1024)))} MB</div>
              <Progress value={percent} />
            </div>
          );
          if (downloadToastIdRef.current) {
            toast.custom(() => content, { id: downloadToastIdRef.current, duration: Infinity, position: 'bottom-center' } as any);
          } else {
            const id = Math.random().toString(36).slice(2);
            downloadToastIdRef.current = id;
            toast.custom(() => content, { id, duration: Infinity, position: 'bottom-center' } as any);
          }
        }
        if (state === 'completed') {
          const id = downloadToastIdRef.current;
          if (id) toast.dismiss(id);
          downloadToastIdRef.current = null;
          toast.success('Download completed', { description: filePath ? `Saved to: ${filePath}` : undefined } as any);
        }
        if (state === 'interrupted' || state === 'cancelled' || state === 'failed') {
          const id = downloadToastIdRef.current;
          if (id) toast.dismiss(id);
          downloadToastIdRef.current = null;
          toast.error('Download interrupted');
        }
      } catch {}
    };
    (window as any).electron?.on?.('download-progress', handler);
    return () => {
      try { (window as any).electron?.off?.('download-progress', handler); } catch {}
    };
  }, []);

  // Install modal state
  const [installOpen, setInstallOpen] = useState(false);
  const [installSteps, setInstallSteps] = useState<Array<{ key: string; label: string; status: 'pending'|'active'|'done'|'failed'; meta?: any }>>([]);
  const [installId, setInstallId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState({ percent: 0, text: '' });
  const installEventSrc = useRef<EventSource | null>(null);
  const [installing, setInstalling] = useState(false);

  const openInstallModal = () => setInstallOpen(true);
  const closeInstallModal = () => setInstallOpen(false);

  const resetInstallUI = () => {
    setInstallSteps([
      { key: 'sign', label: 'Authenticate', status: 'pending' },
      { key: 'download', label: 'Download tasknode', status: 'pending' },
      { key: 'verify', label: 'Verify tasknode', status: 'pending' },
      { key: 'unpack', label: 'Unpack to storage', status: 'pending' },
      { key: 'persist', label: 'Persist tasknode', status: 'pending' },
      { key: 'activate', label: 'Activate tasknode', status: 'pending' },
      { key: 'ready', label: 'Ready', status: 'pending' },
    ]);
  };

  const updateStepStatus = (key: string, status: 'pending'|'active'|'done'|'failed') => {
    setInstallSteps(prev => prev.map(s => s.key === key ? { ...s, status } : s));
  };

  const startInstall = async (bundle: any) => {
    try {
      if (installing) {
        toast.info('Another installation is already in progress');
        return;
      }
      setInstalling(true);
      resetInstallUI();
      openInstallModal();
      toast.info(`Installing ${bundle.display_name || bundle.model_name}`, {
        duration: Infinity,
        action: {
          label: 'View details',
          onClick: () => setInstallOpen(true),
        }
      } as any);
      const body = {
        model_name: bundle.model_name,
        gcs_uri: bundle.gcs_uri,
        filename: bundle.filename,
        entry_relative_path: bundle.entry_relative_path,
        size_bytes: bundle.size_bytes || null,
        sha256: bundle.sha256 || null,
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install`, body);
      const data = resp.data;
      if (data?.code !== 0) {
        toast.error('Failed to start install', { description: data?.message || 'Unknown error' } as any);
        return;
      }
      const id = data?.data?.install_id as string;
      setInstallId(id);
      // Subscribe SSE
      if (installEventSrc.current) { try { installEventSrc.current.close(); } catch {} installEventSrc.current = null; }
      const es = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install/events?install_id=${encodeURIComponent(id)}`);
      installEventSrc.current = es;
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          const step = payload?.step as string | undefined;
          const status = payload?.status as string | undefined;
          const rcv = Number(payload?.received_bytes || 0);
          const tot = Number(payload?.total_bytes || 0);
          if (step) {
            // set all previous steps to done until current active
            const order = ['sign','download','verify','unpack','persist','activate','ready'];
            setInstallSteps(prev => prev.map(s => {
              const si = order.indexOf(s.key);
              const ci = order.indexOf(step);
              if (si < ci) return { ...s, status: s.status === 'failed' ? 'failed' : 'done' };
              if (s.key === step) return { ...s, status: status === 'failed' ? 'failed' : (status === 'done' ? 'done' : 'active') };
              return s;
            }));
          }
          if (step === 'download' && tot > 0) {
            const pct = Math.floor((rcv / tot) * 100);
            setInstallProgress({ percent: pct, text: `${Math.floor(rcv/1048576)} / ${Math.floor(tot/1048576)} MB` });
          }
          if (status === 'done') {
            toast.success('Installation complete');
            // refresh node info to reflect activation
            fetchRunning();
            fetchNodesExtended();
            setInstalling(false);
            es.close();
            installEventSrc.current = null;
          }
          if (status === 'failed') {
            toast.error('Installation failed', { description: payload?.message || 'Unknown error' } as any);
            setInstalling(false);
            es.close();
            installEventSrc.current = null;
          }
        } catch {}
      };
      es.onerror = () => { try { es.close(); } catch {}; installEventSrc.current = null; setInstalling(false); };
    } catch (e) {
      console.error(e);
      toast.error('Failed to start install');
      setInstalling(false);
    }
  };

  useEffect(() => {
    fetchFactories();
    fetchRunning();
    fetchNodesExtended();
    fetchBundlesCatalog();
    // fetch conda envs
    (async () => {
      try {
        const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_conda_envs`);
        const data = resp.data;
        const envs = data?.data?.envs || [];
        setEnvOptions(envs);
      } catch (e) { console.error(e); }
    })();
  }, []);

  // Activation SSE subscriptions (per-node)
  const activationStreams = useRef<Record<string, EventSource | null>>({});

  const subscribeActivation = (nodeName: string) => {
    try {
      // Close existing stream if any
      const existing = activationStreams.current[nodeName];
      if (existing) {
        try { existing.close(); } catch {}
        delete activationStreams.current[nodeName];
      }
      const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/activation/events?model=${encodeURIComponent(nodeName)}`;
      const es = new EventSource(url);
      activationStreams.current[nodeName] = es;
      es.onmessage = async (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          const status = payload?.status;
          const data = payload?.data || {};
          console.log('[AIModelZoo] activation SSE', nodeName, status, data);
          if (status === 'starting') {
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'starting' }));
          }
          if (status === 'failed') {
            // show toast with logs when available
            const logPath = data?.log_path;
            toast.error(`Activation failed for ${nodeName}`, {
              description: data?.message || 'Registration failed. Check setup logs.',
              action: logPath ? {
                label: 'View logs',
                onClick: () => {
                  setLogsTarget({ node: nodeName, path: logPath, env: data?.env_name, port: data?.port });
                  setLogsOpen(true);
                }
              } : undefined,
            } as any);
            // refresh UI and clear busy state
            await fetchRunning();
            setBusy((prev) => { const { [nodeName]: _, ...rest } = prev; return rest; });
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'failed' }));
            setFailedMeta((prev) => ({ ...prev, [nodeName]: { logPath, env: data?.env_name, port: data?.port, message: data?.message } }));
            try { es.close(); } catch {}
            delete activationStreams.current[nodeName];
          } else if (status === 'ready') {
            // reflect active state
            await fetchRunning();
            await fetchNodesExtended();
            setBusy((prev) => { const { [nodeName]: _, ...rest } = prev; return rest; });
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'ready' }));
            try { es.close(); } catch {}
            delete activationStreams.current[nodeName];
          }
        } catch {}
      };
      es.onerror = () => {
        // Best effort: close; periodic page interactions will refresh
        try { es.close(); } catch {}
        delete activationStreams.current[nodeName];
      };
    } catch {}
  };

  // Cleanup all streams on unmount
  useEffect(() => {
    return () => {
      Object.values(activationStreams.current).forEach((es) => { try { es?.close(); } catch {} });
      activationStreams.current = {};
    };
  }, []);

  // Derived UI states
  const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
  const isPyService = (servicePath || '').trim().toLowerCase().endsWith('.py');
  const hasServicePath = !!(servicePath || '').trim();

  // Listen for refresh events from CustomNodeDialog
  useEffect(() => {
    const onRefresh = () => {
      fetchFactories();
      fetchNodesExtended();
      fetchRunning();
    };
    window.addEventListener('model-zoo-refresh', onRefresh as any);
    return () => window.removeEventListener('model-zoo-refresh', onRefresh as any);
  }, []);

  const openActivate = (factory: string, node: string) => {
    setActivateFactory(factory);
    setActivateNode(node);
    // Prefill from stored runtime when available
    const runtime = nodesExtended?.[node]?.runtime || {};
    const info = nodeInfo[node];
    setServicePath(runtime?.service_path || '');
    setEnvName(runtime?.env_name || '');
    setPort(runtime?.port ? String(runtime.port) : (info?.port ? String(info.port) : ''));
    setDesc('');
    setActivateOpen(true);
  };

  const handleDownload = async (node: string) => {
    try {
      if (!isElectron) {
        toast.error('Download is only available in the desktop app');
        return;
      }
      const bundles = await fetchBundlesCatalog();
      // naive match: model_name equals node; refine if catalog uses different ids
      const info = await fetchRunning();
      const plat = navigator.userAgent.includes('Mac') ? 'darwin' : (navigator.userAgent.includes('Windows') ? 'win' : 'linux');
      const arch = navigator.userAgent.includes('ARM') || navigator.userAgent.includes('Apple') ? 'arm64' : 'x86_64';
      const entry = bundles.find((b: any) => b?.model_name === node && b?.platform === plat && b?.arch === arch) || bundles.find((b: any) => b?.model_name === node);
      if (!entry?.gcs_uri) {
        toast.error('No bundle available for this node/platform');
        return;
      }
      // Kick off backend installer workflow (includes signing, download, verify, unpack, persist, activate)
      await startInstall(entry);
    } catch (e) {
      console.error(e);
      toast.error('Download failed');
    }
  };

  const quickActivate = async (factory: string, node: string) => {
    // One-click activate using stored runtime; fallback to modal if missing
    const runtime = nodesExtended?.[node]?.runtime || {};
    const sp = runtime?.service_path;
    const env = runtime?.env_name;
    const dep = runtime?.dependency_path || '';
    const py = runtime?.python_version || '3.9';
    const prt = runtime?.port;

    // Only require env or dependency path if the stored service is a Python script
    const isStoredPy = typeof sp === 'string' && sp.trim().toLowerCase().endsWith('.py');
    if (!sp || (isStoredPy && !(env || dep))) {
      openActivate(factory, node);
      return;
    }

    try {
      setActivating(true);
      setBusy((prev) => ({ ...prev, [node]: 'activating' }));
      const body = {
        model_name: node,
        python_version: py,
        service_path: sp,
        dependency_path: dep,
        factory,
        description: undefined,
        env_name: env,
        port: prt,
        install_dependencies: false,
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, body);
      const data = resp.data;
      if (data?.code === 0 && data?.data?.log_path) {
        toast.info(`Starting ${node}...`, {
          description: 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node, path: data.data.log_path, env: data.data.env_name, port: prt || runtime?.port });
              setLogsOpen(true);
            }
          }
        } as any);
      }
      if (data.code === 0) {
        // Subscribe to activation SSE; backend will emit ready/failed
        subscribeActivation(node);
        setActivationStatus((prev) => ({ ...prev, [node]: 'starting' }));
        // Clear old failure metadata on new attempt
        setFailedMeta((prev) => { const { [node]: _, ...rest } = prev; return rest; });
        // Quick nudge
        fetchRunning();
      } else {
        console.error('Activation failed:', data.message);
        // Clear busy immediately on failure
        setBusy((prev) => { const { [node]: _, ...rest } = prev; return rest; });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActivating(false);
    }
  };

  const submitActivate = async () => {
    try {
      setActivating(true);
      setBusy((prev) => ({ ...prev, [activateNode]: 'activating' }));
      setActivateOpen(false);
      const body = {
        model_name: activateNode,
        python_version: '3.9',
        service_path: servicePath,
        dependency_path: '',
        factory: activateFactory,
        description: desc || undefined,
        env_name: envName || undefined,
        port: port ? Number(port) : undefined,
        install_dependencies: false,
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, body);
      const data = resp.data;
      if (data?.code === 0 && data?.data?.log_path) {
        toast.info(`Starting ${activateNode}...`, {
          description: 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node: activateNode, path: data.data.log_path, env: data.data.env_name, port: body.port });
              setLogsOpen(true);
            }
          }
        } as any);
      }
      if (data.code === 0) {
        // Subscribe to activation SSE; backend will emit ready/failed
        subscribeActivation(activateNode);
        setActivationStatus((prev) => ({ ...prev, [activateNode]: 'starting' }));
        // Clear old failure metadata on new attempt
        setFailedMeta((prev) => { const { [activateNode]: _, ...rest } = prev; return rest; });
        // Quick nudge
        fetchRunning();
      } else {
        console.error('Activation failed:', data.message);
        // Clear busy immediately on failure
        setBusy((prev) => { const { [activateNode]: _, ...rest } = prev; return rest; });
      }
    } catch (e) { console.error(e); } finally {
      setActivating(false);
    }
  };

  const stopNode = async (nodeName: string) => {
    try {
      setBusy((prev) => ({ ...prev, [nodeName]: 'deactivating' }));
      // Derive env name: prefer nodeInfo mapping, else runtime env, else fall back to model_name-derived default
      const info = nodeInfo[nodeName];
      const runtime = nodesExtended?.[nodeName]?.runtime || {};
      const derivedEnv = info?.envName || runtime?.env_name || `${nodeName}_tissuelab_ai_service_tasknode`;
      console.log('[AIModelZoo] stop_node_process payload', { env_name: derivedEnv, nodeName, runtime });
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_node_process`, { env_name: derivedEnv });
      const data = resp.data;
      console.log('[AIModelZoo] stop_node_process response', data);
      if (data.code === 0) {
        // Poll until node disappears (backend hides stopped nodes)
        const start = Date.now();
        const timeoutMs = 15000;
        while (Date.now() - start < timeoutMs) {
          const latest = await fetchRunning();
          if (!latest[nodeName]) {
            break;
          }
          await new Promise(res => setTimeout(res, 400));
        }
      } else {
        console.error('Stop failed:', data.message);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy((prev) => {
        const { [nodeName]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const deleteNode = async (nodeName: string) => {
    try {
      setBusy((prev) => ({ ...prev, [nodeName]: 'deactivating' }));
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/delete_node`, { model_name: nodeName });
      const data = resp.data;
      if (data.code === 0) {
        await fetchFactories();
        await fetchNodesExtended();
        await fetchRunning();
      } else {
        console.error('Delete failed:', data.message);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy((prev) => {
        const { [nodeName]: _, ...rest } = prev; return rest;
      });
    }
  };

  return (
    <div className="h-[calc(100vh-66px)] overflow-y-auto">
      <div className={`${styles['ai-model-zoo']} h-full`}>
        <div className={`${styles['model-grid-container']} ${styles['details-hidden']} h-full`}>
          <div className="flex items-center justify-between pb-4">
            <h2 className="zoo-header">AI Model Zoo</h2>
            <CustomNodeDialog/>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {Object.entries(categories).map(([factory, nodes]) => (
              <div key={factory} className="rounded-lg border bg-white p-3">
                <div className="font-semibold mb-2">
                  {categoryDisplayNames[factory] || panelMap[(factory as keyof typeof panelMap)]?.title || factory}
                </div>
                <div className="flex flex-col gap-2">
                  {nodes.map((node) => {
                    const info = nodeInfo[node];
                    const isActive = !!info;
                    const isRunning = !!info?.running;
                    const isStarting = activationStatus[node] === 'starting' && !isRunning;
                    const isBusy = !!busy[node];
                    const stored = nodesExtended?.[node]?.runtime || {};
                    const hasPreset = !!(stored?.service_path || stored?.env_name || stored?.port);
                    const portDisp = info?.port || stored?.port;
                    const initials = node.split(/(?=[A-Z0-9])|[\s_-]/).filter(Boolean).map(w=>w[0]).join('').toUpperCase();
                    return (
                      <div key={node} className="flex items-center justify-between rounded-md border p-2 bg-white">
                        <div className="flex items-center gap-2" style={{opacity: isActive ? 1 : 0.5}}>
                          <span className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-muted text-sm font-medium">
                            {initials}
                          </span>
                          <div className="flex flex-col">
                            <div className="text-sm font-medium">{node}</div>
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${activationStatus[node]==='failed' ? 'bg-red-100 text-red-700' : (isBusy || isStarting ? 'bg-amber-100 text-amber-700' : (isActive ? (isRunning ? 'bg-green-100 text-green-700' : 'bg-green-100 text-green-700') : 'bg-gray-100 text-gray-600'))}`}>
                                {activationStatus[node]==='failed' ? 'Failed' : (isBusy || isStarting ? 'Starting' : (isActive ? (isRunning ? 'Running' : 'Active') : 'Inactive'))}
                              </span>
                              {portDisp ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{`localhost:${portDisp}`}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isBusy ? (
                            <Button variant="outline" size="sm" disabled>
                              Working...
                            </Button>
                          ) : isRunning ? (
                            <>
                              <Button variant="destructive" size="sm" onClick={() => stopNode(node)}>
                                Deactivate
                              </Button>
                              {info?.logPath ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="View Logs"
                                  onClick={() => {
                                    if (!info?.logPath) return;
                                    setLogsTarget({ node, path: info.logPath!, env: info?.envName, port: info?.port });
                                    setLogsOpen(true);
                                  }}
                                >
                                  <SquareTerminal className="h-4 w-4" />
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <div className="flex items-center gap-2">
                              {hasPreset ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    if (activationStatus[node] === 'failed') {
                                      openActivate(factory, node);
                                    } else {
                                      quickActivate(factory, node);
                                    }
                                  }}
                                  disabled={activating || !!busy[node]}
                                >
                                  {busy[node] === 'activating' || activationStatus[node] === 'starting' ? 'Loading...' : 'Activate'}
                                </Button>
                              ) : (
                                isElectron ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDownload(node)}
                                    disabled={!!busy[node] || installing}
                                    title="Download prebuilt bundle"
                                  >
                                    {installing ? 'Installing...' : 'Download'}
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openActivate(factory, node)}
                                    disabled={activating || !!busy[node]}
                                    title="Provide runtime to activate"
                                  >
                                    Activate
                                  </Button>
                                )
                              )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" title="Settings">
                                    <Settings className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  {hasPreset ? (
                                    <DropdownMenuItem onClick={() => openActivate(factory, node)}>
                                      Edit
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem onClick={() => openActivate(factory, node)}>
                                      Activate manually
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem onClick={() => { setConfirmTarget(node); setConfirmOpen(true); }} className="text-red-600 focus:text-red-600">
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          )}
                          {activationStatus[node]==='failed' && failedMeta[node]?.logPath ? (
                            <div className="flex items-center gap-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                title="View Logs"
                                onClick={() => {
                                  const meta = failedMeta[node]!;
                                  setLogsTarget({ node, path: meta.logPath!, env: meta.env, port: meta.port });
                                  setLogsOpen(true);
                                }}
                              >
                                <SquareTerminal className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Activate {activateNode} ({activateFactory})</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-right">Service File <span className="text-red-500">*</span></Label>
                <div className="col-span-3 flex gap-2 items-center">
                  <Input className="flex-1" value={servicePath} onChange={(e)=>setServicePath(e.target.value)} placeholder="Enter .py or binary file path" />
                  <Button type="button" variant="outline" size="sm" onClick={async ()=>{
                    try {
                      const result = await (window as any).electron.invoke('open-file-dialog');
                      if (result?.filePaths?.length) setServicePath(result.filePaths[0]);
                    } catch (e) { console.error(e); }
                  }}>Browse</Button>
                </div>
              </div>
              <div className={`transition-all duration-300 overflow-hidden ${isPyService ? 'max-h-32 mt-2' : 'max-h-0 hidden'}`}>
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right">Conda Env <span className="text-red-500">*</span></Label>
                  <div className="col-span-3">
                    <Select value={envName} onValueChange={setEnvName}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select existing env" />
                      </SelectTrigger>
                      <SelectContent>
                        {envOptions.map((n) => (
                          <SelectItem key={n} value={n}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <div className={`transition-all duration-300 overflow-hidden ${hasServicePath ? 'max-h-20 opacity-100 mt-2' : 'max-h-0 opacity-0'}`}>
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right">Port</Label>
                  <Input className="col-span-3" value={port} onChange={(e)=>setPort(e.target.value.replace(/[^0-9]/g,''))} placeholder="optional" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button disabled={!servicePath || (isPyService && !envName) || activating} onClick={submitActivate}>
                  {activating ? 'Activating...' : 'Activate'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <NodeLogsDialog
          open={logsOpen}
          onOpenChange={setLogsOpen}
          env={logsTarget?.env}
          port={logsTarget?.port}
          logPath={logsTarget?.path}
          pollMs={2000}
        />

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {confirmTarget}?</DialogTitle>
            </DialogHeader>
            <div className="text-sm text-slate-600">
              This removes the node from the Model Zoo registry. It does not uninstall its Conda environment.
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmTarget(null); }}>Cancel</Button>
              <Button className="bg-red-600 hover:bg-red-700" onClick={async () => {
                if (confirmTarget) {
                  const target = confirmTarget;
                  setConfirmOpen(false);
                  setConfirmTarget(null);
                  await deleteNode(target);
                }
              }}>Delete</Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Install progress modal */}
        <Dialog open={installOpen} onOpenChange={setInstallOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Installing bundle</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative pl-6">
                <div className="absolute left-2 top-1 bottom-1 w-[2px] bg-gray-200" />
                <div className="space-y-3">
                  {installSteps.map((s, idx) => (
                    <div key={s.key} className="relative">
                      {s.status === 'active' && (
                        <div className="absolute -left-[21px] top-[4px] z-10 w-3 h-3 rounded-full bg-blue-500 opacity-60 animate-ping" />
                      )}
                      <div className={`absolute -left-[21px] top-[4px] z-20 w-3 h-3 rounded-full ${s.status === 'done' ? 'bg-gray-600' : s.status === 'active' ? 'bg-blue-500' : s.status === 'failed' ? 'bg-red-500' : 'bg-gray-300'}`} />
                      <div className="text-sm">
                        <span className="font-medium">{s.label}</span>
                        {s.key === 'download' && installProgress.percent > 0 && (
                          <div className="mt-2">
                            <Progress value={installProgress.percent} />
                            <div className="text-xs text-gray-500 mt-1">{installProgress.text}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

export default AIModelZoo
