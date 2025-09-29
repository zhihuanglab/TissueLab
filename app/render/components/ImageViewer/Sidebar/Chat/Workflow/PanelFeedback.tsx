import React, { useState } from "react"
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config"
import { apiFetch } from "@/utils/apiFetch"

type PanelFeedbackProps = {
  model: string
  impl: string
  h5Path?: string
  size?: "sm" | "md"
  className?: string
  onSubmitted?: (rating: "up" | "down") => void
}

export const PanelFeedback: React.FC<PanelFeedbackProps> = ({
  model,
  impl,
  h5Path,
  size = "sm",
  className,
  onSubmitted,
}) => {
  const [submitted, setSubmitted] = useState<"up" | "down" | null>(null)
  const [pending, setPending] = useState<boolean>(false)

  const baseBtn = "text-xs px-2 py-1 rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
  const upBtn = "bg-green-50 text-green-700 border-green-200 hover:bg-green-100"
  const downBtn = "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"

  const handleRate = async (rating: "up" | "down") => {
    if (pending || submitted) return
    setPending(true)
    try {
      await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/feedback/v1/rate`, {
        method: "POST",
        body: JSON.stringify({
          nodes: [{ model, impl }],
          rating,
          h5_path: h5Path || "",
        }),
      })
      setSubmitted(rating)
      onSubmitted?.(rating)
    } catch (_) {
      // swallow network errors for now
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={`flex items-center justify-between ${className || ""}`}>
      <span className="text-xs text-slate-500">How was this step?</span>
      <div className="flex gap-2">
        <button
          className={`${baseBtn} ${upBtn}`}
          onClick={() => handleRate("up")}
          disabled={pending || !!submitted}
          aria-label="Thumbs up"
          title="Thumbs up"
        >
          👍
        </button>
        <button
          className={`${baseBtn} ${downBtn}`}
          onClick={() => handleRate("down")}
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
