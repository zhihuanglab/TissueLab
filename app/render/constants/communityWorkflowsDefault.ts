/**
 * Default offline preset workflows for the Load Workflow dialog (when the community API is down).
 * Data lives in {@link ./communityWorkflowsDefault.json} — edit that file to add or change presets.
 */

import type { ChatMessage } from "@/store/slices/chat/chatSlice";
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import type { SerializedWorkflowRuntimeContext } from "@/utils/agent/workflow/serializedWorkflow";

import communityWorkflowsDefaultJson from "./communityWorkflowsDefault.json";

type PortSide = "left" | "right" | "top" | "bottom";
type NodeKind = "start" | "end" | "model";

interface GraphNode {
  id: string;
  kind: NodeKind;
  modelId?: string;
  x: number;
  y: number;
  label?: string;
  description?: string;
}

interface GraphConnection {
  id: string;
  fromId: string;
  toId: string;
  fromPort: PortSide;
  toPort: PortSide;
}

export interface CommunityWorkflow {
  id: string;
  name: string;
  description: string;
  /** Legacy denormalized string baked in at register time. Stale after the
   *  publisher renames; the current display name is resolved at render time
   *  via `useAuthorProfile(ownerId)`. Kept as a fallback for built-in
   *  presets that have no `ownerId` and for very old docs predating the
   *  per-uid resolution. */
  author: string;
  savedAt: string;
  nodes: GraphNode[];
  connections: GraphConnection[];
  panelStates: Record<string, WorkflowPanel>;
  chatMessages: ChatMessage[];
  selectedId: string | null;
  /** Optional — older presets pre-date runtime context capture. */
  runtimeContext?: SerializedWorkflowRuntimeContext;
  /** Firebase uid of the publisher; absent on offline defaults. The frontend
   *  uses this to look up the current preferred_name + avatar via
   *  /community/v1/users/{uid}/public-profile. */
  ownerId?: string;
}

export const communityWorkflowsDefault =
  communityWorkflowsDefaultJson as CommunityWorkflow[];
