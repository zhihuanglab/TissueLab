import React, { useEffect, useRef, useCallback, useState } from 'react';
import OpenSeadragon from 'openseadragon';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import Cookies from 'js-cookie';

interface OSDNavigatorProps {
  navigatorSizeRatio?: number;
  autoHideDelay?: number;
}

const OSDNavigator: React.FC<OSDNavigatorProps> = ({
  navigatorSizeRatio = 0.2,
  autoHideDelay = 3000
}) => {
  const { viewerInstance } = useAnnotatorInstance();
  const navigatorRef = useRef<any>(null);
  const navRotateHandlerRef = useRef<any>(null);
  const navScrollHandlerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoHideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [isAutoFading, setIsAutoFading] = useState(false);
  const [viewerSize, setViewerSize] = useState({ width: 0, height: 0 });

  // Browser detection for MacOS
  const isMacOS = typeof window !== 'undefined' && navigator.userAgent.includes('Mac');

  const updateViewerSize = useCallback(() => {
    if (viewerInstance?.container) {
      const container = viewerInstance.container;
      if (container) {
        const rect = container.getBoundingClientRect();
        setViewerSize({ width: rect.width, height: rect.height });
        
        // Update OSD navigator size when container size changes
        if (navigatorRef.current) {
          try {
            // Force immediate update without animation
            navigatorRef.current.updateSize();
            navigatorRef.current.update(viewerInstance.viewport);
            // Force a redraw to ensure immediate visual update
            if (navigatorRef.current.viewport) {
              navigatorRef.current.viewport.update();
            }
          } catch (error) {
            console.warn('Error updating navigator size:', error);
          }
        }
      }
    }
  }, [viewerInstance]);

  const updateNavigator = useCallback(() => {
    if (navigatorRef.current && viewerInstance?.viewport) {
      try {
        navigatorRef.current.updateSize();
        navigatorRef.current.update(viewerInstance.viewport);
      } catch (error) {
        console.warn('Error updating navigator:', error);
      }
    }
  }, [viewerInstance]);

  const cleanupNavigator = useCallback(() => {
    if (navigatorRef.current) {
      try {
        if (viewerInstance) {
          viewerInstance.removeHandler('animation', updateNavigator);
          // Remove the rotate handler on destroy (important)
          if (navRotateHandlerRef.current) {
            viewerInstance.removeHandler('rotate', navRotateHandlerRef.current);
            navRotateHandlerRef.current = null;
          }
          // Remove the navigator-scroll handler
          if (navScrollHandlerRef.current) {
            viewerInstance.removeHandler('navigator-scroll', navScrollHandlerRef.current);
            navScrollHandlerRef.current = null;
          }
        }
        navigatorRef.current.destroy();
      } catch (error) {
        console.warn('Error during navigator cleanup:', error);
      } finally {
        navigatorRef.current = null;
      }
    }
  }, [viewerInstance, updateNavigator]);

  // Update viewer size when viewer instance changes
  useEffect(() => {
    if (viewerInstance) {
      updateViewerSize();
      
      // Listen for resize events
      const handleResize = () => {
        updateViewerSize();
      };
      
      window.addEventListener('resize', handleResize);
      
      // Use ResizeObserver for more precise container size monitoring
      let resizeObserver: ResizeObserver | null = null;
      if (viewerInstance.container && window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
          updateViewerSize();
        });
        resizeObserver.observe(viewerInstance.container);
      }
      
      // Also observe the navigator container itself for size changes
      let navigatorResizeObserver: ResizeObserver | null = null;
      if (containerRef.current && window.ResizeObserver) {
        navigatorResizeObserver = new ResizeObserver(() => {
          updateViewerSize();
        });
        navigatorResizeObserver.observe(containerRef.current);
      }
      
      return () => {
        window.removeEventListener('resize', handleResize);
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
        if (navigatorResizeObserver) {
          navigatorResizeObserver.disconnect();
        }
      };
    }
  }, [viewerInstance, updateViewerSize]);

  // Additional effect to monitor navigator container changes after it's created
  useEffect(() => {
    if (!containerRef.current || !viewerInstance) return;

    // Set up ResizeObserver for the navigator container
    let navigatorResizeObserver: ResizeObserver | null = null;
    if (window.ResizeObserver) {
      navigatorResizeObserver = new ResizeObserver(() => {
        updateViewerSize();
      });
      navigatorResizeObserver.observe(containerRef.current);
    }

    return () => {
      if (navigatorResizeObserver) {
        navigatorResizeObserver.disconnect();
      }
    };
  }, [viewerInstance, updateViewerSize]);

  const showNavigator = useCallback(() => {
    setIsAutoFading(false); // Reset to immediate show
    setIsVisible(true);
    // Clear existing timeout
    if (autoHideTimeoutRef.current) {
      clearTimeout(autoHideTimeoutRef.current);
      autoHideTimeoutRef.current = null;
    }
    // Set new timeout to hide navigator
    if (!isHovered) {
      autoHideTimeoutRef.current = setTimeout(() => {
        setIsAutoFading(true); // Set to auto-fade mode
        setIsVisible(false);
      }, autoHideDelay);
    }
  }, [autoHideDelay, isHovered]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    setIsAutoFading(false); // Immediate show on hover
    setIsVisible(true);
    if (autoHideTimeoutRef.current) {
      clearTimeout(autoHideTimeoutRef.current);
      autoHideTimeoutRef.current = null;
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    // Restart auto-hide timer
    autoHideTimeoutRef.current = setTimeout(() => {
      setIsAutoFading(true); // Set to auto-fade mode
      setIsVisible(false);
    }, autoHideDelay);
  }, [autoHideDelay]);

  useEffect(() => {
  const createNavigator = () => {
    if (!viewerInstance || !containerRef.current || !viewerInstance.world) return;

    // Clear existing content
    containerRef.current.innerHTML = '';

    // Get the tiled image from viewer
    const tiledImage = viewerInstance.world.getItemAt(0);
    if (!tiledImage) return;

      // Create navigator container
      const navContainer = document.createElement('div');
      navContainer.style.width = '100%';
      navContainer.style.height = '100%';
      navContainer.style.position = 'relative';
      containerRef.current.appendChild(navContainer);

      // Create OpenSeadragon Navigator
      navigatorRef.current = new OpenSeadragon.Navigator({
        element: navContainer,
        viewer: viewerInstance,
        navigatorSizeRatio: navigatorSizeRatio,
        maintainSizeRatio: true,
        navigatorRotate: true,
        animationTime: 0,
        springStiffness: 100,
        borderColor: '#555',
        displayRegionColor: '#900',
        opacity: 0.8,
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

      navigatorRef.current.addHandler('tile-loaded', updateNavigator);

      // Add animation handler
      viewerInstance.addHandler('animation', updateNavigator);

      // Add navigator scroll handler
      const navScrollHandler = (event: any) => {
        const viewport = viewerInstance.viewport;
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
    };

    const initNavigator = async () => {
      if (viewerInstance) {
        cleanupNavigator();
        // Get rotate event before create navigator
        const prevNavRotateEvent = (viewerInstance as any).events['rotate']?.slice() || [];
        // Create navigator
        createNavigator();
        // Get rotate event after create navigator
        const currentNavRotateEvent = (viewerInstance as any).events['rotate']?.slice() || [];
        // Extract the handler from the event
        const navRotateEvent = currentNavRotateEvent.filter((item: any) => !prevNavRotateEvent.includes(item))[0];
        if (navRotateEvent) {
          const navRotateHandler = navRotateEvent.handler;
          navRotateHandlerRef.current = navRotateHandler;
        }
      }
    };

    // Initialize the navigator
    initNavigator();

    return cleanupNavigator;
  }, [viewerInstance, navigatorSizeRatio, updateNavigator, isMacOS, cleanupNavigator]);

  // Cleanup effect for fast reload
  useEffect(() => {
    return () => {
      if (navigatorRef.current) {
        navigatorRef.current.destroy();
        navigatorRef.current = null;
      }
    };
  }, []);

  // Auto-hide effect
  useEffect(() => {
    // Show navigator initially, then auto-hide
    const initialTimer = setTimeout(() => {
      if (!isHovered) {
        setIsAutoFading(true); // Set to auto-fade mode
        setIsVisible(false);
      }
    }, autoHideDelay);

    return () => {
      clearTimeout(initialTimer);
      if (autoHideTimeoutRef.current) {
        clearTimeout(autoHideTimeoutRef.current);
      }
    };
  }, [autoHideDelay, isHovered]);

    // Handle viewer events to show navigator
    useEffect(() => {
      if (!viewerInstance) return;
  
      const handleViewerEvent = () => {
        showNavigator();
      };
  
      viewerInstance.addHandler('zoom', handleViewerEvent);
      viewerInstance.addHandler('pan', handleViewerEvent);
      viewerInstance.addHandler('rotate', handleViewerEvent);
  
      return () => {
        viewerInstance.removeHandler('zoom', handleViewerEvent);
        viewerInstance.removeHandler('pan', handleViewerEvent);
        viewerInstance.removeHandler('rotate', handleViewerEvent);
      };
    }, [viewerInstance, showNavigator]);

  return (
    <div
      ref={containerRef}
      className={`
        absolute top-0 right-0 z-40
        ${isVisible ? 'opacity-100 translate-x-0' : 'opacity-0'}
      `}
      style={{
        width: viewerSize.width > 0 ? `${navigatorSizeRatio * viewerSize.width}px` : `${navigatorSizeRatio * 200}px`,
        height: viewerSize.height > 0 ? `${navigatorSizeRatio * viewerSize.height}px` : `${navigatorSizeRatio * 200}px`,
        transition: isAutoFading ? 'opacity 1s ease-in-out' : 'none', // Only transition opacity for auto-fade
        background: 'rgba(0, 0, 0, 0.8)',
        border: '2px solid rgba(55, 55, 55, 0.8)',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    />
  );
};

export default OSDNavigator;
