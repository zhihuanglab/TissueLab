/**
 * Utility functions for handling public read-only directory restrictions
 * and virtual path aliases
 */

import { PUBLIC_READ_ONLY_PATHS, PUBLIC_VIRTUAL_LINKS, VirtualLink } from '@/constants/fm.constants';

/**
 * Resolve a virtual path alias to its real storage path.
 * If the path is not a virtual alias, returns the original path.
 * 
 * @param path - Relative path that might be a virtual alias (e.g., 'samples/Data')
 * @returns Real storage path (e.g., 'data') or original path if not virtual
 */
export const resolveVirtualPath = (path: string | null | undefined): string => {
  if (!path) return '';
  
  // Normalize path (remove leading/trailing slashes)
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  
  // Check each virtual link
  for (const link of PUBLIC_VIRTUAL_LINKS) {
    const alias = link.alias.trim().replace(/^\/+|\/+$/g, '');
    const target = link.target;  // Don't strip leading slash for absolute paths
    
    // Exact match or subdirectory
    if (normalized === alias) {
      return target;
    } else if (normalized.startsWith(`${alias}/`)) {
      // Replace alias prefix with target
      const relativeSubpath = normalized.substring(alias.length + 1);
      // Handle absolute vs relative target paths
      if (target.startsWith('/')) {
        return `${target}/${relativeSubpath}`;
      } else {
        return `${target}/${relativeSubpath}`;
      }
    }
  }
  
  return path;
};

/**
 * Check if a path is a virtual alias or under a virtual alias.
 * 
 * @param path - Relative path to check
 * @returns true if path is virtual, false otherwise
 */
export const isVirtualPath = (path: string | null | undefined): boolean => {
  if (!path) return false;
  
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  
  return PUBLIC_VIRTUAL_LINKS.some(link => {
    const alias = link.alias.trim().replace(/^\/+|\/+$/g, '');
    return normalized === alias || normalized.startsWith(`${alias}/`);
  });
};

/**
 * Get list of virtual child entries that should appear under a parent directory.
 * 
 * @param parentPath - Parent directory path (e.g., 'samples')
 * @returns Array of virtual link configurations for children of this parent
 */
export const getVirtualChildren = (parentPath: string | null | undefined): VirtualLink[] => {
  // Normalize parentPath to empty string if falsy, to match Python implementation
  const normalizedParent = (parentPath ?? '').trim().replace(/^\/+|\/+$/g, '');
  const children: VirtualLink[] = [];
  
  for (const link of PUBLIC_VIRTUAL_LINKS) {
    const alias = link.alias.trim().replace(/^\/+|\/+$/g, '');
    
    // Check if this virtual link is a direct child of parent_path
    if (alias.includes('/')) {
      const aliasParent = alias.substring(0, alias.lastIndexOf('/'));
      if (aliasParent === normalizedParent) {
        children.push(link);
      }
    }
  }
  
  return children;
};

/**
 * Check if a path is in a public read-only directory.
 * This now includes both real paths and virtual alias paths.
 * 
 * @param path - Relative path from storage root (e.g., 'samples', 'data', 'samples/Data')
 * @returns true if the path is in a public read-only directory, false otherwise
 */
export const isPublicReadOnlyPath = (path: string | null | undefined): boolean => {
  if (!path) return false;
  
  // Normalize path (remove leading/trailing slashes)
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  
  // Check if path matches any public read-only path or is a subdirectory
  for (const publicPath of PUBLIC_READ_ONLY_PATHS) {
    // Handle absolute paths in PUBLIC_READ_ONLY_PATHS
    if (publicPath.startsWith('/')) {
      // Absolute path comparison
      if (path === publicPath || path.startsWith(`${publicPath}/`)) {
        return true;
      }
    } else {
      // Relative path comparison
      if (normalized === publicPath || normalized.startsWith(`${publicPath}/`)) {
        return true;
      }
    }
  }
  
  // Check if this is a virtual path that maps to a read-only target
  for (const link of PUBLIC_VIRTUAL_LINKS) {
    const alias = link.alias.trim().replace(/^\/+|\/+$/g, '');
    const target = link.target;
    
    // Check if path matches the alias
    if (normalized === alias || normalized.startsWith(`${alias}/`)) {
      // Check if the link itself is marked read-only
      if (link.read_only) {
        return true;
      }
      // Also check if the target is in a read-only path
      for (const publicPath of PUBLIC_READ_ONLY_PATHS) {
        if (publicPath.startsWith('/')) {
          // Absolute path check
          if (target === publicPath || target.startsWith(`${publicPath}/`)) {
            return true;
          }
        } else {
          // Relative path check
          const targetNormalized = target.trim().replace(/^\/+|\/+$/g, '');
          if (targetNormalized === publicPath || targetNormalized.startsWith(`${publicPath}/`)) {
            return true;
          }
        }
      }
    }
  }
  
  return false;
};

/**
 * Get restriction message for public read-only directory operations
 * @param operation - The operation being restricted
 * @returns Error message for the restriction
 */
export const getRestrictedDirectoryMessage = (operation: string): string => {
  return `Cannot ${operation} in public read-only directories. Please use your personal workspace instead.`;
};
