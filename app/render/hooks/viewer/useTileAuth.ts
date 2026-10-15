import { useEffect } from 'react';

import { watchTileAuth } from '@/utils/viewer/tileAuth';
import { watchTileRevive } from '@/utils/viewer/tileRevive';

/**
 * Keep an OpenSeadragon viewer loading tiles through Firebase token refreshes
 * and backend hiccups (see tileAuth / tileRevive). For viewers created
 * imperatively; returns the stop function, to call before viewer.destroy().
 */
export function startTileAuth(viewer: any, onToken?: (token: string) => void): () => void {
  const stopAuth = watchTileAuth(viewer, onToken);
  const stopRevive = watchTileRevive(viewer);
  return () => {
    stopAuth();
    stopRevive();
  };
}

/** startTileAuth for a viewer held in React state. `onToken` should be stable. */
export function useTileAuth(viewer: any, onToken?: (token: string) => void): void {
  useEffect(() => (viewer ? startTileAuth(viewer, onToken) : undefined), [viewer, onToken]);
}
