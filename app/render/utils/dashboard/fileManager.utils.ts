// File Manager Utility Functions

import { FileTreeNode, SortConfig } from '@/types/fileManager.types';
import { isWSI, isZarr, isZarrDir, isZarrZip, getWSIBaseName, isH5Convertible } from '@/utils/dashboard/fileType.utils';

/**
 * Format bytes to human readable format
 */
export const formatBytes = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Truncate file name to specified length while preserving extension
 */
export const truncateFileName = (fileName: string, maxLength: number = 80): string => {
  if (fileName.length <= maxLength) return fileName;
  const extension = fileName.split('.').pop() || '';
  const nameWithoutExt = fileName.slice(0, fileName.length - extension.length - 1);
  if (nameWithoutExt.length <= maxLength - 5) return fileName;
  const endChars = 5;
  const truncatedLength = maxLength - extension.length - endChars - 8;
  if (truncatedLength < 5) {
    const start = nameWithoutExt.slice(0, maxLength - extension.length - 4);
    return `${start}...${extension ? `.${extension}` : ''}`;
  }
  const start = nameWithoutExt.slice(0, truncatedLength);
  const end = nameWithoutExt.slice(-endChars);
  return `${start}...${end}${extension ? `.${extension}` : ''}`;
};

/**
 * Format file type for display
 */
export const formatFileType = (fileName: string): string => {
  const extension = fileName.split('.').pop();
  if (extension) {
    if (isWSI(fileName)) return 'WSI';
    if (isZarrZip(fileName)) return 'zip';
    if (isZarrDir(fileName)) return 'Zarr';
    return extension.toUpperCase();
  }
  return 'File';
};

/**
 * Parse API listing response to a Set of file/folder names
 */
export const parseListingToNames = (listing: any): Set<string> => {
  const arr = Array.isArray(listing) ? listing : (listing?.items || listing?.files || []);
  return new Set((arr || []).map((f: any) => (f?.name || f?.filename || '').toString()));
};

/**
 * Group WSI and Zarr files together
 */
export const groupWSIAndZarrFiles = (files: FileTreeNode[]): FileTreeNode[] => {
  const grouped: FileTreeNode[] = [];
  const wsiFiles: FileTreeNode[] = [];
  const zarrFiles: FileTreeNode[] = [];
  const otherFiles: FileTreeNode[] = [];
  const otherDirs: FileTreeNode[] = [];

  // Separate files by type
  files.forEach(file => {
    if (file.is_dir) {
      // Check if this is a .zarr directory (should be treated as a file)
      if (isZarrDir(file.name)) {
        zarrFiles.push(file);
      } else {
        // Regular directory (not .zarr)
        otherDirs.push(file);
      }
    } else if (isWSI(file.name)) {
      wsiFiles.push(file);
    } else if (isZarr(file.name)) {
      // .zarr.zip files should be treated as zarr files
      zarrFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  });

  // Group Zarr files with their corresponding WSI files
  const wsiMap = new Map<string, FileTreeNode>();
  
  // Add WSI files as parents
  wsiFiles.forEach(wsi => {
    const groupedWSI: FileTreeNode = {
      ...wsi,
      children: [],
    };
    wsiMap.set(wsi.name, groupedWSI);
    grouped.push(groupedWSI);
  });

  // Helper function to find parent WSI for a Zarr file
  const findParentWSI = (zarrName: string): FileTreeNode | undefined => {
    const zarrBaseName = getWSIBaseName(zarrName);
    const exact = wsiMap.get(zarrBaseName);
    if (exact) return exact;

    // Fallback: some zarr names carry a suffix beyond the WSI name, so accept
    // any WSI whose name is a prefix of the zarr name. Walking every WSI per
    // zarr made this O(WSI x Zarr) — a folder with thousands of each froze the
    // main thread for seconds during every listing. Probe the zarr name's own
    // prefixes against the map instead: bounded by the filename length, not by
    // how many slides are in the folder. Longest prefix wins (the previous
    // version kept the last Map-iteration match, which was arbitrary).
    for (let end = zarrName.length - 1; end > 0; end--) {
      const candidate = wsiMap.get(zarrName.slice(0, end));
      if (candidate) return candidate;
    }
    return undefined;
  };

  // Group Zarr files under their corresponding WSI files
  zarrFiles.forEach(zarr => {
    const parentWSI = findParentWSI(zarr.name);
    
    if (parentWSI) {
      // Don't surface the zarr as its own row — attach it to the WSI. The
      // dashboard lazily reads the zarr's top-level groups and renders analysis
      // badges (Cell Segmentation / Classification, …) on the WSI instead.
      // (If both a .zarr dir and a .zarr.zip exist, either resolves to the same
      // groups, so the first match wins.)
      if (!parentWSI.attachedZarrPath) {
        parentWSI.attachedZarrPath = zarr.path;
      }
    } else {
      // If no matching WSI found, add Zarr as standalone file
      grouped.push(zarr);
    }
  });

  // Add other directories (non-.zarr directories)
  grouped.push(...otherDirs);

  // Add other files (non-WSI/Zarr files)
  grouped.push(...otherFiles);

  // Restore mtime-based order: groupWSIAndZarrFiles reordered by type (WSI→Zarr→dirs→files),
  // which broke Last Modified sort. Sort top-level items by folder-vs-file then mtime desc.
  // Treat .zarr dirs as files (same as UI / sortFileTreeData), not as folders.
  grouped.sort((a, b) => {
    const aParent = !!(a as any).isParentLink;
    const bParent = !!(b as any).isParentLink;
    if (aParent !== bParent) return aParent ? -1 : 1;
    const aIsFolder = a.is_dir && !isZarr(a.name);
    const bIsFolder = b.is_dir && !isZarr(b.name);
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return (b.mtime ?? 0) - (a.mtime ?? 0);
  });

  return grouped;
};

/**
 * Sort file tree data
 */
export const sortFileTreeData = (data: FileTreeNode[], config: SortConfig): FileTreeNode[] => {
  return [...data].sort((a, b) => {
    // Always keep ".." parent link on top regardless of sort
    const aIsParent = !!(a as any).isParentLink;
    const bIsParent = !!(b as any).isParentLink;
    if (aIsParent !== bIsParent) return aIsParent ? -1 : 1;

    // Google Drive style: folders first, then files. Within each group, sort by config key.
    // .zarr dirs are treated as files (matches type column / expandable-folder UI).
    const aIsFolder = a.is_dir && !isZarr(a.name);
    const bIsFolder = b.is_dir && !isZarr(b.name);
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;

    let aValue, bValue;
    if (config.key === 'type') {
      aValue = aIsFolder ? 'folder' : formatFileType(a.name);
      bValue = bIsFolder ? 'folder' : formatFileType(b.name);
    } else if (config.key === 'mtime') {
      aValue = a.mtime ?? 0;
      bValue = b.mtime ?? 0;
    } else {
      aValue = a[config.key as keyof typeof a];
      bValue = b[config.key as keyof typeof b];
    }

    if ((aValue ?? '') < (bValue ?? '')) return config.direction === 'asc' ? -1 : 1;
    if ((aValue ?? '') > (bValue ?? '')) return config.direction === 'asc' ? 1 : -1;
    return 0;
  });
};

/**
 * Flatten file tree to array
 */
export const flattenFileTree = (
  nodes: FileTreeNode[],
  showNonImageFiles: boolean
): FileTreeNode[] => {
  let flat: FileTreeNode[] = [];
  nodes.forEach(node => {
    // Apply the same filter logic as in renderFileTreeRows
    if (!showNonImageFiles && !node.is_dir && !isWSI(node.name) && !isZarr(node.name) && !isH5Convertible(node.name)) {
      // Skip non-image files when showNonImageFiles is false, but still process children
      if (node.children && node.children.length > 0) {
        flat = flat.concat(flattenFileTree(node.children, showNonImageFiles));
      }
      return;
    }
    
    flat.push(node);
    // Process children (including Zarr files grouped under WSI files)
    if (node.children && node.children.length > 0) {
      flat = flat.concat(flattenFileTree(node.children, showNonImageFiles));
    }
  });
  return flat;
};

/**
 * Get all image files from file tree
 */
export const getAllImageFiles = (
  fileTree: FileTreeNode[],
  includeZarr: boolean = true
): Array<{
  name: string;
  path: string;
  fullPath: string;
  size: number;
  mtime: number;
  isZarr?: boolean;
}> => {
  const imageFiles: Array<{
    name: string;
    path: string;
    fullPath: string;
    size: number;
    mtime: number;
    isZarr?: boolean;
  }> = [];
  
  const extractImages = (nodes: FileTreeNode[], basePath: string = '') => {
    nodes.forEach(node => {
      if (node.is_dir && node.children) {
        extractImages(node.children, basePath ? `${basePath}/${node.name}` : node.name);
      } else if (!node.is_dir && (isWSI(node.name) || (includeZarr && isZarrDir(node.name)) || isH5Convertible(node.name))) {
        // Include WSI files, .zarr directories, and h5 files
        imageFiles.push({
          name: node.name,
          path: node.path,
          fullPath: node.path,
          size: node.size,
          mtime: node.mtime,
          isZarr: isZarrDir(node.name)
        });
      }
    });
  };
  
  extractImages(fileTree);
  return imageFiles;
};

