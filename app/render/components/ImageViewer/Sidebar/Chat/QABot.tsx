import type React from "react"
import { useState, useRef, useEffect } from "react"
import { Send, Plus, Upload, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/utils/twMerge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import http from '@/utils/http';
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config';
type MessageType = {
    id: number
    content: string
    sender: string
    type: string
}

const initialMessages = [
    {
        id: 1,
        content: "Can you tell me what is DTC in the bone marrow?",
        sender: "user",
        type: "text" as const,
    },
    {
        id: 2,
        content: `DTC in the context of bone marrow generally stands for “disseminated tumor cells.” 
        These are cancer cells that have detached from a primary tumor (for example, in the breast, prostate, or other organs) 
        and have migrated through the bloodstream or lymphatic system to lodge in the bone marrow.`,
        sender: "bot",
        type: "text" as const,
    },
]

export const QABot: React.FC<{ onWorkflowClick: () => void }> = ({ onWorkflowClick }) => {
    const [messages, setMessages] = useState<MessageType[]>(initialMessages)
    const [input, setInput] = useState("")
    const [showToolbox, setShowToolbox] = useState(false)
    const messagesEndRef = useRef<HTMLDivElement>(null)

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    const sendMessageToAPI = async (message: string) => {
        try {
            const response = await http.post(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/chat`, {
                agent_id: "agent1",
                prompt: message,
                parameters: {},
            })
            const data = response.data
            return data?.data?.response || "Error: No response from API"
        } catch (error) {
            console.error("API request failed:", error)
            return "Error: Failed to fetch response from API"
        }
    }

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!input.trim()) return

        // Append user message to chat
        const userMessage = {
            id: Date.now(),
            content: input,
            type: "text",
            sender: "user",
        }
        setMessages((prev) => [...prev, userMessage])
        setInput("")
        setShowToolbox(false)

        // Send user input to API and get response
        const botResponse = await sendMessageToAPI(input)

        // Append bot response to chat
        const botMessage = {
            id: Date.now() + 1,
            content: botResponse,
            type: "text",
            sender: "bot",
        }
        setMessages((prev) => [...prev, botMessage])
    }

    return (
        <>
            {/* Scrollable Chat Area */}
            <div className="flex-1 overflow-y-auto bg-slate-50">
                <div className="p-4">
                    <div className="max-w-4xl mx-auto space-y-4">
                        {messages.map((message) => (
                            <div key={message.id} className={cn("flex", message.sender === "user" ? "justify-end" : "justify-start")}>
                                <div
                                    className={cn("flex gap-3 max-w-[80%]", message.sender === "user" ? "flex-row-reverse" : "flex-row")}
                                >
                                    {message.sender === "bot" ? (
                                        <div className="w-8 h-8 flex-shrink-0">
                                            <Avatar className="w-8 h-8 bg-gray-900">
                                                <AvatarImage
                                                    src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/TissueLab_logo-VLyLV3rieYTePxPJC2ifBznsvDR0ru.png"
                                                    alt="TissueLab Bot"
                                                    className="object-contain p-1"
                                                />
                                                <AvatarFallback className="bg-gray-900">TL</AvatarFallback>
                                            </Avatar>
                                        </div>
                                    ) : (
                                        <div className="w-8 h-8 flex-shrink-0">
                                            <Avatar className="w-8 h-8">
                                                <AvatarImage src="https://github.com/shadcn.png" alt="User avatar" className="object-cover" />
                                                <AvatarFallback>CN</AvatarFallback>
                                            </Avatar>
                                        </div>
                                    )}
                                    <div
                                        className={cn(
                                            "rounded-2xl p-4",
                                            message.sender === "user" ? "bg-white border" : "bg-white border",
                                            message.type === "workflow" ? "cursor-pointer hover:bg-slate-50" : "",
                                        )}
                                        onClick={() => {
                                            if (message.type === "workflow") {
                                                onWorkflowClick()
                                            }
                                        }}
                                    >
                                        <p className="leading-relaxed whitespace-pre-line">{message.content}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>
                </div>
            </div>

            {/* Fixed Input Area */}
            <div className="flex-none bg-white border-t">
                {/* Toolbox */}
                {showToolbox && (
                    <div className="p-2 border-b">
                        <div className="max-w-4xl mx-auto flex gap-2">
                            <Button
                                variant="outline"
                                className="flex-1 flex items-center gap-2"
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
                                className="flex-1 flex items-center gap-2"
                                onClick={() => {
                                    console.log("Save workflow")
                                    setShowToolbox(false)
                                }}
                            >
                                <Save className="h-4 w-4" />
                                Save Workflow
                            </Button>
                        </div>
                    </div>
                )}

                {/* Input Form */}
                <div className="p-2 h-24">
                    <form onSubmit={handleSend} className="max-w-4xl mx-auto flex gap-2 h-full">
                        <Textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Type your message..."
                            className="min-h-[50px] max-h-[80px] resize-none flex-grow"
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                    e.preventDefault()
                                    handleSend(e)
                                }
                            }}
                        />
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
        </>
    )
}
