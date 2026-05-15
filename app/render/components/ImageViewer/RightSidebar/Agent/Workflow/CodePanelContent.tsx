"use client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { upsertContentStringValue } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants";
import type { RootState } from "@/store";
import { setIsGenerating } from "@/store/slices/chat/chatSlice";
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import {
  digestScriptSource,
  getScriptRunPolicy,
  SCRIPT_LAST_RUN_DIGEST_KEY,
  SCRIPT_LAST_RUN_OUTPUT_KEY,
  SCRIPT_LAST_RUN_RAW_OUTPUT_KEY,
  SCRIPT_RUN_POLICY_KEY,
} from "@/utils/workflow/codingAgentPolicy";
import {
  loadCodingAgentGeneratedScript,
  persistCodingAgentGeneratedScript,
} from "@/utils/workflow/persistCodingAgentScript";
import { runCodingAgentScriptChain } from "@/utils/workflow/runCodingAgentScriptChain";
import { formatPath } from "@/utils/pathUtils";
import { getRestrictedDirectoryMessage, isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils";
import { X } from "lucide-react";
import { useTheme } from "next-themes";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "sonner";

const WORKFLOW_PROGRESS_BAR_PX = 18;

type CodePanelContentProps = {
  panel: WorkflowPanel;
  onContentChange: (panelId: string, updated: WorkflowPanel) => void;
  /** When embedded in Workflow Graph, drives canvas “Running…” badge */
  onExecuteStateChange?: (running: boolean) => void;
  /** Workflow Graph bottom pane: no outer card chrome; tab body scrolls inside the pane */
  embedded?: boolean;
  /** Graph runtime: merged node progress 0–100 (embedded only). */
  workflowNodeProgressPct?: number;
  /** True while the workflow engine is executing this node. */
  workflowNodeExecuting?: boolean;
  /** True while execute_script + summary chain is in flight from this panel. */
  scriptChainInFlight?: boolean;
};

export const CodePanelContent: React.FC<CodePanelContentProps> = ({
  panel,
  onContentChange,
  onExecuteStateChange,
  embedded = false,
  workflowNodeProgressPct,
  workflowNodeExecuting = false,
  scriptChainInFlight = false,
}) => {
  const codeItem = panel.content.find((i: any) => i.key === "generated_script");
  const code = (codeItem?.value as string) || "";
  const promptItem = panel.content.find((i: any) => i.key === "prompt");
  const userPrompt = (promptItem?.value as string) || "";
  const policy = getScriptRunPolicy(panel.content as any);

  const [hljsHtml, setHljsHtml] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [outputEditOpen, setOutputEditOpen] = useState(false);
  const [outputEditTarget, setOutputEditTarget] = useState<"raw" | "summary">("raw");
  const [outputDraft, setOutputDraft] = useState("");
  const [draft, setDraft] = useState(code);
  const [runLoading, setRunLoading] = useState(false);
  const [mainTab, setMainTab] = useState<"generate" | "run">("generate");
  const [lastRawOutputText, setLastRawOutputText] = useState<string>("");
  const [lastSummaryOutputText, setLastSummaryOutputText] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const enterSyncRef = useRef<boolean>(false);
  const rawOutputScrollRef = useRef<HTMLDivElement | null>(null);
  const summaryOutputScrollRef = useRef<HTMLDivElement | null>(null);
  const generatedScriptScrollRef = useRef<HTMLDivElement | null>(null);

  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent);
  const dispatch = useDispatch();
  const { theme, systemTheme } = useTheme();

  const getAgentApiVersion = (): "v1" | "v2" => "v1";
  const currentTheme = useMemo(() => (theme === "system" ? systemTheme : theme), [theme, systemTheme]);
  const isDark = currentTheme === "dark";

  const zarrPath = useMemo(() => {
    const p = formatPath(currentPath ?? "");
    if (!p) return "";
    return p.endsWith(".zarr") ? p : `${p}.zarr`;
  }, [currentPath]);

  const rawOutputPersisted = useMemo(() => {
    const it = panel.content.find((i: any) => i.key === SCRIPT_LAST_RUN_RAW_OUTPUT_KEY);
    return typeof it?.value === "string" ? it.value : "";
  }, [panel.content]);

  const summaryOutputPersisted = useMemo(() => {
    const it = panel.content.find((i: any) => i.key === SCRIPT_LAST_RUN_OUTPUT_KEY);
    return typeof it?.value === "string" ? it.value : "";
  }, [panel.content]);

  const rawOutputDisplay = lastRawOutputText || rawOutputPersisted;
  const summaryOutputDisplay = lastSummaryOutputText || summaryOutputPersisted;

  const wfProgressPct = Math.max(0, Math.min(100, workflowNodeProgressPct ?? 0));
  const isWorkflowStepRunning = workflowNodeExecuting || scriptChainInFlight;

  const highlight = (src: string) => {
    try {
      const keywords =
        /(\bdef\b|\breturn\b|\bimport\b|\bfrom\b|\bas\b|\bif\b|\belif\b|\belse\b|\bfor\b|\bwhile\b|\bwith\b|\btry\b|\bexcept\b|\bclass\b)/g;
      const numbers = /(\b\d+(?:\.\d+)?\b)/g;
      const strings = /(["'])(?:\\.|(?!\1).)*\1/g;
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let out = esc(src);
      out = out.replace(numbers, '<span class="text-warning">$1</span>');
      out = out.replace(strings, '<span class="text-success">$&</span>');
      out = out.replace(keywords, '<span class="text-primary">$1</span>');
      return out;
    } catch {
      return src;
    }
  };

  const draftHtml = useMemo(() => {
    try {
      const w = typeof window !== "undefined" ? (window as any) : null;
      if (w?.hljs?.highlight) {
        try {
          const base = w.hljs.highlight(draft, { language: "python" }).value;
          return draft.endsWith("\n") ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>` : base;
        } catch {
          try {
            const base = w.hljs.highlightAuto(draft).value;
            return draft.endsWith("\n") ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>` : base;
          } catch {
            const base = highlight(draft);
            return draft.endsWith("\n") ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>` : base;
          }
        }
      }
    } catch {}
    const base = highlight(draft);
    return draft.endsWith("\n") ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>` : base;
  }, [draft]);

  useLayoutEffect(() => {
    const pre = preRef.current;
    const ta = textareaRef.current;
    if (pre && ta) {
      const codeEl = pre.querySelector("code") as HTMLElement | null;
      if (codeEl) codeEl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
      pre.scrollTop = 0;
      pre.scrollLeft = 0;
      if (enterSyncRef.current) {
        requestAnimationFrame(() => {
          const pre2 = preRef.current;
          const ta2 = textareaRef.current;
          if (pre2 && ta2) {
            const codeEl2 = pre2.querySelector("code") as HTMLElement | null;
            if (codeEl2) codeEl2.style.transform = `translate(${-ta2.scrollLeft}px, ${-ta2.scrollTop}px)`;
            pre2.scrollTop = 0;
            pre2.scrollLeft = 0;
          }
          enterSyncRef.current = false;
        });
      }
    }
  }, [draft]);

  useLayoutEffect(() => {
    if (mainTab !== "run") return;
    const el = rawOutputScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mainTab, rawOutputDisplay, runLoading]);

  useLayoutEffect(() => {
    if (mainTab !== "run") return;
    const el = summaryOutputScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mainTab, summaryOutputDisplay, runLoading]);

  useLayoutEffect(() => {
    if (mainTab !== "generate") return;
    const el = generatedScriptScrollRef.current;
    if (!el || !code.trim()) return;
    el.scrollTop = el.scrollHeight;
  }, [mainTab, code, hljsHtml, isWorkflowStepRunning]);

  useEffect(() => {
    const z = zarrPath.trim();
    const c = code.trim();
    if (typeof window === "undefined" || !z || !c) return;
    persistCodingAgentGeneratedScript(z, c);
  }, [zarrPath, code]);

  useEffect(() => {
    const z = zarrPath.trim();
    if (!z) return;
    if (code.trim()) return;
    const cached = loadCodingAgentGeneratedScript(z).trim();
    if (!cached) return;
    const hasInContent = panel.content.some(
      (i: any) => i.key === "generated_script" && String(i.value ?? "").trim()
    );
    if (hasInContent) return;
    onContentChange(panel.id, {
      ...panel,
      content: [
        ...panel.content.filter((i: any) => i.key !== "generated_script"),
        { key: "generated_script", type: "text", value: cached } as any,
      ],
    });
    // Intentionally zarrPath + node id only; avoids churn when parent passes unstable callbacks.
  }, [zarrPath, panel.id]);

  useEffect(() => {
    if (!code) {
      setHljsHtml(null);
      return;
    }
    const ensureHljs = async () => {
      if (typeof window === "undefined") return;
      const w = window as any;
      const addLink = (id: string, href: string) => {
        const existing = document.getElementById(id) as HTMLLinkElement | null;
        if (existing) {
          if (existing.href !== href) existing.href = href;
          return;
        }
        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
      };
      const addScript = (id: string, src: string) =>
        new Promise<void>((resolve, reject) => {
          if (document.getElementById(id)) {
            resolve();
            return;
          }
          const s = document.createElement("script");
          s.id = id;
          s.src = src;
          s.async = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load " + src));
          document.body.appendChild(s);
        });
      try {
        const themeUrl = isDark
          ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
          : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
        addLink("hljs-theme", themeUrl);
        await addScript("hljs-core", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js");
        if (w.hljs?.highlight) {
          try {
            setHljsHtml(w.hljs.highlight(code, { language: "python" }).value);
          } catch {
            try {
              setHljsHtml(w.hljs.highlightAuto(code).value);
            } catch {
              setHljsHtml(null);
            }
          }
        } else setHljsHtml(null);
      } catch {
        setHljsHtml(null);
      }
    };
    void ensureHljs();
  }, [code, isDark]);

  const handleEditorScroll = () => {
    const pre = preRef.current;
    const ta = textareaRef.current;
    if (pre && ta) {
      const codeEl = pre.querySelector("code") as HTMLElement | null;
      if (codeEl) codeEl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
      pre.scrollTop = 0;
      pre.scrollLeft = 0;
    }
  };

  const writeClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const handleCopy = async () => {
    await writeClipboard(code);
  };

  const setOutputValue = (key: string, value: string) =>
    upsertContentStringValue(panel.content as any, key, value);

  const updateRawOutput = (value: string) => {
    setLastRawOutputText(value);
    const next = setOutputValue(SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, value);
    onContentChange(panel.id, { ...panel, content: next });
  };

  const updateSummaryOutput = (value: string) => {
    setLastSummaryOutputText(value);
    const next = setOutputValue(SCRIPT_LAST_RUN_OUTPUT_KEY, value);
    onContentChange(panel.id, { ...panel, content: next });
  };

  const openOutputEditor = (target: "raw" | "summary") => {
    setOutputEditTarget(target);
    setOutputDraft(target === "raw" ? rawOutputDisplay : summaryOutputDisplay);
    setOutputEditOpen(true);
  };

  const saveOutputEdits = () => {
    if (outputEditTarget === "raw") {
      updateRawOutput(outputDraft);
    } else {
      updateSummaryOutput(outputDraft);
    }
    setOutputEditOpen(false);
  };

  const openEditor = () => {
    setDraft(code);
    setEditOpen(true);
  };
  const saveEdits = () => {
    const existing = panel.content.find((i: any) => i.key === "generated_script");
    const newContent = existing
      ? panel.content.map((i: any) => (i.key === "generated_script" ? { ...i, value: draft } : i))
      : [...panel.content, { key: "generated_script", type: "text", value: draft } as any];
    onContentChange(panel.id, { ...panel, content: newContent });
    setEditOpen(false);
  };

  const setPrompt = (value: string) => {
    const existing = panel.content.find((i: any) => i.key === "prompt");
    const newContent = existing
      ? panel.content.map((i: any) => (i.key === "prompt" ? { ...i, value } : i))
      : [...panel.content, { key: "prompt", type: "input", value } as any];
    onContentChange(panel.id, { ...panel, content: newContent });
  };

  const setPolicy = (value: "auto_bypass" | "require_approval") => {
    const existing = panel.content.find((i: any) => i.key === SCRIPT_RUN_POLICY_KEY);
    const newContent = existing
      ? panel.content.map((i: any) => (i.key === SCRIPT_RUN_POLICY_KEY ? { ...i, value } : i))
      : [...panel.content, { key: SCRIPT_RUN_POLICY_KEY, type: "input", value } as any];
    onContentChange(panel.id, { ...panel, content: newContent });
  };

  const runScriptConfirmed = async () => {
    if (!code || !zarrPath) return;
    if (isPublicReadOnlyPath(currentPath ?? "")) {
      toast.error(getRestrictedDirectoryMessage("run script"));
      return;
    }
    setConfirmOpen(false);
    setRunLoading(true);
    setMainTab("run");
    onExecuteStateChange?.(true);
    try {
      const agentId = "default_agent";
      const res = await runCodingAgentScriptChain({
        code,
        zarrPath,
        userPrompt,
        agentId,
        apiVersion: getAgentApiVersion(),
        dispatch,
      });
      if (res.ok && res.chatBody != null && res.rawOutput != null) {
        const raw = res.rawOutput.trim();
        const summary = res.chatBody.trim();
        setLastRawOutputText(raw);
        setLastSummaryOutputText(summary);
        let next = upsertContentStringValue(panel.content as any, SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, raw);
        next = upsertContentStringValue(next, SCRIPT_LAST_RUN_OUTPUT_KEY, summary);
        next = upsertContentStringValue(next, SCRIPT_LAST_RUN_DIGEST_KEY, digestScriptSource(code));
        onContentChange(panel.id, { ...panel, content: next });
      } else if (!res.ok) {
        const errText = `[${res.stage}:${res.statusCode}] ${res.error || "Run failed."}`;
        setLastRawOutputText(res.rawOutput?.trim() || "");
        setLastSummaryOutputText(errText);
        let next = upsertContentStringValue(panel.content as any, SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, res.rawOutput?.trim() || "");
        next = upsertContentStringValue(next, SCRIPT_LAST_RUN_OUTPUT_KEY, errText);
        onContentChange(panel.id, { ...panel, content: next });
      }
    } catch (e: any) {
      try {
        dispatch(setIsGenerating(false));
      } catch {
        /* ignore */
      }
      const errText = e?.message || String(e);
      setLastRawOutputText("");
      setLastSummaryOutputText(errText);
      let next = upsertContentStringValue(panel.content as any, SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, "");
      next = upsertContentStringValue(next, SCRIPT_LAST_RUN_OUTPUT_KEY, errText);
      onContentChange(panel.id, { ...panel, content: next });
    } finally {
      try {
        dispatch(setIsGenerating(false));
      } catch {
        /* ignore */
      }
      setRunLoading(false);
      onExecuteStateChange?.(false);
    }
  };

  return (
    <div
      className={
        embedded
          ? "flex min-h-0 flex-1 flex-col"
          : "mt-2 overflow-hidden rounded border"
      }
    >
      <Tabs
        value={mainTab}
        onValueChange={(v) => setMainTab(v as "generate" | "run")}
        className={embedded ? "flex min-h-0 flex-1 flex-col" : "flex flex-col"}
      >
        <TabsList
          className={
            embedded
              ? "mx-0 mt-1 flex-shrink-0 grid h-9 w-auto grid-cols-2"
              : "mx-2 mt-2 grid h-9 w-auto grid-cols-2"
          }
        >
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="run">Run</TabsTrigger>
        </TabsList>
        <TabsContent
          value="generate"
          className={
            embedded
              ? // Inactive panel must not stay `display:flex`+`flex-1` or it steals height above the active tab.
                "mt-0 space-y-2 px-3 pb-3 pt-2 data-[state=inactive]:hidden data-[state=active]:flex data-[state=active]:min-h-0 data-[state=active]:flex-1 data-[state=active]:flex-col data-[state=active]:overflow-y-auto"
              : "mt-0 space-y-2 p-3"
          }
        >
          <div className="space-y-1">
            <Label className="text-xs">Prompt</Label>
            <Textarea
              className="min-h-[72px] text-xs"
              value={userPrompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the analysis…"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Script execution</Label>
            <Select value={policy} onValueChange={(v) => setPolicy(v as "auto_bypass" | "require_approval")}>
              <SelectTrigger className={`h-8 text-xs ${embedded ? "w-full min-w-0" : ""}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto_bypass">Auto-run after generation (default)</SelectItem>
                <SelectItem value="require_approval">Require approval (manual Run)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Auto-run executes the script when the workflow finishes and opens Bot with results.
            </p>
          </div>
          {embedded && typeof workflowNodeProgressPct === "number" && (
            <div className="space-y-1">
              <Label className="text-xs">Workflow progress</Label>
              <div
                className="relative overflow-hidden rounded-md bg-muted"
                style={{ height: WORKFLOW_PROGRESS_BAR_PX }}
              >
                <div
                  className={`h-full transition-all duration-200 ${wfProgressPct >= 100 ? "bg-primary" : "bg-primary/70"}`}
                  style={{ width: `${wfProgressPct}%` }}
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2">
                  <span
                    className={`max-w-full truncate text-[9px] font-medium tabular-nums ${wfProgressPct >= 100 ? "text-white" : "text-foreground/85"}`}
                  >
                    {isWorkflowStepRunning
                      ? "Running…"
                      : wfProgressPct >= 100
                        ? "Processed"
                        : wfProgressPct > 0
                          ? `${wfProgressPct}%`
                          : "Pending"}
                  </span>
                </div>
              </div>
            </div>
          )}
          <div className={embedded ? "flex min-h-0 flex-1 flex-col space-y-1" : "space-y-1"}>
            <div className="flex flex-shrink-0 items-center justify-between gap-2">
              <Label className="text-xs">Generated script</Label>
              <div className="flex flex-shrink-0 gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={openEditor}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={handleCopy}>
                  Copy
                </Button>
              </div>
            </div>
            <div
              ref={generatedScriptScrollRef}
              className={
                embedded
                  ? "min-h-[120px] flex-1 overflow-auto rounded border border-border bg-background p-2"
                  : "max-h-80 min-h-[120px] overflow-auto rounded border border-border bg-background p-2"
              }
            >
              {hljsHtml ? (
                <pre
                  className="hljs m-0 whitespace-pre p-1 text-xs leading-5"
                  dangerouslySetInnerHTML={{ __html: hljsHtml }}
                />
              ) : (
                <pre
                  className="m-0 whitespace-pre p-1 text-xs leading-5 text-foreground"
                  dangerouslySetInnerHTML={{ __html: highlight(code) }}
                />
              )}
              {!code && <div className="text-xs italic text-muted-foreground">No script yet — run workflow to generate.</div>}
            </div>
          </div>
        </TabsContent>
        <TabsContent
          value="run"
          className={
            embedded
              ? "mt-0 space-y-2 px-3 pb-3 pt-2 data-[state=inactive]:hidden data-[state=active]:flex data-[state=active]:min-h-0 data-[state=active]:flex-1 data-[state=active]:flex-col data-[state=active]:overflow-y-auto"
              : "mt-0 space-y-2 p-3"
          }
        >
          <div className="rounded border border-border bg-muted/30 p-2 text-[10px] text-muted-foreground">
            Zarr:{" "}
            <span className={`font-mono text-foreground ${embedded ? "break-all" : ""}`}>{zarrPath || "—"}</span>
          </div>
          <div className="flex justify-center border-t border-border/50 pt-2">
            <Button
              className="h-8 px-4"
              onClick={() => setConfirmOpen(true)}
              disabled={!code || !zarrPath || runLoading}
            >
              {runLoading ? "Running…" : "Run code"}
            </Button>
          </div>
          <div className={embedded ? "mt-1 flex min-h-0 flex-1 flex-col gap-3" : "mt-1 space-y-3"}>
            <div className="rounded-md border border-border/70 bg-muted/20 p-2">
              <div className="flex flex-shrink-0 items-center justify-between gap-2">
                <Label className="text-xs">Summary output</Label>
                <div className="flex flex-shrink-0 gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => openOutputEditor("summary")}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => void writeClipboard(summaryOutputDisplay)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <div
                ref={summaryOutputScrollRef}
                className={
                  embedded
                    ? "mt-2 min-h-[84px] flex-1 overflow-auto rounded border border-border bg-background p-2 text-xs"
                    : "max-h-56 min-h-[72px] overflow-auto rounded border border-border bg-background p-2 text-xs"
                }
              >
                {runLoading ? (
                  <span className="text-muted-foreground">Running…</span>
                ) : summaryOutputDisplay ? (
                  <pre className="m-0 whitespace-pre-wrap break-words font-sans">{summaryOutputDisplay}</pre>
                ) : (
                  <span className="text-muted-foreground italic">
                    Summary from the agent (same text as Bot chat) appears here after a successful run.
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-md border border-border/70 bg-muted/20 p-2">
              <div className="flex flex-shrink-0 items-center justify-between gap-2">
                <Label className="text-xs">Raw output</Label>
                <div className="flex flex-shrink-0 gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => openOutputEditor("raw")}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => void writeClipboard(rawOutputDisplay)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <div
                ref={rawOutputScrollRef}
                className={
                  embedded
                    ? "mt-2 min-h-[84px] flex-1 overflow-auto rounded border border-border bg-background p-2 text-xs"
                    : "max-h-56 min-h-[72px] overflow-auto rounded border border-border bg-background p-2 text-xs"
                }
              >
                {runLoading ? (
                  <span className="text-muted-foreground">Running…</span>
                ) : rawOutputDisplay ? (
                  <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">{rawOutputDisplay}</pre>
                ) : (
                  <span className="text-muted-foreground italic">
                    Execute script output from the server appears here (JSON or text).
                  </span>
                )}
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run this script?</AlertDialogTitle>
            <AlertDialogDescription>
              Executes on the current zarr (~60s limit). Agent summary and raw execution output are shown under Run;
              the summary is also posted to Bot chat. If execution fails, the sidebar switches to Bot with details and
              how to regenerate the script.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runScriptConfirmed()}>Run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="h-[88vh] max-w-[1400px] border-0 bg-card p-0 text-foreground shadow-none ring-0 outline-none focus:outline-none sm:rounded-lg sm:w-[92vw] [&>button]:hidden">
          <div className="flex h-full flex-col">
            <div className="flex h-11 items-center justify-between border-b border-border bg-card px-3">
              <div className="text-xs uppercase tracking-wide text-foreground">Python Editor</div>
              <div className="flex items-center gap-3">
                <div className="hidden text-[10px] text-muted-foreground sm:block">Esc to close</div>
                <button
                  type="button"
                  aria-label="Close"
                  className="-m-2 rounded-md p-2 hover:bg-muted focus:outline-none"
                  onClick={() => setEditOpen(false)}
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-background p-3">
              <pre
                ref={preRef}
                className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre p-3 font-mono text-xs leading-5"
                style={{
                  lineHeight: "20px",
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  tabSize: 4,
                }}
              >
                <code
                  className="hljs inline-block min-w-full text-foreground"
                  style={{
                    background: "transparent",
                    padding: 0,
                    margin: 0,
                    lineHeight: "20px",
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    tabSize: 4,
                  }}
                  dangerouslySetInnerHTML={{ __html: draftHtml }}
                />
              </pre>
              <textarea
                ref={textareaRef}
                className="absolute inset-0 z-10 h-full w-full resize-none overflow-auto border-0 bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary selection:text-primary-foreground"
                wrap="off"
                style={{
                  whiteSpace: "pre",
                  overflowWrap: "normal",
                  wordBreak: "normal",
                  lineHeight: "20px",
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  tabSize: 4,
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onScroll={handleEditorScroll}
                onKeyDown={(e) => {
                  if (e.key === "Enter") enterSyncRef.current = true;
                }}
                spellCheck={false}
              />
            </div>
            <div className="flex h-12 items-center justify-end gap-2 border-t border-border bg-card px-2">
              <Button variant="secondary" className="bg-muted text-foreground hover:bg-muted/80" onClick={() => setEditOpen(false)}>
                Discard
              </Button>
              <Button onClick={saveEdits}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={outputEditOpen} onOpenChange={setOutputEditOpen}>
        <DialogContent className="max-w-3xl">
          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground">
              Edit {outputEditTarget === "raw" ? "Raw output" : "Summary output"}
            </div>
            <Textarea
              className="min-h-[55vh] resize-y font-mono text-xs leading-5"
              value={outputDraft}
              onChange={(e) => setOutputDraft(e.target.value)}
              spellCheck={false}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setOutputEditOpen(false)}>
                Cancel
              </Button>
              <Button onClick={saveOutputEdits}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
