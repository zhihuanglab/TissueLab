/**
 * Type definitions for the Community module
 */

// Base interface for items with node and factory properties
export interface BaseModelItem {
  node?: string
  factory?: string
}

export interface ClassifierData extends BaseModelItem {
  id: string
  title: string
  description: string
  author?: {
    name: string
    avatar: string
    user_id: string
    username?: string
  }
  stats: {
    classes: number | null
    size: string
    downloads: number
    stars: number
    updatedAt: string
    createdAt: string
  }
  tags: string[]
  thumbnail: string
  filePath?: string
  downloadLink?: string
  model?: string
  is_starred?: boolean  
}

export interface TaskNodeData {
  id: string
  name: string
  category: string
  models: TaskNodeModelData[]
  classifiers: ClassifierData[]
  description?: string
  tags: string[]
}

export interface TaskNodeModelData {
  id: string
  name: string
  size: string
  status: 'downloaded' | 'available' | 'installing'
  classifiers?: number
  isDefault?: boolean
}

// Custom uploaded model (zip file)
export interface ModelData extends BaseModelItem {
  id: string
  title: string
  description: string
  author?: {
    name: string
    avatar: string
    user_id?: string
    username?: string
  }
  stats: {
    size: string
    downloads: number
    stars: number
    updatedAt: string
    createdAt: string
  }
  tags: string[]
  thumbnail: string
  filePath?: string
  downloadLink?: string
  model?: string
  is_starred?: boolean  
}

export interface DatasetData {
  id: string
  title: string
  description: string
  author: {
    name: string
    avatar: string
    user_id: string
    username?: string
  }
  stats: {
    size: string
    samples: number
    downloads: number
    stars: number
    updatedAt: string
  }
  tags: string[]
  thumbnail: string
}

export interface BackendNodeInfo {
  running?: boolean
  ready?: boolean
  starting?: boolean
  env_name?: string
  port?: number
  log_path?: string
  service_path?: string
  dependency_path?: string
  python_version?: string
  is_remote?: boolean
  remote_host?: string
  mnt_path?: string
}

export interface NodeInfo {
  running: boolean
  /** When false (and running true), node is still starting — show "Starting" not "Disconnected" */
  ready?: boolean
  /** When true, backend says node is starting (running but not ready) */
  starting?: boolean
  envName?: string
  port?: number
  logPath?: string
  servicePath?: string
  dependencyPath?: string
  pythonVersion?: string
  isRemote?: boolean
  remoteHost?: string
  mntPath?: string
}

export interface NodeExtended {
  runtime?: {
    service_path?: string
    env_name?: string
    port?: number
    dependency_path?: string
    python_version?: string
    bundle_exists?: boolean
    is_remote?: boolean
    remote_host?: string
    mnt_path?: string
    log_path?: string
  }
}

export interface InstallStep {
  key: string
  label: string
  status: 'pending' | 'active' | 'done' | 'failed'
  meta?: any
}

export type SortOption = 'most_stars' | 'most_downloads' | 'recently_upload'
export type ActiveTab = 'home' | 'workflows' | 'factories' | 'datasets' | 'custom-models'
export type FactoriesView = 'list' | 'detail'
export type ActivationStatus = 'starting' | 'ready' | 'failed'

