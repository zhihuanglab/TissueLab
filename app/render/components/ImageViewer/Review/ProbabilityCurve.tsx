"use client";

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";

interface ProbabilityCurveProps {
  /** Histogram data or raw probability array */
  data: number[];
  /** Initial threshold, default 0.5 */
  initialThreshold?: number;
  /** Callback when threshold is updated by dragging or programmatically */
  onChange?: (threshold: number) => void;
  /** Width and height, default 560x220 */
  width?: number;
  height?: number;
  /** Whether to disable interaction */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
}

interface Point {
  x: number;
  y: number;
}

const ProbabilityCurve: React.FC<ProbabilityCurveProps> = ({
  data,
  initialThreshold = 0.5,
  onChange,
  width = 560,
  height = 220,
  disabled = false,
  loading = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const onChangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const idleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Use ref to track drag threshold and drag state
  const dragThresholdRef = useRef(initialThreshold);
  const isDraggingRef = useRef(false);
  const lastTriggeredThresholdRef = useRef(initialThreshold);

  const margins = useMemo(() => ({ top: 12, right: 12, bottom: 24, left: 28 }), []);
  const chartWidth = useMemo(() => width - margins.left - margins.right, [width, margins]);
  const chartHeight = useMemo(() => height - margins.top - margins.bottom, [height, margins]);

  // Generate smooth curve from histogram data
  const calculateSmoothCurve = useCallback((histogramData: number[], points = 256) => {
    if (!histogramData || histogramData.length === 0) return [];
    
    // Filter and clean data
    const cleanedHist = histogramData.filter(x => typeof x === 'number' && !isNaN(x) && x >= 0);
    if (cleanedHist.length === 0) return [];

    // Use simple interpolation and smoothing to create curve from histogram
    const xs = Array.from({ length: points }, (_, i) => i / (points - 1));
    const binWidth = 1.0 / cleanedHist.length;
    
    // First perform linear interpolation
    const interpolated = xs.map(x => {
      const binIndex = Math.floor(x / binWidth);
      const binProgress = (x % binWidth) / binWidth;
      
      if (binIndex >= cleanedHist.length - 1) {
        return cleanedHist[cleanedHist.length - 1] || 0;
      }
      
      const current = cleanedHist[binIndex] || 0;
      const next = cleanedHist[binIndex + 1] || 0;
      
      return current + (next - current) * binProgress;
    });
    
    // Apply simple moving average smoothing
    const smoothed = interpolated.map((value, i) => {
      const radius = 3;
      let sum = 0;
      let count = 0;
      
      for (let j = Math.max(0, i - radius); j <= Math.min(interpolated.length - 1, i + radius); j++) {
        sum += interpolated[j];
        count++;
      }
      
      return sum / count;
    });
    
    // Normalize
    const max = Math.max(...smoothed, 1e-6);
    return xs.map((x, i) => ({ x, y: smoothed[i] / max }));
  }, []);
  
  // Cache curve calculation result to avoid recalculating on every render
  const cachedCurvePoints = useMemo(() => {
    if (!data || data.length === 0) return [];
    return calculateSmoothCurve(data);
  }, [data, calculateSmoothCurve]);

  // Draw function with performance optimizations
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas dimensions only if changed
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Show status if loading or no data
    if (loading || !data || data.length === 0) {
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#6b7280';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(loading ? 'Loading...' : 'No data', width / 2, height / 2);
      return;
    }

    // Use cached curve points
    const curvePoints = cachedCurvePoints;
    if (curvePoints.length === 0) return;

    // Draw coordinate system (pure black)
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // X-axis
    ctx.moveTo(margins.left, height - margins.bottom);
    ctx.lineTo(width - margins.right, height - margins.bottom);
    // Y-axis
    ctx.moveTo(margins.left, margins.top);
    ctx.lineTo(margins.left, height - margins.bottom);
    ctx.stroke();

    // X-axis arrow
    const arrowSize = 5;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(width - margins.right, height - margins.bottom);
    ctx.lineTo(width - margins.right - arrowSize, height - margins.bottom - arrowSize/2);
    ctx.lineTo(width - margins.right - arrowSize, height - margins.bottom + arrowSize/2);
    ctx.closePath();
    ctx.fill();

    // Y-axis arrow
    ctx.beginPath();
    ctx.moveTo(margins.left, margins.top);
    ctx.lineTo(margins.left - arrowSize/2, margins.top + arrowSize);
    ctx.lineTo(margins.left + arrowSize/2, margins.top + arrowSize);
    ctx.closePath();
    ctx.fill();

    // X-axis 0.5 tick mark
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    const x05 = margins.left + (0.5 * chartWidth);
    ctx.beginPath();
    ctx.moveTo(x05, height - margins.bottom);
    ctx.lineTo(x05, height - margins.bottom + 4);
    ctx.stroke();

    // Draw X-axis labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    [0, 0.5, 1].forEach(value => {
      const x = margins.left + (value * chartWidth);
      ctx.fillText(value.toFixed(1), x, height - 2);
    });

    // Draw highlight area (from threshold to 1.0)
    if (threshold < 1.0) {
      const thresholdX = margins.left + (threshold * chartWidth);
      const endX = margins.left + chartWidth;
      
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; // Semi-transparent blue
      ctx.fillRect(
        thresholdX,
        margins.top,
        endX - thresholdX,
        chartHeight
      );
    }

    // Draw smooth curve (light blue)
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    curvePoints.forEach((point, index) => {
      const x = margins.left + (point.x * chartWidth);
      const y = height - margins.bottom - (point.y * chartHeight);
      
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Draw threshold line (dark blue-purple)
    const thresholdX = margins.left + (threshold * chartWidth);
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(thresholdX, margins.top);
    ctx.lineTo(thresholdX, height - margins.bottom);
    ctx.stroke();

    // Hover tooltip
    if (isHovering && !disabled) {
      const tooltipText = `Threshold: ${threshold.toFixed(3)}`;
      // Ensure we measure with the same font we will draw with
      ctx.font = '11px Arial';
      ctx.textAlign = 'start';
      const metrics = ctx.measureText(tooltipText);
      const tooltipX = Math.max(10, Math.min(width - metrics.width - 20, hoverPosition.x - metrics.width / 2));
      const tooltipY = hoverPosition.y - 30;

      // Draw tooltip background (cover full text)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(tooltipX - 6, tooltipY - 16, metrics.width + 12, 20);

      // Draw tooltip text
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tooltipText, tooltipX, tooltipY - 2);
    }
  }, [data, threshold, loading, cachedCurvePoints, width, height, margins, chartWidth, chartHeight, isHovering, disabled, hoverPosition]);

  // Trigger change with idle detection
  const triggerChange = useCallback(() => {
    const value = dragThresholdRef.current;
    // Only trigger if value actually changed
    if (Math.abs(value - lastTriggeredThresholdRef.current) > 0.001) {
      lastTriggeredThresholdRef.current = value;
      onChange?.(value);
    }
  }, [onChange]);

  // Update threshold - visual only during drag
  const updateThreshold = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    
    // Calculate chartWidth directly to avoid dependency issues
    const marginLeft = 28;
    const marginRight = 12;
    const actualChartWidth = width - marginLeft - marginRight;
    
    const relativeX = Math.max(0, Math.min(1, (x - marginLeft) / actualChartWidth));
    
    // Store in ref
    dragThresholdRef.current = relativeX;
    
    // Update state immediately for visual feedback
    setThreshold(relativeX);
    
    // Clear any pending idle timeout
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }
    
    // Set idle timeout - if user stops dragging for 400ms, trigger change
    idleTimeoutRef.current = setTimeout(() => {
      if (isDraggingRef.current) {
        triggerChange();
      }
    }, 400);
  }, [disabled, width, triggerChange]);

  // Check if near threshold handle
  const isNearHandle = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    const thresholdX = margins.left + (threshold * chartWidth);
    
    // Check if near threshold line (horizontal distance within 8px, vertical within chart range)
    const horizontalDistance = Math.abs(x - thresholdX);
    const inVerticalRange = y >= margins.top && y <= height - margins.bottom;
    
    return horizontalDistance <= 8 && inVerticalRange;
  }, [threshold, margins, chartWidth, height]);

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    isDraggingRef.current = true;
    setIsDragging(true);
    updateThreshold(e.clientX);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    
    const nearHandle = isNearHandle(e.clientX, e.clientY);
    setIsHovering(nearHandle);
    
    if (nearHandle) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const thresholdX = margins.left + (threshold * chartWidth);
        setHoverPosition({ x: thresholdX, y: margins.top + chartHeight / 2 });
      }
    }
    
    // Use ref for immediate check
    if (isDraggingRef.current) {
      updateThreshold(e.clientX);
    }
  };

  const handleMouseUp = () => {
    if (isDraggingRef.current) {
      // Clear all pending timeouts to prevent race conditions
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
      if (onChangeTimeoutRef.current) {
        clearTimeout(onChangeTimeoutRef.current);
      }
      // Send final value immediately
      triggerChange();
    }
    isDraggingRef.current = false;
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    // Don't stop dragging on mouse leave - let global handler deal with it
    // This allows dragging outside the canvas
    setIsHovering(false);
  };

  // Keyboard event handler
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    
    let delta = 0;
    if (e.key === 'ArrowLeft') {
      delta = e.shiftKey ? -0.05 : -0.01;
    } else if (e.key === 'ArrowRight') {
      delta = e.shiftKey ? 0.05 : 0.01;
    }
    
    if (delta !== 0) {
      e.preventDefault();
      const newThreshold = Math.max(0, Math.min(1, threshold + delta));
      dragThresholdRef.current = newThreshold;
      setThreshold(newThreshold);
      
      // Debounce onChange for keyboard - only trigger after user stops pressing
      if (onChangeTimeoutRef.current) {
        clearTimeout(onChangeTimeoutRef.current);
      }
      
      onChangeTimeoutRef.current = setTimeout(() => {
        triggerChange();
      }, 400);
    }
  };

  // Listen for threshold changes from parent only when not dragging
  useEffect(() => {
    if (!isDraggingRef.current && Math.abs(initialThreshold - dragThresholdRef.current) > 0.001) {
      dragThresholdRef.current = initialThreshold;
      lastTriggeredThresholdRef.current = initialThreshold;
      setThreshold(initialThreshold);
    }
  }, [initialThreshold]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (onChangeTimeoutRef.current) {
        clearTimeout(onChangeTimeoutRef.current);
      }
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
    };
  }, []);

  // Redraw
  useEffect(() => {
    draw();
  }, [draw]);

  // Global mouse events for dragging outside canvas
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const marginLeft = 28;
          const marginRight = 12;
          const actualChartWidth = width - marginLeft - marginRight;
          const relativeX = Math.max(0, Math.min(1, (x - marginLeft) / actualChartWidth));
          
          dragThresholdRef.current = relativeX;
          setThreshold(relativeX);
          
          // Reset idle timeout
          if (idleTimeoutRef.current) {
            clearTimeout(idleTimeoutRef.current);
          }
          idleTimeoutRef.current = setTimeout(() => {
            if (isDraggingRef.current) {
              triggerChange();
            }
          }, 400);
        }
      }
    };

    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        // Clear all pending timeouts to prevent race conditions
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
        }
        if (onChangeTimeoutRef.current) {
          clearTimeout(onChangeTimeoutRef.current);
        }
        triggerChange();
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };
    
    if (isDragging) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleGlobalMouseMove);
        document.removeEventListener('mouseup', handleGlobalMouseUp);
      };
    }
  }, [isDragging, width, triggerChange]);

  return (
    <div>
      <h6 style={{ fontSize: '14px', fontWeight: '500', color: '#374151', marginBottom: '8px' }}>
        Choose probability threshold{' '}
        <span style={{ backgroundColor: '#f9fafb' }}>
          (Current: {threshold.toFixed(3)})
        </span>
      </h6>
      
      <div 
        style={{ 
          border: '1px solid #e5e7eb', 
          borderRadius: '6px', 
          backgroundColor: 'white',
          width: `${width}px`,
          height: `${height}px`
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ 
            width: `${width}px`, 
            height: `${height}px`, 
            cursor: disabled ? 'default' : (isDragging ? 'ew-resize' : (isHovering ? 'grab' : 'pointer')),
            display: 'block'
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onKeyDown={handleKeyDown}
          tabIndex={disabled ? -1 : 0}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(threshold.toFixed(3))}
          aria-label="Probability threshold selector"
        />
      </div>
      
      <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
        <span style={{ color: '#3b82f6', fontWeight: '500' }}>💡</span>
        <div>
          Drag the handle to set the minimum probability. Values in the shaded region are included.
        </div>
      </div>
    </div>
  );
};

export default ProbabilityCurve;