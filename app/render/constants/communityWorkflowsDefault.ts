/**
 * Default offline preset workflows for the Load Workflow dialog (when the community API is down).
 * Data lives in {@link ./communityWorkflowsDefault.json} — edit that file to add or change presets.
 */

import type { ChatMessage } from "@/store/slices/chat/chatSlice";
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice";

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
  author: string;
  savedAt: string;
  nodes: GraphNode[];
  connections: GraphConnection[];
  panelStates: Record<string, WorkflowPanel>;
  chatMessages: ChatMessage[];
  selectedId: string | null;
}

export const communityWorkflowsDefault =
  communityWorkflowsDefaultJson as CommunityWorkflow[];
