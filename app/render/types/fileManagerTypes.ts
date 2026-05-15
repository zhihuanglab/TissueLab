// File Manager Common Types

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  source?: 'local' | 'web';
  // Shared file metadata
  sharedBy?: string;
  sharedAt?: number;
  isShared?: boolean;
}

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
  isParentLink?: boolean;
}

export type SortConfig = {
  key: 'name' | 'mtime' | 'size' | 'type';
  direction: 'asc' | 'desc';
};

export type ImagePreviewType = 'thumbnail' | 'label' | 'macro';

export interface ImageFile {
  name: string;
  path: string;
  fullPath: string;
  size: number;
  mtime: number;
  isZarr?: boolean;
}

