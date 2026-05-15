"use client";
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { ChevronUp, ChevronDown, Layers, ChevronLeft, ChevronRight } from 'lucide-react';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/common/apiFetch';

/** Gap (px) between panel and OSD viewport when positioning / clamping / dragging. */
const VIEWPORT_EDGE_INSET_PX = 4;

interface ZStackInfo {
  has_zstack: boolean;
  layer_count: number;
  layer_indices: number[];
  current_layer: number;
}

interface ZStackControllerProps {
  sessionId?: string;
  onLayerChange?: (layer: number) => void;
}

const ZStackController: React.FC<ZStackControllerProps> = ({ 
  sessionId = 'default',
  onLayerChange 
}) => {
  const [zstackInfo, setZstackInfo] = useState<ZStackInfo | null>(null);
  const [currentLayer, setCurrentLayer] = useState<number>(0);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  // Initialize with estimated right-center position
  const [position, setPosition] = useState({ x: 9999, y: 9999 }); // Off-screen until positioned
  const [isPositioned, setIsPositioned] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [lastParentWidth, setLastParentWidth] = useState<number>(0); // Track parent width changes
  const lastUpdateTimeRef = useRef<number>(0); // Debounce updates
  const lastDragEndTimeRef = useRef<number>(0); // Track when drag ended
  const controllerRef = useRef<HTMLDivElement>(null);
  const dragSizeRef = useRef({ w: 0, h: 0 });
  const dragCaptureRef = useRef<{ el: HTMLElement; pointerId: number } | null>(null);
  const isDraggingRef = useRef(false);
  isDraggingRef.current = isDragging;

  // Detect if sidebar is open by checking for ResizableSidebar element
  // TEMPORARILY DISABLED - debugging visibility issue
  /*
  useEffect(() => {
    const checkSidebar = () => {
      const sidebar = document.querySelector('aside');
      const isOpen = !!sidebar;
      const sidebarWidth = sidebar ? (sidebar as HTMLElement).offsetWidth : 0;
      console.log('[ZStack] Sidebar detection:', { 
        isOpen, 
        sidebarWidth,
        previousState: isSidebarOpen 
      });
      
      if (isOpen !== isSidebarOpen) {
        setIsSidebarOpen(isOpen);
      }
    };

    checkSidebar();

    let checkTimeout: NodeJS.Timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(checkTimeout);
      checkTimeout = setTimeout(checkSidebar, 50);
    });
    
    observer.observe(document.body, { 
      childList: true, 
      subtree: true 
    });

    return () => {
      clearTimeout(checkTimeout);
      observer.disconnect();
    };
  }, [isSidebarOpen]);
  */

  // Create stable updatePosition function
  const updatePositionRef = useRef<(() => void) | null>(null);
  
  updatePositionRef.current = () => {
    // Don't update position while dragging
    if (isDragging) {
      return;
    }
    
    // Don't update for 1000ms after drag ends (protection period)
    const now = Date.now();
    if (now - lastDragEndTimeRef.current < 1000) {
      return;
    }
    
    // Debounce: only update every 200ms
    if (now - lastUpdateTimeRef.current < 200) {
      return;
    }
    lastUpdateTimeRef.current = now;
    
    if (controllerRef.current && isPositioned) {
      const parentElement = controllerRef.current.parentElement;
      if (!parentElement) return;
      
      const parentWidth = parentElement.offsetWidth;
      const parentHeight = parentElement.offsetHeight;
      const rect = controllerRef.current.getBoundingClientRect();
      
      if (!rect || rect.width === 0) return;
      
      const controllerWidth = rect.width;
      const controllerHeight = rect.height;
      
      const inset = VIEWPORT_EDGE_INSET_PX;
      const maxX = parentWidth - controllerWidth - inset;
      const maxY = parentHeight - controllerHeight - inset;
      
      setPosition(prev => {
        let newX = prev.x;
        let newY = prev.y;
        
        // Check if parent width changed (sidebar opened/closed)
        if (lastParentWidth > 0 && lastParentWidth !== parentWidth) {
          const widthDelta = parentWidth - lastParentWidth;
          
          // Adjust X position proportionally to maintain relative position
          newX = prev.x + widthDelta;
          
          // Ensure it stays within bounds
          if (newX > maxX) newX = maxX;
          if (newX < inset) newX = inset;
        } else {
          // No width change, just ensure position is within bounds
          if (newX > maxX) newX = maxX;
          if (newX < inset) newX = inset;
          if (newY > maxY) newY = maxY;
          if (newY < inset) newY = inset;
        }
        
        return { x: newX, y: newY };
      });
      
      // Update tracked parent width
      if (lastParentWidth !== parentWidth) {
        setLastParentWidth(parentWidth);
      }
    }
  };

  // Define fetchZStackInfo before any useEffect that uses it
  const fetchZStackInfo = useCallback(async () => {
    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/load/v1/zstack-info`;
      
      const urlWithParams = `${url}?session_id=${encodeURIComponent(sessionId)}`;
      const response = await apiFetch(urlWithParams, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      
      const data = response.data?.data || response.data;
      
      if (data.zstack_info) {
        setZstackInfo(data.zstack_info);
        setCurrentLayer(data.current_layer || 0);
        setIsVisible(!!data.zstack_info.has_zstack);
      } else {
        setZstackInfo(null);
        setIsVisible(false);
      }
    } catch (error) {
      console.error('[ZStack] Error fetching z-stack info:', error);
      setZstackInfo(null);
      setIsVisible(false);
    }
  }, [sessionId]);

  // Initialize position after mount and handle parent resize
  useEffect(() => {
    // While hidden we render null — ref is not attached; skip until visible so
    // initializePosition can run after the panel mounts.
    if (!isVisible) {
      return;
    }

    const updatePosition = () => {
      updatePositionRef.current?.();
    };
    
    // Initial position - right side, vertically centered (relative to parent container)
    const initializePosition = () => {
      if (controllerRef.current) {
        const parentElement = controllerRef.current.parentElement;
        if (!parentElement) {
          return false;
        }
        
        const parentWidth = parentElement.offsetWidth;
        const parentHeight = parentElement.offsetHeight;
        
        if (parentWidth === 0 || parentHeight === 0) {
          return false;
        }
        
        const rect = controllerRef.current.getBoundingClientRect();
        
        let newX, newY;
        
        if (rect && rect.width > 0 && rect.height > 0) {
          const controllerWidth = rect.width;
          const controllerHeight = rect.height;
          const centerY = (parentHeight - controllerHeight) / 2;
          
          newX = parentWidth - controllerWidth - VIEWPORT_EDGE_INSET_PX;
          newY = Math.max(VIEWPORT_EDGE_INSET_PX, centerY);
        } else {
          // Fallback: estimate controller size
          const estimatedWidth = 150;
          const estimatedHeight = 300;
          newX = parentWidth - estimatedWidth - VIEWPORT_EDGE_INSET_PX;
          newY = Math.max(VIEWPORT_EDGE_INSET_PX, (parentHeight - estimatedHeight) / 2);
        }
        
        setPosition({ x: newX, y: newY });
        setLastParentWidth(parentWidth);
        setIsPositioned(true);
        
        return true;
      }
      return false;
    };
    
    // Use requestAnimationFrame to ensure DOM is ready
    if (typeof window !== 'undefined') {
      // Try immediately
      initializePosition();
      
      // Try again after first paint
      requestAnimationFrame(() => {
        initializePosition();
      });
      
      // And once more after layout
      requestAnimationFrame(() => {
        requestAnimationFrame(initializePosition);
      });
      
      // Fallback: retry after layout (avoid stale isPositioned closure from initial hidden render)
      const fallbackTimer = setTimeout(() => {
        const success = initializePosition();
        if (!success && controllerRef.current) {
          const windowWidth = window.innerWidth;
          const windowHeight = window.innerHeight;
          setPosition({
            x: windowWidth - 200,
            y: windowHeight / 2 - 150
          });
          setIsPositioned(true);
        }
      }, 150);
      
      // Listen to window resize to update position when parent size changes
      window.addEventListener('resize', updatePosition);
      
      // Use ResizeObserver to watch parent size changes (e.g., when sidebar opens/closes)
      let resizeObserver: ResizeObserver | null = null;
      let resizeTimeout: NodeJS.Timeout | null = null;
      if (controllerRef.current?.parentElement) {
        resizeObserver = new ResizeObserver(() => {
          // Debounce resize events to avoid excessive updates
          if (resizeTimeout) {
            clearTimeout(resizeTimeout);
          }
          resizeTimeout = setTimeout(() => {
            updatePosition();
          }, 300); // 300ms debounce
        });
        resizeObserver.observe(controllerRef.current.parentElement);
      }
      
      return () => {
        clearTimeout(fallbackTimer);
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
        window.removeEventListener('resize', updatePosition);
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
      };
    }
  }, [isVisible, sessionId]);

  // Fetch z-stack info when component mounts or session changes
  useEffect(() => {
    // Reset positioned state when session changes to trigger re-positioning
    setIsPositioned(false);
    fetchZStackInfo();
  }, [sessionId, fetchZStackInfo]);

  // Listen for slide loaded events to refresh z-stack info
  useEffect(() => {
    const handleSlideLoaded = (event: CustomEvent) => {
      console.log('[ZStack] Slide loaded event received, refreshing z-stack info');
      fetchZStackInfo();
    };

    window.addEventListener('slideLoaded', handleSlideLoaded as EventListener);

    return () => {
      window.removeEventListener('slideLoaded', handleSlideLoaded as EventListener);
    };
  }, [sessionId, fetchZStackInfo]); // Re-subscribe when sessionId changes

  // Pointer drag: capture on the handle so movement stays 1:1 with cursor (no transition on left/top).
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: PointerEvent) => {
      if (!controllerRef.current) return;

      const parentElement = controllerRef.current.parentElement;
      if (!parentElement) return;

      const parentRect = parentElement.getBoundingClientRect();
      const { w: controllerWidth, h: controllerHeight } = dragSizeRef.current;

      let newX = e.clientX - parentRect.left - dragOffset.x;
      let newY = e.clientY - parentRect.top - dragOffset.y;

      const inset = VIEWPORT_EDGE_INSET_PX;
      const minX = inset;
      const minY = inset;
      const maxX = parentRect.width - controllerWidth - inset;
      const maxY = parentRect.height - controllerHeight - inset;

      newX = Math.max(minX, Math.min(newX, maxX));
      newY = Math.max(minY, Math.min(newY, maxY));

      setPosition({ x: newX, y: newY });
    };

    const endDrag = (e: PointerEvent) => {
      const cap = dragCaptureRef.current;
      if (cap && cap.pointerId === e.pointerId) {
        try {
          cap.el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore if not captured */
        }
        dragCaptureRef.current = null;
      }
      lastDragEndTimeRef.current = Date.now();
      setIsDragging(false);
    };

    window.addEventListener('pointermove', handleMove, { passive: true, capture: true });
    window.addEventListener('pointerup', endDrag, { capture: true });
    window.addEventListener('pointercancel', endDrag, { capture: true });

    return () => {
      window.removeEventListener('pointermove', handleMove, true);
      window.removeEventListener('pointerup', endDrag, true);
      window.removeEventListener('pointercancel', endDrag, true);
    };
  }, [isDragging, dragOffset]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    const panel = controllerRef.current;
    if (!panel) return;

    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    dragSizeRef.current = { w: rect.width, h: rect.height };
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    const handleEl = e.currentTarget;
    dragCaptureRef.current = { el: handleEl, pointerId: e.pointerId };
    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch {
      dragCaptureRef.current = null;
    }
    setIsDragging(true);
  };

  const toggleExpanded = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering drag
    e.preventDefault(); // Prevent default behavior
    setIsExpanded(!isExpanded);
  };

  const handleLayerChange = async (newLayer: number) => {
    if (!zstackInfo || !zstackInfo.has_zstack) return;

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/load/v1/set-z-layer`;
      
      const response = await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          z_layer: newLayer
        }),
        returnAxiosFormat: true,
      });

      const data = response.data?.data || response.data;
      
      setCurrentLayer(newLayer);
      
      // Trigger refresh of viewer
      if (onLayerChange) {
        onLayerChange(newLayer);
      }
      
      // Trigger a custom event to notify OpenSeadragon to refresh
      window.dispatchEvent(new CustomEvent('zLayerChanged', { 
        detail: { layer: newLayer } 
      }));
    } catch (error) {
      console.error('[ZStack] Error setting z-layer:', error);
    }
  };

  const goToPreviousLayer = () => {
    if (currentLayer > 0) {
      handleLayerChange(currentLayer - 1);
    }
  };

  const goToNextLayer = () => {
    if (zstackInfo && currentLayer < zstackInfo.layer_count - 1) {
      handleLayerChange(currentLayer + 1);
    }
  };

  /** Keep panel fully inside parent (e.g. move up when expanding near bottom-right). */
  const clampPanelToParent = useCallback(() => {
    if (isDraggingRef.current) return;
    const el = controllerRef.current;
    if (!el || !isPositioned) return;
    const parent = el.parentElement;
    if (!parent) return;
    const inset = VIEWPORT_EDGE_INSET_PX;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (pw <= 0 || ph <= 0 || w <= 0 || h <= 0) return;
    const maxX = Math.max(inset, pw - w - inset);
    const maxY = Math.max(inset, ph - h - inset);
    setPosition((prev) => ({
      x: Math.min(Math.max(inset, prev.x), maxX),
      y: Math.min(Math.max(inset, prev.y), maxY),
    }));
  }, [isPositioned]);

  useLayoutEffect(() => {
    if (!isVisible || !zstackInfo?.has_zstack || !isPositioned) return;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => clampPanelToParent());
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
    };
  }, [
    isExpanded,
    zstackInfo?.layer_count,
    isVisible,
    isPositioned,
    zstackInfo?.has_zstack,
    clampPanelToParent,
  ]);

  useEffect(() => {
    if (!isVisible || !zstackInfo?.has_zstack) return;
    const el = controllerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => clampPanelToParent());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [isVisible, zstackInfo?.has_zstack, clampPanelToParent]);

  // After expand/collapse CSS transition, clamp once more (ResizeObserver may miss final tick)
  useEffect(() => {
    if (!isVisible || !zstackInfo?.has_zstack || !isPositioned) return;
    const t = window.setTimeout(() => clampPanelToParent(), 320);
    return () => clearTimeout(t);
  }, [isExpanded, isVisible, isPositioned, zstackInfo?.has_zstack, clampPanelToParent]);

  // Don't render if no z-stack detected
  if (!isVisible || !zstackInfo || !zstackInfo.has_zstack) {
    return null;
  }

  return (
    <div 
      ref={controllerRef}
      className={`
        pointer-events-auto absolute rounded-lg shadow-lg backdrop-blur-md
        bg-card/95 border border-border
        ${isExpanded ? 'min-w-[120px] p-3' : 'min-w-[80px] p-2'}
        ${isDragging ? 'shadow-2xl cursor-grabbing select-none touch-none' : ''}
      `}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        visibility: isPositioned ? 'visible' : 'hidden',
        zIndex: isDragging ? 40 : 10,
        // Animate size only — do not transition left/top so clamp/drag track real layout (expand at bottom moves exactly with height).
        transition: isDragging
          ? 'none'
          : 'min-width 280ms cubic-bezier(0.32, 0.72, 0, 1), padding 280ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 200ms ease',
      }}
    >
      {/* Draggable Header */}
      <div 
        className={`
          flex items-center gap-1.5 text-foreground font-semibold text-[13px] 
          border-b border-border/10 pb-2 select-none relative
          ${isExpanded ? 'mb-3' : 'mb-0 border-0 pb-0'}
          ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}
        `}
        style={
          isDragging
            ? undefined
            : {
                transition:
                  'margin-bottom 280ms cubic-bezier(0.32, 0.72, 0, 1), padding-bottom 280ms cubic-bezier(0.32, 0.72, 0, 1), border-color 200ms ease',
              }
        }
        onPointerDown={handlePointerDown}
      >
        <Layers size={16} className="text-foreground" />
        <span className="flex-1 text-foreground">Z-Stack</span>
        <button 
          className="
            bg-transparent border-0 text-muted-foreground cursor-pointer p-0.5 
            flex items-center justify-center transition-all duration-200 
            rounded z-[1] relative hover:bg-accent hover:text-foreground 
            active:bg-accent/80
          "
          onClick={toggleExpanded}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          title={isExpanded ? "Collapse" : "Expand"}
        >
          {isExpanded ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      
      {/* Expanded Content */}
      {isExpanded && (
        <>
          <div className="flex flex-col gap-3 items-center">
            {/* Layer navigation */}
            <div className="flex flex-col items-center gap-1">
              <button 
                onClick={goToPreviousLayer} 
                disabled={currentLayer === 0}
                className={`
                  border-0 rounded-md text-primary-foreground cursor-pointer 
                  p-1.5 transition-all duration-200 flex items-center justify-center 
                  w-9 h-9 hover:scale-105
                  disabled:cursor-not-allowed disabled:opacity-50
                  ${currentLayer === 0 ? 'bg-primary/30' : 'bg-primary hover:bg-primary/90'}
                `}
                title="Previous Layer"
              >
                <ChevronUp size={20} />
              </button>
              
              <div className="flex items-center gap-1 px-3 py-2 bg-muted/30 rounded-md text-base font-semibold text-foreground min-w-[60px] justify-center">
                <span className="text-lg text-primary">{currentLayer + 1}</span>
                <span className="text-muted-foreground text-sm">/</span>
                <span className="text-foreground text-sm">{zstackInfo.layer_count}</span>
              </div>
              
              <button 
                onClick={goToNextLayer} 
                disabled={currentLayer === zstackInfo.layer_count - 1}
                className={`
                  border-0 rounded-md text-primary-foreground cursor-pointer 
                  p-1.5 transition-all duration-200 flex items-center justify-center 
                  w-9 h-9 hover:scale-105
                  disabled:cursor-not-allowed disabled:opacity-50
                  ${currentLayer === zstackInfo.layer_count - 1 ? 'bg-primary/30' : 'bg-primary hover:bg-primary/90'}
                `}
                title="Next Layer"
              >
                <ChevronDown size={20} />
              </button>
            </div>
          </div>

          {/* Layer indicator */}
          <div className="mt-2 pt-2 border-t border-border/10 text-center text-[11px] text-foreground">
            Layer {currentLayer + 1} of {zstackInfo.layer_count}
          </div>
        </>
      )}
      
      {/* Collapsed Content - show minimal info */}
      {!isExpanded && (
        <div className="flex items-center justify-center py-1 gap-0.5 font-semibold">
          <span className="text-sm text-primary">{currentLayer + 1}</span>
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-foreground text-sm">{zstackInfo.layer_count}</span>
        </div>
      )}
    </div>
  );
};

export default ZStackController;

