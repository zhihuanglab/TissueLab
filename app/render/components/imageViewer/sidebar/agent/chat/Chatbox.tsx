import type React from "react"
import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Search, ExternalLink, Globe, Brain, Zap, Bot, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/utils/common/twMerge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useDispatch, useSelector } from "react-redux"
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { RootState, AppDispatch } from "@/store"
import { useUserInfo } from "@/contexts/UserInfoProvider"
import { formatPath } from "@/utils/common/path.utils"
import useRootStore from "@/store/zustand/store"

import {LoadingMessage} from "@/components/imageViewer/sidebar/agent/chat/LoadingMessage";
import { CodePreview } from "@/components/imageViewer/sidebar/agent/chat/CodePreview";
import { ReasoningWidget } from "@/components/imageViewer/sidebar/agent/chat/ReasoningWidget";
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { apiFetch } from '@/utils/common/apiFetch';
import eventBus from "@/utils/common/eventBus";
import {addMessage, setIsGenerating, clearMessages} from "@/store/slices/chat/chatSlice"
import { setSelectedAgent, type AgentName } from "@/store/slices/chat/agentSlice"
import { resetWorkflow, initPanelsFromWorkflow } from "@/store/slices/chat/workflowSlice"

// Workflow preview types
type WorkflowPreviewStep = {
  step: number
  model: string
  impl?: string | null
  input?: unknown
  prompt?: string
  type?: string
  ui?: Record<string, unknown> | null
}

export type GeneratedWorkflowStep = WorkflowPreviewStep

type WorkflowPreviewMessage = {
  type: "workflow-card"
  steps: WorkflowPreviewStep[]
}

type TextMessage = {
  type: "text" | "welcome"
  content: string
}

type AnnotationContext = {
  annotation_id: string
  layer_type?: "user" | "ai" | "patch"
  label?: string
  class_id?: string
  centroid?: { x: number; y: number }
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
  slide_path?: string
  thumbnail?: string
}

type AnnotationContextMessage = {
  type: "annotation-context"
  annotation: AnnotationContext
}

type ChatMessagePayload = WorkflowPreviewMessage | TextMessage | AnnotationContextMessage | string | null | undefined

type MessageType = {
  id: number
  content: ChatMessagePayload
  sender: string
  type: string
}

// Helper functions
const createTextPayload = (content: string): TextMessage => ({
  type: "text",
  content,
})

const createWorkflowPayload = (steps: WorkflowPreviewStep[]): WorkflowPreviewMessage => ({
  type: "workflow-card",
  steps,
})

const createAnnotationPayload = (annotation: AnnotationContext): AnnotationContextMessage => ({
  type: "annotation-context",
  annotation,
})

const isWorkflowPayload = (payload: ChatMessagePayload): payload is WorkflowPreviewMessage => {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    (payload as WorkflowPreviewMessage).type === "workflow-card" &&
    Array.isArray((payload as WorkflowPreviewMessage).steps)
  )
}

const isTextPayload = (payload: ChatMessagePayload): payload is TextMessage => {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    (payload as TextMessage).type === "text" &&
    typeof (payload as TextMessage).content === "string"
  )
}

const isAnnotationContextPayload = (payload: ChatMessagePayload): payload is AnnotationContextMessage => {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    (payload as AnnotationContextMessage).type === "annotation-context" &&
    typeof (payload as AnnotationContextMessage).annotation === "object"
  )
}

const payloadToString = (payload: ChatMessagePayload): string => {
  if (payload == null) return ""
  if (typeof payload === "string") return payload
  if (isTextPayload(payload)) return payload.content
  if (isWorkflowPayload(payload)) {
    return payload.steps
      .map((step) => `${step.step}. ${step.model}${step.impl ? ` (${step.impl})` : ""}`)
      .join("\n")
  }
  if (isAnnotationContextPayload(payload)) {
    const ann = payload.annotation
    const parts = [
      `Annotation ${ann.annotation_id}`,
      ann.label ? `label=${ann.label}` : "",
      ann.layer_type ? `layer=${ann.layer_type}` : "",
    ].filter(Boolean)
    return parts.join(" | ")
  }
  if (typeof payload === "object" && "content" in payload && typeof (payload as any).content === "string") {
    return String((payload as any).content)
  }
  return ""
}

// The backend's model registry sometimes labels the coding-agent category
// "CodeAgent"; normalize to the canonical "CodingAgent" used throughout the UI.
const AGENT_NAME_ALIASES: Record<string, string> = { CodeAgent: "CodingAgent" }
const normalizeAgentName = (v: unknown): unknown =>
  typeof v === "string" && AGENT_NAME_ALIASES[v] ? AGENT_NAME_ALIASES[v] : v

const parseWorkflowSteps = (responseData: any): any[] => {
  let steps: any[] = []
  if (Array.isArray(responseData)) steps = responseData
  else if (Array.isArray(responseData?.data)) steps = responseData.data
  else if (Array.isArray(responseData?.steps)) steps = responseData.steps
  return steps.map((step) =>
    step && typeof step === "object"
      ? { ...step, model: normalizeAgentName(step.model), impl: normalizeAgentName(step.impl) }
      : step
  )
}

type ChatboxProps = {
  onWorkflowClick?: () => void
  afterWorkflowCardApply?: () => void
  onWorkflowGenerated?: (steps: GeneratedWorkflowStep[], formattedPath: string) => void
}

export const Chatbox: React.FC<ChatboxProps> = ({ onWorkflowClick = () => {} }) => {
  
  const dispatch = useDispatch<AppDispatch>();
  const messages = useSelector((state: RootState) => state.chat.messages);
  const isGenerating = useSelector((state: RootState) => state.chat.isGenerating);
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent);

  const workflowPanels = useSelector((state: RootState) => state.workflow.panels);
  const isWorkflowRunning = useSelector((state: RootState) => state.workflow.isRunning);
  // Get the current path for formatting
  const currentPath = useActiveSlidePath();
  // Get the workflow output path (the .zarr file)
  const workflowOutputPath = useSelector((state: RootState) => state.workflow.outputPath);
  // Slide info (for mpp)
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);
  // Avatar and profile from global state
  const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl)
  const preferredName = useSelector((state: RootState) => state.user.preferredName)
  const { userInfo } = useUserInfo()
  
  // const [messages, setMessages] = useState<MessageType[]>([])f
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode] = useState<"qa" | "workflow">("workflow")
  const [answerReceived, setAnswerReceived] = useState<boolean>(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(false);
  // Push freshly-planned steps into the WorkflowGraph via the zustand bridge.
  const queueWorkflowFromChatCard = useRootStore((s) => s.queueWorkflowFromChatCard)
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const answerReceivedRef = useRef<boolean>(answerReceived);
  const [showWelcomeTyping, setShowWelcomeTyping] = useState(false);
  const [pendingWelcomeAnim, setPendingWelcomeAnim] = useState(false);
  type ThinkingStatus = 'pending' | 'active' | 'done';
  type ThinkingStage = { key: string; label: string; status: ThinkingStatus };
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingStages, setThinkingStages] = useState<ThinkingStage[]>([]);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState<'none' | 'medium' | 'high'>('medium');

  const presetQuestions = [
    { text: "Please calculate the number of tumor cells in this slide?", enableWebSearch: false },
    { text: "Help me to calculate the ratio of tumor vs. lymphocytes in this breast cancer tissue.", enableWebSearch: false },
    { text: "Please calculate the number of kidney glomerulus in this tissue using ST clustering?", enableWebSearch: false },
    { text: "What is the diagnosis of this lymph node? Is it macrometastasis, micrometastasis, or isolated tumor cells?", enableWebSearch: true },
    { text: "Does this CT scan suggest fatty liver?", enableWebSearch: true },
    { text: "Does this X-ray suggest any Nodule?", enableWebSearch: false },
    { text: "Does this time-series 3D cardiac scan indicate myocardial hypertrophy?", enableWebSearch: true }
  ];
  const welcomeTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const [wfStage, setWfStage] = useState<'init' | 'run' | 'done'>('init');
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);

  const reasoningLabel = reasoningLevel === 'none' ? 'None' : reasoningLevel.charAt(0).toUpperCase() + reasoningLevel.slice(1);

  // Local avatar state: prefer Redux; fallback to localStorage
  const [avatarPreview, setAvatarPreview] = useState<string>("")

  useEffect(() => {
    try {
      if (globalAvatarUrl && globalAvatarUrl !== 'null') {
        setAvatarPreview(globalAvatarUrl)
        return
      }
      const uid = userInfo?.user_id
      if (typeof window !== 'undefined' && uid) {
        const raw = localStorage.getItem(`user_avatar_${uid}`)
        const val = raw && raw !== 'null' ? raw : ''
        setAvatarPreview(val)
      }
    } catch {}
  }, [globalAvatarUrl, userInfo?.user_id])

  useEffect(() => {
    const uid = userInfo?.user_id
    if (typeof window === 'undefined' || !uid) return
    const handleStorageChange = () => {
      try {
        const next = globalAvatarUrl || localStorage.getItem(`user_avatar_${uid}`) || ''
        setAvatarPreview(next && next !== 'null' ? next : '')
      } catch {}
    }
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('localStorageChanged', handleStorageChange as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('localStorageChanged', handleStorageChange as EventListener)
    }
  }, [userInfo?.user_id, globalAvatarUrl])

  const startWelcomeTyping = useCallback((durationMs: number = 2000) => {
    setShowWelcomeTyping(true);
    if (welcomeTimerRef.current) {
      clearTimeout(welcomeTimerRef.current);
      welcomeTimerRef.current = null;
    }
    welcomeTimerRef.current = window.setTimeout(() => {
      setShowWelcomeTyping(false);
      welcomeTimerRef.current = null;
      scrollToBottom();
    }, durationMs);
  }, []);

  const createStage = (key: string, label: string, status: ThinkingStatus): ThinkingStage => ({ key, label, status });

  const initThinking = () => {
    setShowThinking(true);
    setThinkingStages([
      createStage('think', 'Analyzing request…', 'active'),
      createStage('route', 'Selecting agent…', 'pending'),
    ]);
    if (thinkingTimerRef.current) {
      clearTimeout(thinkingTimerRef.current);
      thinkingTimerRef.current = null;
    }
    thinkingTimerRef.current = window.setTimeout(() => {
      setThinkingStages((prev): ThinkingStage[] => prev.map(s => s.key === 'think' ? { ...s, status: 'done' as ThinkingStatus } : s.key === 'route' ? { ...s, status: 'active' as ThinkingStatus } : s));
      thinkingTimerRef.current = null;
    }, 500);
  };

  const setStageActive = (key: string, labelIfMissing?: string) => {
    setThinkingStages((prev): ThinkingStage[] => {
      const exists = prev.some(s => s.key === key);
      const withNew: ThinkingStage[] = exists ? prev : [...prev, createStage(key, labelIfMissing || key, 'pending')];
      return withNew.map(s => s.key === key ? { ...s, status: 'active' as ThinkingStatus } : s);
    });
  };

  const startNewSession = useCallback(async () => {
    dispatch(clearMessages());
    setShowThinking(false);
  }, [dispatch]);

  useEffect(() => {
    const handleAddAnnotationContext = (annotation: AnnotationContext) => {
      if (!annotation || !annotation.annotation_id) return;
      dispatch(addMessage({
        id: Date.now(),
        sender: "user",
        type: "annotation-context",
        content: createAnnotationPayload(annotation),
      }));
    };
    eventBus.on("chat:add-annotation-context", handleAddAnnotationContext);
    return () => {
      eventBus.off("chat:add-annotation-context", handleAddAnnotationContext);
    };
  }, [dispatch]);

  const setStageDone = (key: string) => {
    setThinkingStages((prev): ThinkingStage[] => prev.map(s => s.key === key ? { ...s, status: 'done' as ThinkingStatus } : s));
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    answerReceivedRef.current = answerReceived;
  }, [answerReceived]);

  useEffect(() => {
    if (!isGenerating) return;

    const intervalId = setInterval(async () => {
      try {
        // Only poll when code is being generated, not when workflow is running
        if (isWorkflowRunning) return;
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`, { method: 'GET', returnAxiosFormat: true });
        const data = response.data;
        console.log("Polling get_answer:", data);

        if (!answerReceivedRef.current && (data.data.answer || data.message === "done")) {
          let botMessage: MessageType | undefined;
          const ans = data?.data?.answer;
          if (typeof ans === "string") {
            const looksLikeGeneratedScript = ans.includes('def analyze_medical_image');
            // If the answer is generated code, do not post guidance here; rely on the one-time hint effect
            if (!looksLikeGeneratedScript) {
              botMessage = {
                id: Date.now() + 1,
                content: createTextPayload(ans),
                sender: "bot",
                type: "text" as const,
              };
            }
          } else if (typeof ans === "object") {
            botMessage = {
              id: Date.now() + 1,
              content: createTextPayload(`Here is the response:\n\n${JSON.stringify(ans.execution_result, null, 2)}\n\nPlease review the information above.`),
              sender: "bot",
              type: "text",
            };
          }
          if (botMessage) {
            dispatch(addMessage(botMessage));
          }
          dispatch(setIsGenerating(false));
          setAnswerReceived(true);
          answerReceivedRef.current = true;
          
          // clear workflow
          try {
            await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/clear_workflow`, {
              method: 'POST',
              body: JSON.stringify({}),
              returnAxiosFormat: true,
            });
            console.log("Workflow cleared successfully");
          } catch (clearError) {
            console.error("Error clearing workflow:", clearError);
          }
        }
      } catch (error) {
        console.error("Error polling get_answer:", error);
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, [isGenerating, isWorkflowRunning, dispatch]);

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Prepare welcome animation if not shown this session
  useEffect(() => {
    try {
      const flagged = typeof window !== 'undefined' ? sessionStorage.getItem('tl_welcome_shown') : '1'
      if (!flagged && messages && messages.length > 0 && messages[0]?.type === 'welcome') {
        setPendingWelcomeAnim(true)
      }
    } catch (e) {
      // ignore
    }
  }, [messages])

  // Derive wfStage from nodeStatus map when present (0:not started, 1:running, 2:done)
  useEffect(() => {
    try {
      const statuses = Object.values(nodeStatus || {}) as number[]
      if (!statuses || statuses.length === 0) return
      const allZero = statuses.every(s => s === 0)
      const allDone = statuses.every(s => s === 2)
      if (allZero) {
        setWfStage('init')
      } else if (allDone) {
        setWfStage('done')
      } else {
        setWfStage('run')
      }
    } catch {}
  }, [nodeStatus])

  // Start welcome typing when chat becomes visible the first time
  useEffect(() => {
    if (!pendingWelcomeAnim) return;
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.some(e => e.isIntersecting);
      if (visible) {
        startWelcomeTyping(2000);
        setPendingWelcomeAnim(false);
        try { sessionStorage.setItem('tl_welcome_shown', '1') } catch (e) {}
        obs.disconnect();
      }
    }, { root: null, threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pendingWelcomeAnim, startWelcomeTyping])


  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    // Append user message to chat
    const userMessage: MessageType = {
      id: Date.now(),
      content: createTextPayload(input),
      sender: "user",
      type: "text" as const,
    }
    dispatch(addMessage(userMessage))
    setInput("")
    setIsLoading(true)
    initThinking()

    // Send user input to API and get response
    try {
      // Intelligent routing: ask entrance agent when in workflow mode; otherwise default to QA
      let chosenAction: "qa" | "workflow" | "code" = mode === "workflow" ? "workflow" : "qa";

      if (mode === "workflow") {
        try {
          // Prepare a short history window for routing (exclude the just-typed message if present)
          const historyForRouter = messages
            .filter(m => m.id !== userMessage.id)
            .slice(-8)
            .map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: payloadToString(m.content as ChatMessagePayload) }))

          const entrance = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/entrance_agent`, {
            method: 'POST',
            body: JSON.stringify({
              agent_id: "agent1", 
              prompt: input, 
              parameters: {}, 
              history: historyForRouter
            }),
            returnAxiosFormat: true,
          });
          // apiFetch({ returnAxiosFormat: true }) already unwraps the { code, data }
          // envelope: entrance.data is the payload { need_workflow, label }.
          const entranceData = entrance.data;
          if (entranceData && typeof entranceData === 'object') {
            const label = String(entranceData.label ?? entranceData.data?.label ?? "1").trim();
            if (label === "3") chosenAction = "workflow"; // segmentation/classification
            else if (label === "2") chosenAction = "code"; // code/patch
            else chosenAction = "qa"; // general chat
            // routing complete
            setStageDone('route')
            if (chosenAction === 'workflow') {
              setStageActive('workflow', 'Designing workflow…')
            } else if (chosenAction === 'code') {
              setStageActive('code', 'Generating code…')
            } else {
              setStageActive('reply', 'Composing answer…')
            }
          }
        } catch (e) {
          // Fallback to current mode on router error
          console.warn("Entrance agent failed; falling back to", chosenAction);
          setStageDone('route')
          setStageActive('workflow', 'Designing workflow…')
        }
      }

      if (chosenAction === "qa") {
        const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/chat`, {
          method: 'POST',
          body: JSON.stringify({
            agent_id: "agent1",
            prompt: input,
            parameters: {},
            history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: payloadToString(m.content as ChatMessagePayload) })),
            data_context: {
              zarr_path: workflowOutputPath || formatPath(currentPath ?? ""),
              slide_info: {
                mpp: slideInfo?.mpp
              },
              web_search_enabled: webSearchEnabled
            }
          }),
          returnAxiosFormat: true,
        });
        // apiFetch returns response.data as the unwrapped payload on success.
        const replyPayload: any = response.data;
        setIsLoading(false);
        setStageDone('reply')
        setShowThinking(false)
        const botMessage: MessageType = {
          id: Date.now() + 1,
          content: createTextPayload(replyPayload?.response ?? ""),
          sender: "bot",
          type: "text" as const,
        };
        dispatch(addMessage(botMessage));
        return;
      }

      if (chosenAction === "code") {
        const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/process_script`, {
          method: 'POST',
          body: JSON.stringify({
            agent_id: "agent1",
            prompt: input,
            parameters: {},
            history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: payloadToString(m.content as ChatMessagePayload) })),
            data_context: {
              zarr_path: workflowOutputPath || formatPath(currentPath ?? ""),
              slide_info: {
                mpp: slideInfo?.mpp
              },
              web_search_enabled: webSearchEnabled
            }
          }),
          returnAxiosFormat: true,
        });
        // apiFetch returns response.data as the unwrapped payload (script string) on success.
        const responseData: any = response.data;
        setIsLoading(false);
        setStageDone('code')
        setShowThinking(false)
        {
          const botMessage: MessageType = {
            id: Date.now() + 1,
            content: createTextPayload(`I drafted a script based on your request.\n\n\u0060\u0060\u0060python\n${responseData}\n\u0060\u0060\u0060` as string),
            sender: "bot",
            type: "text" as const,
          };
          dispatch(addMessage(botMessage));
        }
        return;
      }

      // chosenAction === 'workflow'
      let responseData: any
      try {
        responseData = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/get_steps`, {
          method: "POST",
          body: JSON.stringify({
            agent_id: "agent1",
            prompt: input,
            parameters: {},
            history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: payloadToString(m.content as ChatMessagePayload) })),
            data_context: {
              zarr_path: workflowOutputPath || formatPath(currentPath ?? ""),
              slide_info: {
                mpp: slideInfo?.mpp
              },
              web_search_enabled: webSearchEnabled
            }
          }),
        })
      } catch (error: any) {
        const message = typeof error === 'string' ? error : error?.message || 'Failed to fetch workflow steps.'
        setIsLoading(false)
        setStageDone('workflow')
        setShowThinking(false)
        const errorMessage: MessageType = {
          id: Date.now() + 1,
          content: createTextPayload(`An error occurred: ${message}`),
          sender: "bot",
          type: "text" as const,
        }
        dispatch(addMessage(errorMessage))
        return
      }

      console.log(responseData)
      setIsLoading(false)
      setStageDone('workflow')
      setShowThinking(false)

      // apiFetch already unwrapped the envelope and threw on non-zero code,
      // so responseData is the steps array directly.
      const steps: any[] = Array.isArray(responseData) ? responseData : []
      const formattedWorkflow = steps.map((item: { hasOwnProperty: (arg0: string) => any; input: any; impl?: string }) => {
        if (item.hasOwnProperty('input')) {
          return {
            ...item,
            prompt: typeof item.input === "string" ? item.input : "",
            impl: item.impl || undefined
          };
        }
        return item;
      });

      const formattedPath = formatPath(currentPath ?? "");

      // Directly initialize the workflow panels
      dispatch(resetWorkflow()); // Clear existing workflow first
      dispatch(initPanelsFromWorkflow({
        workflow: formattedWorkflow,
        formattedPath
      }));

      // Bridge the steps to the WorkflowGraph so the Agentic AI page rebuilds
      // its node/edge view from the new plan. Without this, the chat-side
      // panels update but the graph stays empty.
      queueWorkflowFromChatCard({
        steps: steps.map((s: any) => ({
          step: Number(s.step),
          model: String(s.model ?? ''),
          impl: s.impl ?? null,
          input: s.input,
          prompt: typeof s.input === 'string' ? s.input : undefined,
        })),
        formattedPath,
      });

      const pipelineSteps: WorkflowPreviewStep[] = steps.map((step: any) => ({
        step: step.step,
        model: step.model,
        impl: step.impl ?? null,
        input: step.input ?? null,
      }));

      // First, send the introduction message
      const introMessage: MessageType = {
        id: Date.now(),
        content: createTextPayload("Here is the pipeline I designed for you:"),
        sender: "bot",
        type: "text" as const,
      };
      dispatch(addMessage(introMessage));

      // Then, send the workflow as a card
      const workflowMessage: MessageType = {
        id: Date.now() + 1,
        content: createWorkflowPayload(pipelineSteps),
        sender: "bot",
        type: "workflow-card" as const,
      };
      dispatch(addMessage(workflowMessage));
    } catch (error: any) {
      console.error('[Chatbox] handleSend failed:', error)
      const detail = error?.message ? `: ${error.message}` : ''
      const errorMessage: MessageType = {
        id: Date.now() + 1,
        content: createTextPayload(`An error occurred while connecting to the server${detail}. Please try again later.`),
        sender: "bot",
        type: "text" as const,
      }
      dispatch(addMessage(errorMessage))
      setShowThinking(false)
    }
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-col h-full bg-background text-foreground">
      {/* Sticky Toolbar */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-3 py-2">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Avatar className="w-6 h-6 bg-muted">
              <AvatarImage
                src="/brand/TissueLab_logo.png"
                alt="TissueLab Bot"
                className="object-contain"
              />
              <AvatarFallback className="bg-foreground text-background">TL</AvatarFallback>
            </Avatar>
            <Select value={selectedAgent} onValueChange={(value: AgentName) => {
              if (value !== selectedAgent) {
                dispatch(setSelectedAgent(value));
                startWelcomeTyping();
                dispatch(clearMessages());
              }
            }}>
              <SelectTrigger className="h-7 w-[170px] border border-border/50 shadow-sm bg-background text-sm font-medium text-foreground hover:bg-muted/50 hover:border-border focus:ring-1 focus:ring-ring">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TLAgent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-muted-foreground hover:bg-muted hover:text-foreground border-border flex items-center gap-1.5"
              onClick={async () => {
                startWelcomeTyping();
                await startNewSession();
              }}
              title="Start a new chat conversation"
              aria-label="New Chat"
            >
              <Plus className="h-4 w-4" />
              <span className="text-sm font-medium">New Chat</span>
            </Button>
          </div>
        </div>
      </div>
      
      <div className="min-h-0 flex-1 overflow-y-auto pb-[104px] scrollbar-hide bg-background">
        <div className="p-3">
          <div className="max-w-4xl mx-auto space-y-4 mb-4">
            {(() => {
              const lastWorkflowMsg = [...messages].reverse().find(m => m.type === 'workflow-card');
              const lastWorkflowId = lastWorkflowMsg?.id;
              return messages
              .filter(m => !(((showWelcomeTyping || pendingWelcomeAnim) && m.type === 'welcome')))
              .map((message) => {
                const isWorkflowCard = message.type === "workflow-card" && isWorkflowPayload(message.content as ChatMessagePayload)
                const isAnnotationContext = message.type === "annotation-context" && isAnnotationContextPayload(message.content as ChatMessagePayload)
                const rawMsg = payloadToString(message.content as ChatMessagePayload)
                const codeMatch = rawMsg.match(/```(\w+)?[\r\n]+([\s\S]*?)```/)
                const lang = codeMatch ? (codeMatch[1] || 'python').toLowerCase() : ''
                const codeBody = codeMatch ? (codeMatch[2] || '') : ''
                return (
                <div key={message.id} className="space-y-2">
              <div
                   className={cn("flex relative", message.sender === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn("flex gap-2 max-w-[85%] min-w-0", message.sender === "user" ? "flex-row-reverse" : "flex-row")}
                >
                  <div className="h-full flex items-end">
                    {message.sender === "bot" ? (
                      <div className="w-8 h-8 shrink-0">
                        <Avatar className="w-8 h-8 bg-muted">
                          <AvatarImage
                            src="/brand/TissueLab_logo.png"
                            alt="TissueLab Bot"
                            className="object-contain"
                          />
                          <AvatarFallback className="bg-foreground text-background">TL</AvatarFallback>
                        </Avatar>
                      </div>
                    ) : (
                      <div className="w-8 h-8 shrink-0">
                        <Avatar className="w-8 h-8">
                          <AvatarImage src={avatarPreview} alt={preferredName || userInfo?.email || 'User'}
                                    className="object-cover"/>
                          <AvatarFallback>{(preferredName || userInfo?.email || 'U').charAt(0).toUpperCase()}</AvatarFallback>
                        </Avatar>
                      </div>
                    )}
                  </div>
                  
                  {message.sender === "user" ? (
                    <div 
                      className="absolute bottom-[0px] right-[25px] overflow-visible pointer-events-none"
                      style={{ transform: 'scaleX(1) scaleY(1)' }}
                    >
                      <svg 
                        aria-hidden="true" 
                        className="h-6" 
                        fill="none" 
                        height="45" 
                        viewBox="0 0 53 45" 
                        width="53" 
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path 
                          className="transition-colors" 
                          d="M44 0H0V0C0 24.8528 20.1472 45 45 45H53V45C47.1396 36.535 44 26.4842 44 16.1886V0Z" 
                          fill="hsl(var(--primary))"
                        />
                      </svg>
                    </div>
                  ) : !isWorkflowCard ? (
                    <div 
                      className="absolute bottom-[1px] left-[25px] overflow-visible pointer-events-none"
                      style={{ transform: 'scaleX(-1) scaleY(1)' }}
                    />
                  ) : null}
                  
                  <div
                    className={cn(
                      "break-words whitespace-pre-wrap overflow-hidden relative select-text min-w-0 max-w-full rounded-xl",
                      message.sender === "user" 
                        ? "bg-primary rounded-3xl px-[14px] pt-[8px] pb-[9px]" 
                        : isWorkflowCard ? "bg-transparent" : "bg-muted border border-border rounded-2xl px-[14px] pt-[8px] pb-[9px]"
                    )}
                  >
                    {isWorkflowCard ? (
                      <div 
                        className="bg-card rounded-xl shadow-md overflow-hidden border border-border max-w-full"
                      >
                        <div className="px-3 py-2 bg-muted border-b border-border flex items-center justify-between">
                          <h3 className="text-sm font-semibold mb-0">Workflow</h3>
                          {message.id === lastWorkflowId ? (
                            <button
                              className="text-primary hover:text-primary/80"
                              title="Apply this plan to the Agentic AI graph"
                              onClick={() => {
                                const payload = message.content as WorkflowPreviewMessage
                                const steps = (payload?.steps ?? []).map((s) => ({
                                  step: Number(s.step),
                                  model: String(s.model ?? ''),
                                  impl: s.impl ?? null,
                                  input: s.input,
                                  prompt: typeof s.input === 'string' ? s.input : undefined,
                                }))
                                if (steps.length > 0) {
                                  queueWorkflowFromChatCard({
                                    steps,
                                    formattedPath: formatPath(currentPath ?? ''),
                                  })
                                }
                                onWorkflowClick()
                              }}
                            >
                              <ExternalLink size={16} />
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Expired</span>
                          )}
                        </div>
                        <div className="px-3 pt-[10px] pb-[12px] flex flex-col gap-2 relative">
                          {/* Vertical timeline line */}
                          <div className="absolute left-[20px] top-[18px] bottom-[18px] w-[1.5px] bg-border" />

                          {(message.content as WorkflowPreviewMessage).steps.map((step, index) => {
                            const values: { key: string; value: string }[] = [];

                            if (step.impl) {
                              values.push({ key: "model", value: step.impl });
                            }

                            if (Array.isArray(step.input) && step.input.length > 0) {
                              const isCodingAgentModel = step.model === "CodingAgent" || step.impl === "CodingAgent";
                              const displayValue = step.input
                                .map(v => {
                                  const str = String(v);
                                  if (isCodingAgentModel) {
                                    // Abbreviate long scripts content
                                    return str.length > 250 ? str.substring(0, 250) + "..." : str;
                                  }
                                  if (str.includes("=")) {
                                    const value = str.substring(str.indexOf("=") + 1).trim();
                                    // Remove surrounding quotes if present (handles various quote types)
                                    return value.replace(/^["'`](.*)["'`]$/, '$1');
                                  }
                                  return str;
                                })
                                .join(", ");
                              values.push({ key: "input", value: displayValue });
                            }

                            const codeClass = 'px-1 py-0.25 rounded bg-muted text-foreground font-mono text-[12px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline';
                            return (
                              <div key={index} className="flex items-start relative z-10 min-w-0">
                                <div className="w-[10px] h-[10px] rounded-full bg-muted-foreground border border-border mt-[5px] mr-3 shrink-0" />
                                <div className="text-sm text-foreground break-words whitespace-pre-wrap min-w-0 max-w-full leading-[1.4]">
                                  <div className="font-semibold text-foreground mb-1">
                                    {`${step.step}. ${step.model}`}
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    {values.length === 0 ? (
                                      <div className="text-xs text-muted-foreground">No parameters</div>
                                    ) : (
                                      values.map(({ key, value }) => (
                                        <div key={key} className="text-xs text-muted-foreground">
                                          <span className="uppercase tracking-wide text-[11px] text-muted-foreground mr-2">{key}</span>
                                          <code className={codeClass}>{value}</code>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : isAnnotationContext ? (
                      <div className={`min-w-[220px] max-w-[340px] ${message.sender === 'user' ? 'text-primary-foreground' : 'text-foreground'}`}>
                        {(() => {
                          const ann = (message.content as AnnotationContextMessage).annotation;
                          return (
                            <div className="space-y-2">
                              <div className="text-xs opacity-90">
                                {`Annotation ${ann.annotation_id}${ann.label ? ` • ${ann.label}` : ''}${ann.layer_type ? ` • ${ann.layer_type}` : ''}`}
                              </div>
                              {ann.thumbnail && (
                                <img
                                  src={ann.thumbnail}
                                  alt={`Annotation ${ann.annotation_id}`}
                                  className="w-full max-h-40 object-cover rounded-md border border-border/50"
                                />
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className={`break-words whitespace-pre-wrap text-sm leading-5 ${message.sender === 'user' ? 'text-primary-foreground' : 'text-foreground'} w-full overflow-hidden`}>
                        {(() => {
                          if (!rawMsg) return null;
                          const fenced = rawMsg.match(/```(\w+)?[\r\n]+([\s\S]*?)```/)
                          if (fenced) {
                            const before = rawMsg.slice(0, fenced.index || 0).trim();
                            return before ? (
                              <div className="whitespace-pre-wrap break-words overflow-hidden">{before}</div>
                            ) : null;
                          }
                          // Highlight file paths like /Users/.../file.zarr or C:\\...\\file.zarr as inline code
                          const PATH_REGEX = /(\/[^\s)]+\.zarr|[A-Za-z]:\\[^\s)]+\.zarr)/g
                          const PATH_EXACT = /^(\/[^^\s)]+\.zarr|[A-Za-z]:\\[^\s)]+\.zarr)$/
                          const codeClass = message.sender === 'user'
                            ? 'px-1 py-0.25 rounded bg-primary/20 text-primary-foreground font-mono text-[13px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline'
                            : 'px-1 py-0.25 rounded bg-muted text-foreground font-mono text-[13px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline'
                          const renderInlineCodes = (text: string) => {
                            const parts = text.split(/(`[^`]+`)/g);
                            return parts.map((seg, i) => {
                              if (seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2) {
                                const inner = seg.slice(1, -1);
                                return <code key={`ic${i}`} className={codeClass}>{inner}</code>;
                              }
                              return <span key={`is${i}`}>{renderBold(seg)}</span>;
                            });
                          };

                          const renderBold = (text: string) => {
                            const parts = text.split(/(\*\*[^*]+\*\*)/g);
                            return parts.map((seg, i) => {
                              if (seg.startsWith('**') && seg.endsWith('**') && seg.length >= 4) {
                                const inner = seg.slice(2, -2);
                                return <strong key={`bold${i}`} className="font-semibold">{inner}</strong>;
                              }
                              return <span key={`text${i}`}>{seg}</span>;
                            });
                          };
                          const renderWithPaths = (text: string) => {
                            const tokens = text.split(PATH_REGEX)
                            return tokens.map((tok, idx) =>
                              PATH_EXACT.test(tok)
                                ? <code key={`p${idx}`} className={codeClass}>{tok}</code>
                                : <span key={`t${idx}`}>{renderInlineCodes(tok)}</span>
                            )
                          }
                          const lines = rawMsg.split('\n');
                          const elements: React.ReactNode[] = [];
                          let currentBullets: string[] = [];

                          const flushBullets = (isFinal: boolean = false) => {
                            if (currentBullets.length === 0) return;
                            elements.push(
                              <ul key={`ul-${elements.length}`} className={`list-disc list-outside space-y-1 whitespace-pre-wrap break-words min-w-0 pl-4 ${isFinal ? 'mb-0' : ''}`}>
                                {currentBullets.map((b, i) => (
                                  <li key={`li-${elements.length}-${i}`} className="break-words whitespace-pre-wrap">{renderWithPaths(b)}</li>
                                ))}
                              </ul>
                            );
                            currentBullets = [];
                          };

                          lines.forEach((line, idx) => {
                            const t = line.trim();
                            if (t.startsWith('## ') && !t.startsWith('### ')) {
                              flushBullets(false);
                              const headerText = t.slice(3);
                              elements.push(
                                <h2 key={`h2-${idx}`} className="text-xl font-bold text-foreground mb-2 mt-5 first:mt-0">{renderWithPaths(headerText)}</h2>
                              );
                            } else if (t.startsWith('### ')) {
                              flushBullets(false);
                              const headerText = t.slice(4);
                              elements.push(
                                <h3 key={`h3-${idx}`} className="text-lg font-semibold text-foreground mb-2 mt-4 first:mt-0">{renderWithPaths(headerText)}</h3>
                              );
                            } else if (t.startsWith('#### ')) {
                              flushBullets(false);
                              const headerText = t.slice(5);
                              elements.push(
                                <h4 key={`h4-${idx}`} className="text-base font-semibold text-foreground mb-1 mt-3 first:mt-0">{renderWithPaths(headerText)}</h4>
                              );
                            } else if (t === '---') {
                              flushBullets(false);
                              elements.push(
                                <hr key={`hr-${idx}`} className="my-4 border-border" />
                              );
                            } else if (t.startsWith('- ')) {
                              currentBullets.push(t.slice(2));
                            } else {
                              flushBullets(false);
                              if (t.length > 0) {
                                elements.push(
                                  <p key={`p-${idx}`} className="whitespace-pre-wrap break-words overflow-hidden mb-0">{renderWithPaths(line)}</p>
                                );
                              }
                            }
                          });
                          flushBullets(true);
                          return <div>{elements}</div>
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {codeMatch && (
                <div className={cn("flex relative", message.sender === "user" ? "justify-end" : "justify-start")}> 
                  <div className={cn("flex gap-2 max-w-[85%] min-w-0", message.sender === "user" ? "flex-row-reverse" : "flex-row")}> 
                    <div className="h-full flex items-start">
                      {message.sender === "bot" ? (
                        <div className="w-8 h-8 shrink-0">
                          <Avatar className="w-8 h-8 bg-muted">
                            <AvatarImage
                              src="/brand/TissueLab_logo.png"
                              alt="TissueLab Bot"
                              className="object-contain"
                            />
                            <AvatarFallback className="bg-foreground text-background">TL</AvatarFallback>
                          </Avatar>
                        </div>
                      ) : (
                        <div className="w-8 h-8 shrink-0">
                          <Avatar className="w-8 h-8">
                            <AvatarImage src={avatarPreview} alt={preferredName || userInfo?.email || 'User'} className="object-cover"/>
                            <AvatarFallback>{(preferredName || userInfo?.email || 'U').charAt(0).toUpperCase()}</AvatarFallback>
                          </Avatar>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <CodePreview code={codeBody} language={lang} />
                    </div>
                  </div>
                </div>
              )}
              </div>
              )
            })
})()}
            {(showWelcomeTyping || pendingWelcomeAnim) && <LoadingMessage></LoadingMessage>}
            {isLoading && showThinking && (
              <ReasoningWidget stages={thinkingStages} />
            )}
            {/* Backend is generating an answer (CodingAgent → summary_answer
                polling) — show the bouncing-dot loading bubble until the
                polling loop posts the final summary message. */}
            {isGenerating && !isLoading && !showWelcomeTyping && !pendingWelcomeAnim && (
              <LoadingMessage></LoadingMessage>
            )}
            {isWorkflowRunning && (
              <ReasoningWidget stages={[
                { key: 'wf-init', label: 'Initialized workflow…', status: wfStage === 'init' ? 'active' : 'done' },
                { key: 'wf-run', label: 'Running workflow…', status: wfStage === 'run' ? 'active' : (wfStage === 'init' ? 'pending' : 'done') },
              ]} />
            )}
            <div ref={messagesEndRef}/>
          </div>
        </div>
      </div>

       {/* Preset Questions */}
       {isInputFocused && input.trim() === "" && (
         <div className="absolute bottom-24 left-1/2 transform -translate-x-1/2 w-96 max-w-[calc(100%-2rem)] z-30">
           <div className="bg-card rounded-lg shadow-lg border border-border overflow-hidden">
             {/* Compact Header */}
             <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-border">
               <Zap className="h-3.5 w-3.5 text-primary" />
               <div className="text-xs text-muted-foreground font-medium">Quick Start</div>
             </div>
             {/* Compact Questions */}
             <div className="max-h-64 overflow-y-auto scrollbar-hide">
               <div className="p-2 space-y-1">
                 {presetQuestions.map((question, idx) => (
                   <button
                     key={idx}
                     type="button"
                     onMouseDown={(e) => {
                       e.preventDefault()
                       setInput(question.text)
                       setWebSearchEnabled(question.enableWebSearch)
                       setIsInputFocused(false)
                     }}
                     className="group w-full text-left px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                   >
                     <div className="flex items-center gap-1.5">
                       <span className="text-primary group-hover:text-primary transition-colors text-xs">→</span>
                       <span className="flex-1 truncate">{question.text}</span>
                       {question.enableWebSearch && (
                         <Globe className="h-3 w-3 text-primary shrink-0" />
                       )}
                     </div>
                   </button>
                 ))}
               </div>
             </div>
           </div>
         </div>
       )}

      <div className="absolute bottom-0 left-0 right-0 bg-card border-t border-border z-20">
        <div className="p-2 h-24 relative">
          {reasoningMenuOpen && (
            <div className="absolute right-2 bottom-24 w-56 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-2">
              <div className="text-xs font-medium text-muted-foreground px-2 pb-1">Reasoning Level</div>
              {[
                { id: 'none', label: 'None', desc: 'Fastest' },
                { id: 'medium', label: 'Medium', desc: 'Balanced depth' },
                { id: 'high', label: 'High', desc: 'Deeper search' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setReasoningLevel(opt.id as typeof reasoningLevel)
                    setReasoningMenuOpen(false)
                  }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 rounded-md hover:bg-muted flex items-center justify-between gap-2",
                    reasoningLevel === opt.id ? "bg-muted" : ""
                  )}
                >
                  <span className="text-sm">{opt.label}</span>
                  <span className="text-[11px] text-muted-foreground">{opt.desc}</span>
                </button>
              ))}
            </div>
          )}
          <form onSubmit={handleSend} className="max-w-4xl mx-auto flex gap-2 h-full">
            <div className="w-full h-full flex flex-col relative rounded-md border border-input bg-transparent shadow-sm">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setTimeout(() => setIsInputFocused(false), 200)}
                placeholder="Type your message..."
                className="h-full min-h-0 resize-none flex-grow border-0 shadow-none overflow-y-auto"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleSend(e)
                  }
                }}
              />
            </div>
            
            <div className="flex flex-col gap-2 h-full">
              <button
                type="button"
                onClick={() => {
                  setReasoningMenuOpen(!reasoningMenuOpen)
                }}
                title={`Reasoning level: ${reasoningLabel}`}
                className={cn(
                  "flex-1 h-9 w-9 rounded-md border transition-colors flex items-center justify-center",
                  reasoningMenuOpen
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-card border-border text-muted-foreground hover:bg-muted"
                )}
              >
                <Brain className={cn("h-4 w-4", reasoningMenuOpen ? "text-primary" : "text-muted-foreground")} />
              </button>
              <Button type="submit" size="icon" className="flex-1 bg-primary hover:bg-primary/90">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
