import React from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Loader2, Check } from "lucide-react"
import { cn } from "@/utils/twMerge"

export type ReasoningStatus = 'pending' | 'active' | 'done'
export type ReasoningStage = { key: string; label: string; status: ReasoningStatus }

type ReasoningWidgetProps = {
  stages: ReasoningStage[]
}

export const ReasoningWidget: React.FC<ReasoningWidgetProps> = ({ stages }) => {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <div className="w-4 h-4 flex-shrink-0">
            <Avatar className="w-4 h-4 bg-gray-300">
              <AvatarImage
                src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Asset%2011%404x-dR5ns5tS5lPGnqUCF4tFmCBgNd2FDq.png"
                alt="TissueLab Bot"
                className="object-contain"
              />
              <AvatarFallback className="bg-gray-900 text-[10px] leading-none">TL</AvatarFallback>
            </Avatar>
          </div>
          <span className="font-medium">TLAgent</span>
          <span>is working</span>
        </div>
        <div className="space-y-1.5">
          {stages.map((s) => (
            <div key={s.key} className="flex items-start gap-2">
              <div className="mt-[2px]">
                {s.status === 'done' ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : s.status === 'active' ? (
                  <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full bg-gray-200" />
                )}
              </div>
              <div className={cn("text-sm", s.status === 'active' ? "text-gray-900" : "text-gray-600")}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}


