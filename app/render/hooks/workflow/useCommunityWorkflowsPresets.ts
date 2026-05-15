"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { communityWorkflowsDefault, type CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { loadMergedCommunityWorkflowPresets } from "@/utils/workflow/communityWorkflowPresets"

export function useCommunityWorkflowsPresets() {
  const [presets, setPresets] = useState<CommunityWorkflow[]>(() => [...communityWorkflowsDefault])
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    setLoading(true)
    loadMergedCommunityWorkflowPresets()
      .then((merged) => {
        if (mounted.current) setPresets(merged)
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { presets, loading, refresh }
}
