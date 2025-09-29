import React, { useState } from "react"
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config"
import { apiFetch } from "@/utils/apiFetch"

type PanelFeedbackSummaryProps = {
  nodes: { model: string; impl: string }[]
  h5Path?: string
}

export const PanelFeedbackSummary: React.FC<PanelFeedbackSummaryProps> = ({ nodes, h5Path }) => {
  const [submitted, setSubmitted] = useState<"up" | "down" | null>(null)
  const [pending, setPending] = useState<boolean>(false)

  const baseBtn = "text-xs px-2 py-1 rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
  const upBtn = "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
  const downBtn = "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"

  const handleRateAll = async (rating: "up" | "down") => {
    if (pending || submitted) return
    setPending(true)
    try {
      await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/feedback/v1/rate`, {
        method: "POST",
        body: JSON.stringify({ nodes, rating, h5_path: h5Path || "" }),
      })
      setSubmitted(rating)
    } catch (_) {
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-3 flex items-center justify-between">
      <span className="text-xs text-slate-500">How was the workflow overall?</span>
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
