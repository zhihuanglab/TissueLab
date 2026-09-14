"use client";

/**
 * Loading placeholder shown while a sidebar panel's JS chunk is in
 * flight. Without an explicit `loading:` prop on `next/dynamic` the
 * default fallback is `null`, which paints as a blank rectangle —
 * indistinguishable from a frozen UI on a slow network.
 *
 * Kept deliberately generic (no panel-specific shape) so we can reuse
 * it across SidebarMain / SidebarAnnotation / SidebarData /
 * SidebarWorkflowGraphOnly.
 */

import React from "react";

const SidebarPanelSkeleton: React.FC = () => {
  return (
    <div
      role="status"
      aria-label="Loading panel"
      className="flex h-full flex-col gap-3 p-4 animate-pulse"
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <div className="h-7 w-7 rounded-md bg-muted/70" />
        <div className="h-4 flex-1 rounded bg-muted/70" />
      </div>
      {/* Body rows — three card-shaped blocks roughly mirroring the
          density of most sidebar panels. */}
      <div className="space-y-2">
        <div className="h-16 rounded-md bg-muted/50" />
        <div className="h-16 rounded-md bg-muted/40" />
        <div className="h-16 rounded-md bg-muted/30" />
      </div>
    </div>
  );
};

export default SidebarPanelSkeleton;
