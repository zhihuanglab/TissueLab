import React, { useEffect, useRef, useCallback, useState } from 'react';
import OpenSeadragon from 'openseadragon';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import Cookies from 'js-cookie';

interface NavigatorProps {
  navigatorId: string;
}

const Navigator: React.FC<NavigatorProps> = ({ navigatorId }) => {
  const { viewerInstance } = useAnnotatorInstance();
  const navigatorRef = useRef<any>(null);
  const navRotateHandlerRef = useRef<any>(null);
  const navScrollHandlerRef = useRef<any>(null);
  // Brower detection for MacOS
  const isMacOS = typeof window !== 'undefined' && navigator.userAgent.includes('Mac')

  const updateNavigator = useCallback(() => {
    if (navigatorRef.current) {
      navigatorRef.current.updateSize();
      navigatorRef.current.update(viewerInstance?.viewport);
    }
  }, [viewerInstance]);

  const cleanupNavigator = useCallback(() => {
    const wrapper = document.getElementById(navigatorId);
    if (navigatorRef.current) {
      if (viewerInstance) {
        viewerInstance.removeHandler('animation', updateNavigator);
        viewerInstance.removeControl(wrapper as any);
        // Remove the rotate handler on destroy(important)
        if (navRotateHandlerRef.current) {
          viewerInstance.removeHandler('rotate', navRotateHandlerRef.current)
          navRotateHandlerRef.current = null
        }
        // Remove the navigator-scroll handler
        if (navScrollHandlerRef.current) {
          viewerInstance.removeHandler('navigator-scroll', navScrollHandlerRef.current);
          navScrollHandlerRef.current = null;
        }
      }
      navigatorRef.current.destroy();
      navigatorRef.current = null;

      if (wrapper) {
        wrapper.innerHTML = '';
      }
    }
  }, [viewerInstance, navigatorId, updateNavigator]);

  useEffect(() => {
    const createNavigator = () => {
      if (!viewerInstance) return;
      // Create a new container for openSeadragon
      const tiledImage = viewerInstance.world.getItemAt(0);
      const container = document.createElement('div');
      container.className = 'w-full h-full';
      container.style.width = '100%';
      container.style.height = '100%';

      const wrapper = document.getElementById(navigatorId);
      if (!wrapper) {
        console.warn('[Navigator] Wrapper element not found');
        return;
      }

      wrapper.innerHTML = '';
      wrapper.appendChild(container);

      navigatorRef.current = new OpenSeadragon.Navigator({
        element: container,
        viewer: viewerInstance,
        maintainSizeRatio: true,
        navigatorRotate: true,
        animationTime: 0,
        springStiffness: 100,
        borderColor: '#555',
        displayRegionColor: '#900',
        crossOriginPolicy: 'Anonymous',
        loadTilesWithAjax: true,
        ajaxHeaders: {
          'Content-Type': 'application/json',
          'Accept': 'image/jpeg,image/png,image/*,*/*',
          'Authorization': `Bearer ${Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token'}`,
        }
      } as any);

      navigatorRef.current.addTiledImage({
        tileSource: tiledImage.source,
        originalTiledImage: tiledImage,
        crossOriginPolicy: 'Anonymous'
      });

      viewerInstance.addHandler('animation', updateNavigator);
    }

    const initNavigator = async () => {
      if (viewerInstance) {
        cleanupNavigator();
        // Get rotate event before create navigator
        const prevNavRotateEvent = (viewerInstance as any).events['rotate']?.slice() || []
        // Create navigator
        createNavigator();
        // Get rotate event after create navigator
        const currentNavRotateEvent = (viewerInstance as any).events['rotate']?.slice() || []
        // extract the handler from the event
        const navRotateEvent = currentNavRotateEvent.filter((item: any) => !prevNavRotateEvent.includes(item))[0]
        if (navRotateEvent) {
          const navRotateHandler = navRotateEvent.handler
          navRotateHandlerRef.current = navRotateHandler
        }
        if (navigatorRef.current) {
          const navScrollHandler = (event: any) => {
            var viewport = viewerInstance.viewport;
            let zoomInRatio = 1.1; // Default zoom in ratio
            let zoomOutRatio = 0.9; // Default zoom out ratio
            if (isMacOS) {
              zoomInRatio = 0.95; // For MacOS trackpad
              zoomOutRatio = 1.05;
            }
            viewport.zoomBy(event.scroll === 1 ? zoomInRatio : zoomOutRatio);
            viewport.applyConstraints();
          };
          viewerInstance.addHandler('navigator-scroll', navScrollHandler);
          navScrollHandlerRef.current = navScrollHandler;
        }
      }
    };
    // Initialize the navigator
    initNavigator();

    return cleanupNavigator;
  }, [viewerInstance, navigatorId, cleanupNavigator, updateNavigator, isMacOS]);

  return (
    <div
      id={navigatorId}
      className="w-full h-[200px] bg-black opacity-80 rounded-md relative"
    />
  );
};

export default Navigator;