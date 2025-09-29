import React, { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { X } from "lucide-react"

export const CodePreview: React.FC<{ code: string, language?: string }> = ({ code, language = "python" }) => {
  const [hljsHtml, setHljsHtml] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const highlightFallback = (src: string) => {
    try {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      const keywords = /(\bdef\b|\breturn\b|\bimport\b|\bfrom\b|\bas\b|\bif\b|\belif\b|\belse\b|\bfor\b|\bwhile\b|\bwith\b|\btry\b|\bexcept\b|\bclass\b)/g
      const numbers = /(\b\d+(?:\.\d+)?\b)/g
      const strings = /(["'])(?:\\.|(?!\1).)*\1/g
      let out = esc(src)
      out = out.replace(numbers, '<span class="text-amber-300">$1</span>')
      out = out.replace(strings, '<span class="text-emerald-300">$&</span>')
      out = out.replace(keywords, '<span class="text-sky-300">$1</span>')
      return out
    } catch {
      return code
    }
  }

  useEffect(() => {
    const ensureHljs = async () => {
      try {
        if (typeof window === 'undefined') { setHljsHtml(null); return }
        const w: any = window
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

        addLink('hljs-theme', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css')
        await addScript('hljs-core', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
        if (w.hljs && typeof w.hljs.highlight === 'function') {
          try {
            const html = w.hljs.highlight(code, { language }).value
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
  }, [code, language])

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(code) } catch {}
  }

  return (
    <div className="border rounded overflow-hidden w-full">
      <div className="px-2 py-1 text-xs bg-slate-900 text-slate-300 flex items-center justify-between">
        <span>{language.toLowerCase()}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-300 hover:text-white hover:bg-slate-600" onClick={handleCopy}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-slate-300 hover:text-white hover:bg-slate-600" onClick={() => setOpen(true)}>
            View
          </Button>
        </div>
      </div>
      <div className="bg-slate-950 max-h-48 overflow-x-auto overflow-y-auto">
        <div className="w-full min-w-0">
          {hljsHtml ? (
            <pre className="m-0 p-3 text-xs leading-5 whitespace-pre hljs" style={{ overflow: 'visible' }}
                 dangerouslySetInnerHTML={{ __html: hljsHtml }} />
          ) : (
            <pre className="m-0 p-3 text-xs leading-5 text-slate-100 whitespace-pre" style={{ overflow: 'visible' }}
                 dangerouslySetInnerHTML={{ __html: highlightFallback(code) }} />
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 w-[92vw] h-[88vh] max-w-[1400px] sm:rounded-lg bg-slate-900 text-slate-100 overflow-hidden border-0 shadow-none ring-0 outline-none [&>button]:hidden">
          <div className="flex flex-col h-full max-h-full min-h-0">
            <div className="h-11 px-3 flex items-center justify-between bg-slate-900 border-b border-slate-800">
              <div className="text-xs uppercase tracking-wide text-slate-300">{language} Preview</div>
              <div className="flex items-center gap-3">
                <div className="text-[10px] text-slate-500 hidden sm:block">Esc to close</div>
                <button type="button" aria-label="Close" className="p-2 -m-2 rounded-md hover:bg-slate-800/60 focus:outline-none" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4 text-slate-400" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 bg-slate-950 p-3 overflow-x-auto overflow-y-auto">
              <pre className="m-0 p-3 text-xs leading-5 whitespace-pre hljs" style={{ background: 'transparent', color: 'inherit' }}
                   dangerouslySetInnerHTML={{ __html: hljsHtml ?? highlightFallback(code) }} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}


