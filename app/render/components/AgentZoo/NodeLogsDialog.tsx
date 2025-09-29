import React, { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config'
import http from '@/utils/http';

type NodeLogsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  env?: string
  port?: number
  logPath?: string
  pollMs?: number
}

export const NodeLogsDialog: React.FC<NodeLogsDialogProps> = ({
  open,
  onOpenChange,
  env,
  port,
  logPath,
  pollMs = 2000,
}) => {
  const [logText, setLogText] = useState<string>('')
  const [paused, setPaused] = useState<boolean>(false)
  const timerRef = useRef<any>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Poll logs
  useEffect(() => {
    if (!open || !logPath || paused) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const timer = setInterval(async () => {
      try {
        const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/logs/tail?path=${encodeURIComponent(logPath)}&n=200`)
        const data = resp.data
        if (typeof data?.code === 'number' && data.code !== 0) {
          setLogText(`[Error] ${data?.message || 'Failed to load logs'}`)
        } else {
          const tail = data?.data?.tail || ''
          setLogText(tail)
        }
      } catch (e) {
        // ignore transient errors
      }
    }, Math.max(500, pollMs))
    timerRef.current = timer
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, logPath, paused, pollMs])

  // Auto scroll to bottom when new logs arrive and not paused
  useEffect(() => {
    if (!paused && scrollRef.current) {
      try {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      } catch {}
    }
  }, [logText, paused])

  const displayEnv = env && env.includes('::') ? env.split('::').slice(-1)[0] : env

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) {
          if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
          setLogText('')
          setPaused(false)
        }
      }}
    >
      <DialogContent className="w-[90vw] max-w-[700px] overflow-hidden gap-2">
        <DialogHeader>
          <DialogTitle className="truncate">Logs</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between text-xs text-slate-600">
          <div className="min-w-0 truncate pr-2 flex items-center gap-2">
            {displayEnv ? (
              <span className="inline-flex items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 px-2 py-0.5 whitespace-nowrap" title={displayEnv}>
                <span className="text-[9px] font-semibold opacity-80">ENV</span>
                {displayEnv}
              </span>
            ) : null}
            {typeof port === 'number' ? (
              <span className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 px-2 py-0.5 whitespace-nowrap" title={`localhost:${port}`}>
                <span className="text-[9px] font-semibold opacity-80">PORT</span>
                {port}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => setPaused(p => !p)} disabled={!logPath}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => { try { navigator.clipboard.writeText(logText) } catch {} }} disabled={!logText}>
              Copy
            </Button>
          </div>
        </div>
        <div className="mt-2 border rounded overflow-hidden">
          <div className="px-2 py-1 text-xs bg-slate-900 text-slate-300">Setup / Runtime Logs</div>
          <div className="bg-slate-950 h-80 overflow-y-auto overflow-x-hidden" ref={scrollRef}>
            <pre className="m-0 p-2 text-xs font-mono whitespace-pre-wrap break-words text-slate-100 leading-5 select-text w-full max-w-full">
              {logText || (logPath ? 'Tailing logs...' : 'No log file to display.')}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default NodeLogsDialog


