export type PortSide = "left" | "right" | "top" | "bottom"
export type NodeKind = "start" | "end" | "model"

export interface SubStage {
  key: string
  label: string
  progress: number
}

export interface LoadedClassifierRef {
  name: string
  source: ClassifierSource
  path?: string
  author?: string
  savedAt?: string
  /** Community classifier id (e.g. "uploaded-1234"). Set only when `source === "community"`. */
  communityId?: string
}

export interface GraphNode {
  id: string
  kind: NodeKind
  modelId?: string
  x: number
  y: number
  label?: string
  description?: string
  /** 0–100. 100 = processed; undefined / 0 = pending. */
  progress?: number
  /** Multi-stage models track per-stage progress here instead of the single `progress` above. */
  subStages?: SubStage[]
  /** Per-classifier strategy: single multiclass head vs N independent 1-vs-rest binaries. */
  classifierMode?: "multiclass" | "one-vs-rest"
  /** Classifier explicitly loaded through the graph-level Save/Load controls. */
  loadedClassifier?: LoadedClassifierRef
}

export interface GraphConnection {
  id: string
  fromId: string
  toId: string
  fromPort: PortSide
  toPort: PortSide
}

export interface Workflow {
  id: string
  name: string
  nodes: GraphNode[]
  connections: GraphConnection[]
  selectedId: string | null
}

export type ClassifierSource = "library" | "community" | "folder"

export interface SerializedClassifier {
  name: string
  modelId: string
  factory?: string
  path?: string
  description?: string
  author?: string
  tags?: string[]
  savedAt: string
}

export interface CommunityClassifierOption {
  id: string
  name: string
  description: string
  /** Pre-computed display string (may be a truncated uid fallback). */
  author: string
  /** Raw owner uid — used to resolve the author's display name/avatar. */
  ownerId?: string
  modelId: string
  factory?: string
  path?: string
  tags?: string[]
  savedAt?: string
}

/** `.tlcls` in the file manager’s current listing (same source as the classification panel). */
export interface FolderClassifierOption {
  id: string
  /** List title for the dialog — usually the file basename including
   *  `.tlcls`. After load the UI derives its label from
   *  `basename(classifier_path)` directly (see panelContent.ts), so this
   *  is only the picker-list copy, not the source of truth post-load. */
  name: string
  path: string
}

export type TriangleDir = "right" | "down" | "left" | "up"
