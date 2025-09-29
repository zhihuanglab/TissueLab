"use client";
import React, { useEffect, useMemo, useState, useRef, useLayoutEffect } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { WorkflowPanel } from "@/store/slices/workflowSlice"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useSelector } from "react-redux"
import { useDispatch } from "react-redux"
import { setIsGenerating } from "@/store/slices/chatSlice"
import type { RootState } from "@/store"
import http from '@/utils/http';
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { formatPath } from "@/utils/pathUtils"
import EventBus from "@/utils/EventBus"

type CodePanelContentProps = {
  panel: WorkflowPanel
  onContentChange: (panelId: string, updated: WorkflowPanel) => void
}

export const CodePanelContent: React.FC<CodePanelContentProps> = ({ panel, onContentChange }) => {
  const codeItem = panel.content.find((i: any) => i.key === "generated_script")
  const code = (codeItem?.value as string) || ""
  const [hljsHtml, setHljsHtml] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [draft, setDraft] = useState(code)
  const [runLoading, setRunLoading] = useState(false)
  const preRef = useRef<HTMLPreElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const enterSyncRef = useRef<boolean>(false)
  

  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath)
  const dispatch = useDispatch()
  const h5Path = useMemo(() => {
    const p = formatPath(currentPath ?? "")
    if (!p) return ""
    return p.endsWith('.h5') ? p : `${p}.h5`
  }, [currentPath])

  // extremely lightweight token styling for Python-like keywords
  const highlight = (src: string) => {
    try {
      const keywords = /(\bdef\b|\breturn\b|\bimport\b|\bfrom\b|\bas\b|\bif\b|\belif\b|\belse\b|\bfor\b|\bwhile\b|\bwith\b|\btry\b|\bexcept\b|\bclass\b)/g
      const numbers = /(\b\d+(?:\.\d+)?\b)/g
      const strings = /(["'])(?:\\.|(?!\1).)*\1/g
      // order matters: escape first
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      let out = esc(src)
      // Apply numbers first on raw text to avoid touching digits in attributes added later
      out = out.replace(numbers, '<span class="text-amber-300">$1</span>')
      out = out.replace(strings, '<span class="text-emerald-300">$&</span>')
      out = out.replace(keywords, '<span class="text-sky-300">$1</span>')
      return out
    } catch {
      return src
    }
  }

  const draftHtml = useMemo(() => {
    try {
      const w = typeof window !== 'undefined' ? (window as any) : null
      if (w && w.hljs && typeof w.hljs.highlight === 'function') {
        try {
          const base = w.hljs.highlight(draft, { language: 'python' }).value
          const needsFiller = draft.endsWith('\n')
          return needsFiller
            ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>`
            : base
        } catch {
          try {
            const base = w.hljs.highlightAuto(draft).value
            const needsFiller = draft.endsWith('\n')
            return needsFiller
              ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>`
              : base
          } catch {
            const base = highlight(draft)
            const needsFiller = draft.endsWith('\n')
            return needsFiller
              ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>`
              : base
          }
        }
      }
    } catch {}
    const base = highlight(draft)
    const needsFiller = draft.endsWith('\n')
    return needsFiller
      ? `${base}<span style="display:block;height:20px;line-height:20px;"></span>`
      : base
  }, [draft])

  // Keep overlay scroll perfectly in sync after content changes (e.g., Enter)
  useLayoutEffect(() => {
    const pre = preRef.current
    const ta = textareaRef.current
    if (pre && ta) {
      const codeEl = pre.querySelector('code') as HTMLElement | null
      if (codeEl) {
        codeEl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
      }
      pre.scrollTop = 0
      pre.scrollLeft = 0
      if (enterSyncRef.current) {
        requestAnimationFrame(() => {
          const pre2 = preRef.current
          const ta2 = textareaRef.current
          if (pre2 && ta2) {
            const codeEl2 = pre2.querySelector('code') as HTMLElement | null
            if (codeEl2) {
              codeEl2.style.transform = `translate(${-ta2.scrollLeft}px, ${-ta2.scrollTop}px)`
            }
            pre2.scrollTop = 0
            pre2.scrollLeft = 0
          }
          enterSyncRef.current = false
        })
      }
    }
  }, [draft])

  // Try to use highlight.js via CDN (very lightweight load when used once)
  useEffect(() => {
    if (!code) {
      setHljsHtml(null)
      return
    }
    const ensureHljs = async () => {
      if (typeof window === 'undefined') return
      const w = window as any
      const addLink = (id: string, href: string) => {
        if (document.getElementById(id)) return
        const link = document.createElement('link')
        link.id = id
        link.rel = 'stylesheet'
        link.href = href
        document.head.appendChild(link)
      }
      const addScript = (id: string, src: string) => new Promise<void>((resolve, reject) => {
        if (document.getElementById(id)) { resolve(); return }
        const s = document.createElement('script')
        s.id = id
        s.src = src
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('Failed to load ' + src))
        document.body.appendChild(s)
      })

      try {
        // Theme CSS (github-dark)
        addLink('hljs-theme', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css')
        // Core pack (includes common languages like Python)
        await addScript('hljs-core', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
        if (w.hljs && typeof w.hljs.highlight === 'function') {
          try {
            const html = w.hljs.highlight(code, { language: 'python' }).value
            setHljsHtml(html)
          } catch {
            try {
              const html = w.hljs.highlightAuto(code).value
              setHljsHtml(html)
            } catch {
              setHljsHtml(null)
            }
          }
        } else {
          setHljsHtml(null)
        }
      } catch {
        setHljsHtml(null)
      }
    }
    ensureHljs()
  }, [code])

  const handleEditorScroll = () => {
    const pre = preRef.current
    const ta = textareaRef.current
    if (pre && ta) {
      // Avoid native scroll jump; position overlay code via transform to match caret exactly
      const codeEl = pre.querySelector('code') as HTMLElement | null
      if (codeEl) {
        codeEl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
      }
      pre.scrollTop = 0
      pre.scrollLeft = 0
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {}
  }

  const openEditor = () => { setDraft(code); setEditOpen(true) }
  const saveEdits = () => {
    const existing = panel.content.find((i: any) => i.key === 'generated_script')
    const newContent = existing
      ? panel.content.map((i: any) => i.key === 'generated_script' ? { ...i, value: draft } : i)
      : [...panel.content, { key: 'generated_script', type: 'text', value: draft } as any]
    onContentChange(panel.id, { ...panel, content: newContent })
    setEditOpen(false)
  }

  const runScript = async () => {
    if (!code || !h5Path) return
    setRunLoading(true)
    try {
      // inform Chatbox to start polling
      try { dispatch(setIsGenerating(true)) } catch {}
      // signal Chatbox poller that an answer is generating
      http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`) // prime endpoint (optional)
      
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/agent/v1/execute_script`, {
        h5_path: h5Path, 
        code_str: code
      })
      const data = resp.data
      try {
        // If success, post a concise summary answer so Chatbox can display it
        const exec = (data?.data?.execution_result) ?? data
        const summary = typeof exec === 'string' ? exec : JSON.stringify(exec, null, 2)
        await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`) // ensure service loaded
        await http.post(`${AI_SERVICE_API_ENDPOINT}/agent/v1/summary_answer`, {
          agent_id: 'default_agent', 
          prompt: 'Summarize execution', 
          parameters: { answer: summary }
        })
        // redirect to chat to view the answer
        EventBus.emit('open-sidebar', 'SidebarChat')
      } catch {}
    } catch (e) {
      // On error, still redirect to chat; backend will post an error summary or we can follow-up
      EventBus.emit('open-sidebar', 'SidebarChat')
    } finally {
      setRunLoading(false)
    }
  }

  return (
    <div className="mt-2 border rounded overflow-hidden">
      <div className="px-2 py-1 text-xs bg-slate-900 text-slate-300 flex items-center justify-between">
        <span>python</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-300 hover:text-white hover:bg-slate-600" onClick={openEditor}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-300 hover:text-white hover:bg-slate-600" onClick={handleCopy}>
            Copy
          </Button>
        </div>
      </div>
      <div className="bg-slate-950 max-h-48 overflow-x-auto overflow-y-auto">
        <div className="inline-block min-w-full w-max">
          {hljsHtml ? (
            <pre
              className="m-0 p-3 text-xs leading-5 whitespace-pre hljs"
              style={{ overflow: 'visible' }}
              dangerouslySetInnerHTML={{ __html: hljsHtml }}
            />
          ) : (
            <pre
              className="m-0 p-3 text-xs leading-5 text-slate-100 whitespace-pre"
              style={{ overflow: 'visible' }}
              dangerouslySetInnerHTML={{ __html: highlight(code) }}
            />
          )}
        </div>
      </div>
      <div className="px-3 py-2 bg-slate-900 border-t border-slate-800 flex items-center justify-center">
        <Button
          className="h-8 px-4 bg-indigo-600 hover:bg-indigo-700 text-white shadow-md shadow-indigo-500/20"
          onClick={runScript}
          disabled={!code || !h5Path || runLoading}
        >
          {runLoading ? 'Running…' : 'Run Code'}
        </Button>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="p-0 w-[92vw] h-[88vh] max-w-[1400px] sm:rounded-lg bg-slate-900 text-slate-100 overflow-hidden border-0 shadow-none ring-0 outline-none focus:outline-none [&>button]:hidden">
          <div className="flex flex-col h-full">
            <div className="h-11 px-3 flex items-center justify-between bg-slate-900 border-b border-slate-800">
              <div className="text-xs uppercase tracking-wide text-slate-300">Python Editor</div>
              <div className="flex items-center gap-3">
                <div className="text-[10px] text-slate-500 hidden sm:block">Esc to close</div>
                <button type="button" aria-label="Close" className="p-2 -m-2 rounded-md hover:bg-slate-800/60 focus:outline-none" onClick={() => setEditOpen(false)}>
                  <X className="h-4 w-4 text-slate-400" />
                </button>
              </div>
            </div>
            <div className="flex-1 relative bg-slate-950 p-3">
              <pre
                ref={preRef}
                className="absolute inset-0 m-0 p-3 text-xs font-mono leading-5 whitespace-pre overflow-hidden pointer-events-none"
                style={{
                  lineHeight: '20px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                  tabSize: 4,
                }}
              >
                <code
                  className="inline-block min-w-full w-max text-slate-100 hljs"
                  style={{
                    background: 'transparent',
                    padding: 0,
                    margin: 0,
                    lineHeight: '20px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    tabSize: 4,
                  }}
                  dangerouslySetInnerHTML={{ __html: draftHtml }}
                />
              </pre>
              <textarea
                ref={textareaRef}
                className="absolute inset-0 w-full h-full p-3 text-xs font-mono leading-5 bg-transparent text-transparent caret-slate-100 selection:bg-blue-600 selection:text-white outline-none resize-none overflow-auto overflow-x-auto overflow-y-auto border-0 z-10"
                wrap="off"
                style={{
                  whiteSpace: 'pre',
                  overflowWrap: 'normal',
                  wordBreak: 'normal',
                  lineHeight: '20px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                  tabSize: 4,
                }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onScroll={handleEditorScroll}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    enterSyncRef.current = true
                  }
                }}
                spellCheck={false}
              />
            </div>
            <div className="h-12 px-2 bg-slate-900 border-t border-slate-800 flex items-center justify-end gap-2">
              <Button variant="secondary" className="bg-slate-800 text-slate-100 hover:bg-slate-700" onClick={() => { setDraft(code); setEditOpen(false) }}>Discard</Button>
              <Button onClick={saveEdits}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

