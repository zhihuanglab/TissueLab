export const VIRTUAL_ROOT = '__root__';
export const SHARED_ROOT = '__shared__';

export const ROOT_DISPLAY = {
  root: 'Root',
  personal: 'Personal',
  shared: 'Shared with me',
  samples: 'Samples',
  data: 'Data',
} as const;

/**
 * Virtual link configuration for public directories.
 * Allows displaying folders from one path as if they were inside another path.
 */
export interface VirtualLink {
  alias: string;        // Virtual path shown to users (e.g., 'samples/Data')
  target: string;       // Real storage path (e.g., 'data')
  display_name: string; // Display name in UI (e.g., 'Data')
  read_only: boolean;   // Whether this link should be read-only
}

/**
 * Public virtual links configuration.
 * This should be kept in sync with backend or fetched from /fm/v1/config
 */
export const PUBLIC_VIRTUAL_LINKS: VirtualLink[] = [
  {
    alias: 'samples/Data',
    target: '/data/public',  // Absolute system path
    display_name: 'Data',
    read_only: true,
  },
  // Add more virtual links here as needed
];

/**
 * Public paths that are accessible to all users but read-only.
 * These paths are visible to everyone but operations are restricted.
 * NOTE: This now only includes real root paths. Virtual aliases are handled separately.
 */
export const PUBLIC_READ_ONLY_PATHS: string[] = [
  'samples',
  '/data/public',  // Absolute system path
];

