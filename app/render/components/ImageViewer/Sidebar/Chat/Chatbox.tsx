import type React from "react"
import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Plus, Upload, Save, Loader2, ExternalLink, Check, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/utils/twMerge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useDispatch, useSelector } from "react-redux"
import { RootState, AppDispatch } from "@/store"
import { useUserInfo } from "@/provider/UserInfoProvider"
import { formatPath } from "@/utils/pathUtils"

import {LoadingMessage} from "@/components/ImageViewer/Sidebar/Chat/LoadingMessage";
import { CodePreview } from "@/components/ImageViewer/Sidebar/Chat/CodePreview";
import { ReasoningWidget } from "@/components/ImageViewer/Sidebar/Chat/ReasoningWidget";
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/apiFetch';
import http from '@/utils/http';
import {addMessage, setIsGenerating, clearMessages} from "@/store/slices/chatSlice"
import { resetWorkflow, initPanelsFromWorkflow } from "@/store/slices/workflowSlice"

type MessageType = {
  id: number
  content: string
  sender: string
  type: string
}

export const Chatbox: React.FC<{ onWorkflowClick: () => void }> = ({ onWorkflowClick }) => {
  
  const dispatch = useDispatch<AppDispatch>();
  const messages = useSelector((state: RootState) => state.chat.messages);
  const isGenerating = useSelector((state: RootState) => state.chat.isGenerating);
  const workflowPanels = useSelector((state: RootState) => state.workflow.panels);
  const isWorkflowRunning = useSelector((state: RootState) => state.workflow.isRunning);
  // Get the current path for formatting
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  // Slide info (for mpp)
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);
  // Avatar and profile from global state
  const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl)
  const preferredName = useSelector((state: RootState) => state.user.preferredName)
  const { userInfo } = useUserInfo()
  
  // const [messages, setMessages] = useState<MessageType[]>([])f
  const [input, setInput] = useState("")
  const [showToolbox, setShowToolbox] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [mode] = useState<"qa" | "workflow">("workflow")
  const [answerReceived, setAnswerReceived] = useState<boolean>(false);
  const answerReceivedRef = useRef<boolean>(answerReceived);
  const [showWelcomeTyping, setShowWelcomeTyping] = useState(false);
  const [pendingWelcomeAnim, setPendingWelcomeAnim] = useState(false);
  type ThinkingStatus = 'pending' | 'active' | 'done';
  type ThinkingStage = { key: string; label: string; status: ThinkingStatus };
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingStages, setThinkingStages] = useState<ThinkingStage[]>([]);
  const welcomeTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const [wfStage, setWfStage] = useState<'init' | 'run' | 'done'>('init');
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);

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
        const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`);
        const data = response.data;
        console.log("Polling get_answer:", data);

        if (!answerReceivedRef.current && (data.data.answer || data.message === "done")) {
          let botMessage;
          const ans = data?.data?.answer;
          if (typeof ans === "string") {
            const looksLikeGeneratedScript = ans.includes('def analyze_medical_image');
            // If the answer is generated code, do not post guidance here; rely on the one-time hint effect
            if (!looksLikeGeneratedScript) {
              botMessage = {
                id: Date.now() + 1,
                content: ans,
                sender: "bot",
                type: "text" as const,
              };
            }
          } else if (typeof ans === "object") {
            botMessage = {
              id: Date.now() + 1,
              content: `Here is the response:\n\n${JSON.stringify(ans.execution_result, null, 2)}\n\nPlease review the information above.`,
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
            await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/clear_workflow`, {});
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
    const userMessage = {
      id: Date.now(),
      content: input,
      sender: "user",
      type: "text" as const,
    }
    dispatch(addMessage(userMessage))
    setInput("")
    setShowToolbox(false)
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
            .map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content }))

          const entrance = await http.post(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/entrance_agent`, {
            agent_id: "agent1", 
            prompt: input, 
            parameters: {}, 
            history: historyForRouter
          });
          const entranceData = entrance.data;
          if (entranceData?.code === 0) {
            const label = String(entranceData.data?.label || "1").trim();
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
        const response = await http.post(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/chat`, {
          agent_id: "agent1",
          prompt: input,
          parameters: {},
          history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content })),
          data_context: {
            h5_path: formatPath(currentPath ?? ""),
            slide_info: {
              mpp: slideInfo?.mpp
            }
          }
        });
        const responseData = response.data;
        setIsLoading(false);
        setStageDone('reply')
        setShowThinking(false)
        if (responseData.code === 0) {
          const botMessage = {
            id: Date.now() + 1,
            content: responseData.data.response,
            sender: "bot",
            type: "text" as const,
          };
          dispatch(addMessage(botMessage));
        } else {
          const errorMessage = {
            id: Date.now() + 1,
            content: `An error occurred: ${responseData.message}`,
            sender: "bot",
            type: "text" as const,
          };
          dispatch(addMessage(errorMessage));
        }
        return;
      }

      if (chosenAction === "code") {
        const response = await http.post(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/process_script`, {
          agent_id: "agent1",
          prompt: input,
          parameters: {},
          history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content })),
          data_context: {
            h5_path: formatPath(currentPath ?? ""),
            slide_info: {
              mpp: slideInfo?.mpp
            }
          }
        });
        const responseData = response.data;
        setIsLoading(false);
        setStageDone('code')
        setShowThinking(false)
        if (responseData.code === 0) {
          const botMessage = {
            id: Date.now() + 1,
            content: `I drafted a script based on your request.\n\n\u0060\u0060\u0060python\n${responseData.data}\n\u0060\u0060\u0060` as string,
            sender: "bot",
            type: "text" as const,
          };
          dispatch(addMessage(botMessage));
        } else {
          const errorMessage = {
            id: Date.now() + 1,
            content: `An error occurred: ${responseData.message}`,
            sender: "bot",
            type: "text" as const,
          };
          dispatch(addMessage(errorMessage));
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
            history: messages.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content })),
            data_context: {
              h5_path: formatPath(currentPath ?? ""),
              slide_info: {
                mpp: slideInfo?.mpp
              }
            }
          }),
        })
      } catch (error: any) {
        const message = typeof error === 'string' ? error : error?.message || 'Failed to fetch workflow steps.'
        setIsLoading(false)
        setStageDone('workflow')
        setShowThinking(false)
        const errorMessage = {
          id: Date.now() + 1,
          content: `An error occurred: ${message}`,
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

      if (responseData.code === 0) {
        // Handle workflow response (existing code)
        const formattedWorkflow = responseData.data.map((item: { hasOwnProperty: (arg0: string) => any; input: any; impl?: string }) => {
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

        const pipelineSteps = responseData.data
          .map((step: any) => {
            let inputText = "";
        
            if (Array.isArray(step.input)) {
              inputText = step.input.length > 0 ? ` for ${step.input.join(", ")}` : "";
            } else if (typeof step.input === "object" && step.input !== null) {
              const arrayValues = Object.values(step.input)
                .filter(value => Array.isArray(value) && value.length > 0)
                .flat();
        
              inputText = arrayValues.length > 0 ? ` for ${arrayValues.join(", ")}` : "";
            } else if (step.input) {
              inputText = ` for ${step.input}`;
            }
        
            // Combine the step text
            let stepText = `${step.step}. ${step.model}${inputText}`;
            
            // Only add a period if it doesn't already end with one
            if (!stepText.endsWith('.')) {
              stepText += '.';
            }

            return stepText;
          })
          .join("\n");
        
        // First, send the introduction message
        const introMessage = {
          id: Date.now(),
          content: "Here is the pipeline I designed for you:",
          sender: "bot",
          type: "text" as const,
        };
        dispatch(addMessage(introMessage));

        // Then, send the workflow as a card
        const workflowMessage = {
          id: Date.now() + 1,
          content: pipelineSteps,
          sender: "bot",
          type: "workflow-card" as const,
        };
        dispatch(addMessage(workflowMessage));
      } else {
        // Handle error response
        const errorMessage = {
          id: Date.now() + 1,
          content: `An error occurred: ${responseData.message}`,
          sender: "bot",
          type: "text" as const,
        }
        dispatch(addMessage(errorMessage))
      }
    } catch (error) {
      // Handle network or server errors
      const errorMessage = {
        id: Date.now() + 1,
        content: `An error occurred while connecting to the server. Please try again later.`,
        sender: "bot",
        type: "text" as const,
      }
      dispatch(addMessage(errorMessage))
      setShowThinking(false)
    }
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto min-h-[75vh] pb-[70px] scrollbar-hide">
        <div className="p-3">
          <div className="max-w-4xl mx-auto space-y-4 mb-4">
            {(() => {
              const lastWorkflowMsg = [...messages].reverse().find(m => m.type === 'workflow-card');
              const lastWorkflowId = lastWorkflowMsg?.id;
              return messages
              .filter(m => !(((showWelcomeTyping || pendingWelcomeAnim) && m.type === 'welcome')))
              .map((message) => {
                const rawMsg = String(message.content || '')
                const codeMatch = rawMsg.match(/```(\w+)?[\r\n]+([\s\S]*?)```/)
                const lang = codeMatch ? (codeMatch[1] || 'python').toLowerCase() : ''
                const codeBody = codeMatch ? (codeMatch[2] || '') : ''
                return (
                <>
              <div
                   className={cn("flex relative", message.sender === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn("flex gap-2 max-w-[85%] min-w-0", message.sender === "user" ? "flex-row-reverse" : "flex-row")}
                >
                  <div className="h-full flex items-end">
                    {message.sender === "bot" ? (
                      <div className="w-8 h-8 flex-shrink-0">
                        <Avatar className="w-8 h-8 bg-gray-300">
                          <AvatarImage
                            src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Asset%2011%404x-dR5ns5tS5lPGnqUCF4tFmCBgNd2FDq.png"
                            alt="TissueLab Bot"
                            className="object-contain"
                          />
                          <AvatarFallback className="bg-gray-900">TL</AvatarFallback>
                        </Avatar>
                      </div>
                    ) : (
                      <div className="w-8 h-8 flex-shrink-0">
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
                          fill="#6366f1"
                        />
                      </svg>
                    </div>
                  ) : message.type !== "workflow-card" ? (
                    <div 
                      className="absolute bottom-[1px] left-[25px] overflow-visible pointer-events-none"
                      style={{ transform: 'scaleX(-1) scaleY(1)' }}
                    >
                      {/* <svg 
                        aria-hidden="true" 
                        className="h-6" 
                        fill="none" 
                        height="46" 
                        viewBox="0 0 53 46" 
                        width="53" 
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path 
                          className="transition-colors" 
                          d="M44 0.5H0.5V0.5C0.5 24.8528 20.1472 44.5 44.5 44.5H52.5V44.5C46.6396 36.035 43.5 25.9842 43.5 15.6886V0.5Z" 
                          fill="white"
                          stroke="rgb(229, 231, 235)"
                        />
                      </svg> */}
                    </div>
                  ) : null}
                  
                  <div
                    className={cn(
                      "break-words whitespace-pre-wrap overflow-hidden relative select-text min-w-0 max-w-full",
                      message.sender === "user" 
                        ? "bg-indigo-500 rounded-3xl px-[14px] pt-[8px] pb-[9px]" 
                        : message.type === "workflow-card" ? "bg-transparent" : "bg-transparent border-1 rounded-2xl px-[14px] pt-[8px] pb-[9px]"
                    )}
                  >
                    {message.type === "workflow-card" ? (
                      <div 
                        className="bg-white rounded-xl shadow-md overflow-hidden border border-gray-200 max-w-full"
                      >
                        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                          <h3 className="text-sm font-semibold mb-0">Workflow</h3>
                          {message.id === lastWorkflowId ? (
                            <button className="text-blue-500" onClick={onWorkflowClick}>
                              <ExternalLink size={16} />
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">Expired</span>
                          )}
                        </div>
                        <div className="px-3 pt-[10px] pb-[12px] flex flex-col gap-2 relative">
                          {/* Vertical timeline line */}
                          <div className="absolute left-[20px] top-[18px] bottom-[18px] w-[1.5px] bg-gray-200"></div>

                          {message.content.split('\n').map((line, index) => {
                            const stepMatch = line.match(/^(\d+)\.\s+(.+)$/);
                            if (!stepMatch) return null;
                            const rest = stepMatch[2];
                            const [modelPart, inputPartRaw] = rest.split(/\s+for\s+/);
                            const codeClass = 'px-1 py-0.25 rounded bg-gray-100 text-gray-800 font-mono text-[12px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline';
                            const modelEl = (
                              <span className="font-semibold text-gray-900">{(modelPart || '').trim().replace(/\.$/, '')}</span>
                            );
                            let inputEls: React.ReactNode = null;
                            const inputPart = (inputPartRaw || '').trim().replace(/\.$/, '');
                            if (inputPart) {
                              const isScripts = /\b(script|scripts|code calculation)\b/i.test((modelPart || ''));
                              const tokens = isScripts ? [inputPart] : inputPart.split(',').map(t => t.trim()).filter(Boolean);
                              inputEls = (
                                <>
                                  {' for '}
                                  {tokens.map((t, i) => (
                                    <span key={i}>
                                      <code className={codeClass}>{t}</code>
                                      {i < tokens.length - 1 ? ', ' : ''}
                                    </span>
                                  ))}
                                </>
                              );
                            }
                            return (
                              <div key={index} className="flex items-start relative z-10 min-w-0">
                                <div className="w-[10px] h-[10px] rounded-full bg-gray-500 border-1 border-gray-600/60 mt-[5px] mr-3 flex-shrink-0"></div>
                                <div className="text-sm text-gray-700 break-words whitespace-pre-wrap min-w-0 max-w-full leading-[1.4]">
                                  {modelEl}
                                  {inputEls}
                                  {!rest.endsWith('.') ? '.' : ''}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className={`break-words whitespace-pre-wrap text-sm leading-5 ${message.sender === 'user' ? 'text-white' : 'text-black'} w-full overflow-hidden`}>
                        {(() => {
                          const raw: string = message.content || ''
                          const fenced = raw.match(/```(\w+)?[\r\n]+([\s\S]*?)```/)
                          if (fenced) {
                            const lang = (fenced[1] || 'python').toLowerCase()
                            const body = fenced[2] || ''
                            const before = raw.slice(0, fenced.index || 0).trim()
                            return (
                              <>
                                {before && (
                                  <div className="whitespace-pre-wrap break-words overflow-hidden">{before}</div>
                                )}
                              </>
                            )
                          }
                          // Highlight file paths like /Users/.../file.h5 or C:\\...\\file.h5 as inline code
                          const PATH_REGEX = /(\/[^\s)]+\.h5|[A-Za-z]:\\[^\s)]+\.h5)/g
                          const PATH_EXACT = /^(\/[^^\s)]+\.h5|[A-Za-z]:\\[^\s)]+\.h5)$/
                          const codeClass = message.sender === 'user'
                            ? 'px-1 py-0.25 rounded bg-white/20 text-white font-mono text-[13px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline'
                            : 'px-1 py-0.25 rounded bg-gray-100 text-gray-800 font-mono text-[13px] break-words break-all whitespace-pre-wrap inline-block max-w-full align-baseline'
                          const renderInlineCodes = (text: string) => {
                            const parts = text.split(/(`[^`]+`)/g);
                            return parts.map((seg, i) => {
                              if (seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2) {
                                const inner = seg.slice(1, -1);
                                return <code key={`ic${i}`} className={codeClass}>{inner}</code>;
                              }
                              return <span key={`is${i}`}>{seg}</span>;
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
                          const lines = raw.split('\n')
                          const elements: React.ReactNode[] = []
                          let currentBullets: string[] = []
                          const flushBullets = (isFinal: boolean = false) => {
                            if (currentBullets.length > 0) {
                              elements.push(
                                <ul key={`ul-${elements.length}`} className={`list-disc space-y-1 whitespace-pre-wrap break-words overflow-hidden min-w-0 ${isFinal ? 'mb-0' : ''}`}>
                                  {currentBullets.map((b, i) => (
                                    <li key={`li-${elements.length}-${i}`} className="break-words whitespace-pre-wrap overflow-hidden">{renderWithPaths(b)}</li>
                                  ))}
                                </ul>
                              )
                              currentBullets = []
                            }
                          }
                          lines.forEach((line, idx) => {
                            const t = line.trim()
                            if (t.startsWith('- ')) {
                              currentBullets.push(t.slice(2))
                            } else {
                              flushBullets(false)
                              if (t.length > 0) {
                                elements.push(
                                  <p key={`p-${idx}`} className="whitespace-pre-wrap break-words overflow-hidden mb-0">{renderWithPaths(line)}</p>
                                )
                              }
                            }
                          })
                          flushBullets(true)
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
                        <div className="w-8 h-8 flex-shrink-0">
                          <Avatar className="w-8 h-8 bg-gray-300">
                            <AvatarImage
                              src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Asset%2011%404x-dR5ns5tS5lPGnqUCF4tFmCBgNd2FDq.png"
                              alt="TissueLab Bot"
                              className="object-contain"
                            />
                            <AvatarFallback className="bg-gray-900">TL</AvatarFallback>
                          </Avatar>
                        </div>
                      ) : (
                        <div className="w-8 h-8 flex-shrink-0">
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
              </>
              )})
            })()}
            {(showWelcomeTyping || pendingWelcomeAnim) && <LoadingMessage></LoadingMessage>}
            {isLoading && showThinking && (
              <ReasoningWidget stages={thinkingStages} />
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

      <div className="absolute bottom-0 left-0 right-0 bg-white border-t z-20">
        {showToolbox && (
          <div className="p-2 border-b">
            <div className="max-w-4xl mx-auto flex gap-2 items-center">
              <Button
                variant="outline"
                className="flex-1 flex items-center gap-2 px-3"
                onClick={() => {
                  console.log("Load workflow")
                  setShowToolbox(false)
                }}
              >
                <Upload className="h-4 w-4" />
                Load Workflow
              </Button>
              <Button
                variant="outline"
                className="flex-1 flex items-center gap-2 px-3"
                onClick={() => {
                  console.log("Save workflow")
                  setShowToolbox(false)
                }}
              >
                <Save className="h-4 w-4" />
                Save Workflow
              </Button>
              <Button
                variant="destructive"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  startWelcomeTyping();
                  dispatch(clearMessages());
                  setShowToolbox(false)
                }}
                title="Clear Chat"
                aria-label="Clear Chat"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="p-2 h-24">
          <form onSubmit={handleSend} className="max-w-4xl mx-auto flex gap-2 h-full">
            <div className="w-full h-full flex flex-col relative rounded-md border border-input bg-transparent shadow-sm">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="flex-1"
                onClick={() => setShowToolbox((prev) => !prev)}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button type="submit" size="icon" className="flex-1 bg-indigo-600 hover:bg-indigo-700">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
