"use client";

import React from "react";
import { PresenceUser } from "@/hooks/viewer/usePresence";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PresenceAvatarsProps {
  users?: PresenceUser[];
}

const AVATAR_SIZE = 28; // h-7 w-7
const AVATAR_OVERLAP = 8; // -space-x-2
const AVATAR_STEP = AVATAR_SIZE - AVATAR_OVERLAP;

/** Deterministic width so overflow measurement matches before/after paint. */
export function estimatePresenceAvatarsWidth(userCount: number): number {
  if (userCount <= 0) return 0;
  const visibleCount = Math.min(userCount, 3);
  let width = AVATAR_SIZE + (visibleCount - 1) * AVATAR_STEP;
  if (userCount > 3) width += AVATAR_STEP;
  return width;
}

export const PresenceAvatars = React.memo(function PresenceAvatars({
  users = [],
}: PresenceAvatarsProps) {
  if (!users || users.length === 0) return null;

  const MAX_VISIBLE_AVATARS = 3;
  const visibleUsers = users.slice(0, MAX_VISIBLE_AVATARS);
  const overflowUsers = users.slice(MAX_VISIBLE_AVATARS);
  const overflowCount = overflowUsers.length;
  const width = estimatePresenceAvatarsWidth(users.length);

  return (
    <div
      className="flex h-6 shrink-0 items-center -space-x-2"
      style={{ width, minWidth: width }}
    >
      {/* Render Visible Users */}
      {visibleUsers.map((user) => (
        <Tooltip key={user.uid}>
          <TooltipTrigger asChild>
            <div
              className="relative flex h-7 w-7 shrink-0 cursor-help items-center justify-center rounded-full border-2 border-muted bg-background shadow-sm transition-transform hover:scale-110"
              style={{ backgroundColor: user.color || "#585191" }}
            >
              <span className="text-[10px] font-bold text-white select-none leading-none">
                {user.name ? user.name.charAt(0).toUpperCase() : "?"}
              </span>
              <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background bg-green-500" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <p className="font-semibold">{user.name}</p>
          </TooltipContent>
        </Tooltip>
      ))}

      {/* Render Overflow Bubble if needed */}
      {overflowCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="relative flex h-7 w-7 shrink-0 cursor-help items-center justify-center rounded-full border-2 border-muted bg-muted shadow-sm transition-transform hover:scale-110">
              <span className="text-[10px] font-bold text-muted-foreground select-none leading-none">
                +{overflowCount}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <p className="font-semibold mb-1">Also present:</p>
            <ul className="list-disc pl-3">
              {overflowUsers.slice(0, 10).map((u) => (
                <li key={u.uid}>{u.name}</li>
              ))}
              {overflowUsers.length > 10 && <li>and more...</li>}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});

export default PresenceAvatars;
