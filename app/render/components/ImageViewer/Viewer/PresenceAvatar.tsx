"use client";

import React from "react";
import { PresenceUser } from "@/hooks/viewer/usePresence";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PresenceAvatarsProps {
  users?: PresenceUser[];
}

export const PresenceAvatars: React.FC<PresenceAvatarsProps> = ({
  users = [],
}) => {
  if (!users || users.length === 0) return null;

  // 1. Define how many distinct faces you want to show
  const MAX_VISIBLE_AVATARS = 3;

  // 2. Split the users into "visible" and "overflow"
  const visibleUsers = users.slice(0, MAX_VISIBLE_AVATARS);
  const overflowUsers = users.slice(MAX_VISIBLE_AVATARS);
  const overflowCount = overflowUsers.length;

  return (
    <div className="flex items-center -space-x-2 h-6">
      <TooltipProvider delayDuration={300}>
        {/* Render Visible Users */}
        {visibleUsers.map((user) => (
          <Tooltip key={user.uid}>
            <TooltipTrigger asChild>
              <div
                className="relative flex items-center justify-center w-7 h-7 rounded-full border-2 border-muted bg-background shadow-sm cursor-help transition-transform hover:z-10 hover:scale-110"
                style={{ backgroundColor: user.color || "#585191" }}
              >
                <span className="text-[10px] font-bold text-white select-none leading-none">
                  {user.name ? user.name.charAt(0).toUpperCase() : "?"}
                </span>
                <span className="absolute bottom-0 right-0 w-2 h-2 bg-green-500 border-2 border-background rounded-full"></span>
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
              <div className="relative flex items-center justify-center w-7 h-7 rounded-full border-2 border-muted bg-muted shadow-sm cursor-help transition-transform hover:z-10 hover:scale-110">
                <span className="text-[10px] font-bold text-muted-foreground select-none leading-none">
                  +{overflowCount}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              <p className="font-semibold mb-1">Also present:</p>
              <ul className="list-disc pl-3">
                {/* List the hidden users in the tooltip */}
                {overflowUsers.slice(0, 10).map((u) => (
                  <li key={u.uid}>{u.name}</li>
                ))}
                {overflowUsers.length > 10 && <li>and more...</li>}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  );
};

export default PresenceAvatars;
