import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config"
import { apiFetch } from "@/utils/common/apiFetch"
import React, { useState } from "react"

type PanelFeedbackSummaryProps = {
  nodes: { model: string; impl: string }[]
  zarrPath?: string
}

export const PanelFeedbackSummary: React.FC<PanelFeedbackSummaryProps> = ({ nodes, zarrPath }) => {
  const [submitted, setSubmitted] = useState<"up" | "down" | null>(null)
  const [pending, setPending] = useState<boolean>(false)

  const baseBtn = "text-xs px-2 py-1 rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
  const upBtn = "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.2)] hover:bg-[hsl(var(--success)/0.2)]"
  const downBtn = "bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)/0.2)] hover:bg-[hsl(var(--destructive)/0.2)]"

  const handleRateAll = async (rating: "up" | "down") => {
    if (pending || submitted) return
    setPending(true)
    try {
      await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/feedback/v1/rate`, {
        method: "POST",
        body: JSON.stringify({ nodes, rating, zarr_path: zarrPath || "" }),
      })
      setSubmitted(rating)
    } catch (_) {
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-3 flex items-center justify-between">
      <span className="text-xs text-muted-foreground">How was the workflow overall?</span>
      <div className="flex gap-2">
        <button
          className={`${baseBtn} ${upBtn}`}
          onClick={() => handleRateAll("up")}
          disabled={pending || !!submitted}
          aria-label="Thumbs up"
          title="Thumbs up"
        >
          👍
        </button>
        <button
          className={`${baseBtn} ${downBtn}`}
          onClick={() => handleRateAll("down")}
          disabled={pending || !!submitted}
          aria-label="Thumbs down"
          title="Thumbs down"
        >
          👎
        </button>
      </div>
    </div>
  )
}
