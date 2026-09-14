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
  // Set when this entry is a "use without copying" link to a samples slide
  // (value = the samples source path). Drives the "Shared" badge in the UI.
  linkedFrom?: string;
  // For user-to-user shares (NOT samples links): mode chosen by the sharer.
  //   "share"        — recipient has their own copy (annotations isolated)
  //   "collaborate"  — recipient's folder is a live symlink to the sharer's;
  //                    annotations land in the shared data
  //   "view"         — live symlink; recipient can see overlays but cannot write
  shareMode?: 'share' | 'collaborate' | 'view';
  // Companion .zarr for a WSI (set by Shared-with-me listing or by
  // groupWSIAndZarrFiles when both appear in a folder listing).
  attachedZarrPath?: string;
}

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
  isParentLink?: boolean;
  // Set on a WSI node when a companion .zarr/.zarr.zip was found for it. The
  // zarr is then NOT shown as its own row; instead the dashboard lazily reads
  // the zarr's top-level groups and renders analysis badges on the WSI.
  attachedZarrPath?: string;
}

export type SortConfig = {
  key: 'name' | 'mtime' | 'size' | 'type';
  direction: 'asc' | 'desc';
};

export type ImagePreviewType = 'thumbnail' | 'label' | 'macro' | 'cell_overlay' | 'patch_overlay';

export interface ImageFile {
  name: string;
  path: string;
  fullPath: string;
  size: number;
  mtime: number;
  isZarr?: boolean;
}

