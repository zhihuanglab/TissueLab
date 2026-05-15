'use client'

import { Cloud } from "lucide-react"
import * as React from "react"

import { useUserInfo } from "@/provider/UserInfoProvider"
import { getConfig } from "@/utils/dashboard/fileManager.service"
import { cn } from "@/utils/twMerge"

interface StorageUsageCardProps {
  usageBytes?: number | null
  quotaBytes?: number | null
  className?: string
  title?: string
  showUpgradeButton?: boolean
  withFrame?: boolean
}

export const StorageUsageCard: React.FC<StorageUsageCardProps> = ({
  usageBytes,
  quotaBytes,
  className,
  title = "Cloud Storage",
  showUpgradeButton = true,
  withFrame = true,
}) => {
  const [internalUsage, setInternalUsage] = React.useState<number | null>(null)
  const [internalQuota, setInternalQuota] = React.useState<number | null>(null)
  const { userIdentity, isLoadingUser } = useUserInfo()

  const fetchStorageInfo = React.useCallback(async () => {
    if (userIdentity !== 3) return
    try {
      const cfg = await getConfig()
      if (typeof cfg?.storageUsage === "number") {
        setInternalUsage(cfg.storageUsage)
      } else {
        setInternalUsage(null)
      }

      if (typeof cfg?.storageQuota === "number") {
        setInternalQuota(cfg.storageQuota)
      } else if (cfg?.storageQuota === null) {
        setInternalQuota(null)
      }
    } catch (error) {
      // keep previous values on failure
      console.warn("Failed to fetch storage info", error)
    }
  }, [userIdentity])

  React.useEffect(() => {
    fetchStorageInfo()
  }, [fetchStorageInfo])

  React.useEffect(() => {
    if (isLoadingUser) return
    fetchStorageInfo()
  }, [fetchStorageInfo, isLoadingUser, userIdentity])

  React.useEffect(() => {
    const handler = () => {
      fetchStorageInfo()
    }
    if (typeof window !== "undefined") {
      window.addEventListener("tissuelab:cloudUsageRefresh", handler)
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("tissuelab:cloudUsageRefresh", handler)
      }
    }
  }, [fetchStorageInfo])

  const usage = typeof usageBytes === "number" ? usageBytes : internalUsage || 0
  const quota = typeof quotaBytes === "number" ? quotaBytes : internalQuota

  const percent = quota ? Math.min(100, Math.round((usage / quota) * 100)) : 0

  const toGB = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(2)

  const label = quota
    ? `${toGB(usage)} / ${toGB(quota)}GB used`
    : "Storage usage"

  const barColor = percent > 90 ? "bg-destructive" : "bg-primary"

  return (
    <div
      className={cn(
        withFrame
          ? "electron-no-drag flex w-full flex-col gap-2 rounded-sm border border-border/50 bg-card/40 shadow-sm"
          : "electron-no-drag flex w-full flex-col gap-2",
        className
      )}
    >
      <div className={cn("flex flex-col gap-3 rounded-sm", withFrame ? "p-3" : "")}
      >
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">{title}</p>
        </div>

        <div className="flex flex-col gap-2" title={label}>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary/80 border border-border/60">
            <div
              className={cn("h-2 transition-all", quota ? barColor : "bg-muted-foreground/50")}
              style={{ width: `${quota ? percent : 0}%` }}
            />
          </div>

          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {label}
          </span>
        </div>
      </div>

      {/* {showUpgradeButton && (
        <Button
          variant="ghost"
          className="rounded-t-none border-t border-border/60 bg-transparent hover:bg-muted/50"
        >
          Upgrade
        </Button>
      )} */}
    </div>
  )
}
