import { useEffect, useRef } from 'react';
import { webglContextManager } from '@/utils/webglContextManager';

/**
 * WebGL cleanup hook
 * Clean up WebGL contexts when the component unmounts
 */
export const useWebGLCleanup = (contextId?: string) => {
  const contextIdRef = useRef<string | null>(contextId || null);

  useEffect(() => {
    // Set context ID
    if (contextId) {
      contextIdRef.current = contextId;
    }

    // Clean up function when the component unmounts
    return () => {
      if (contextIdRef.current) {
        console.log('Cleaning up WebGL context:', contextIdRef.current);
        webglContextManager.releaseContext(contextIdRef.current);
        contextIdRef.current = null;
      }
    };
  }, [contextId]);

  // Manual cleanup function
  const cleanup = () => {
    if (contextIdRef.current) {
      webglContextManager.releaseContext(contextIdRef.current);
      contextIdRef.current = null;
    }
  };

  return { cleanup };
};

export default useWebGLCleanup;

