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

  // Draw function
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas dimensions
    canvas.width = width;
    canvas.height = height;

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

    // Calculate smooth curve
    const curvePoints = calculateSmoothCurve(data);
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
  }, [data, threshold, loading, calculateSmoothCurve, width, height, margins, chartWidth, chartHeight, isHovering, disabled, hoverPosition]);

  // Update threshold
  const updateThreshold = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const relativeX = Math.max(0, Math.min(1, (x - margins.left) / chartWidth));
    
    setThreshold(relativeX);
    
    // Debounce onChange to avoid frequent API calls
    if (onChangeTimeoutRef.current) {
      clearTimeout(onChangeTimeoutRef.current);
    }
    
    onChangeTimeoutRef.current = setTimeout(() => {
      onChange?.(relativeX);
    }, 100); // 100ms debounce for onChange callback
  }, [disabled, margins.left, chartWidth, onChange]);

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
    if (disabled || !isNearHandle(e.clientX, e.clientY)) return;
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
    
    if (isDragging) {
      updateThreshold(e.clientX);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
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
      setThreshold(newThreshold);
      
      // Debounce onChange to avoid frequent API calls
      if (onChangeTimeoutRef.current) {
        clearTimeout(onChangeTimeoutRef.current);
      }
      
      onChangeTimeoutRef.current = setTimeout(() => {
        onChange?.(newThreshold);
      }, 100); // 100ms debounce for onChange callback
    }
  };

  // Listen for threshold changes
  useEffect(() => {
    if (Math.abs(initialThreshold - threshold) > 0.001) {
      setThreshold(initialThreshold);
    }
  }, [initialThreshold, threshold]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (onChangeTimeoutRef.current) {
        clearTimeout(onChangeTimeoutRef.current);
      }
    };
  }, []);

  // Redraw
  useEffect(() => {
    draw();
  }, [draw]);

  // Global mouse events
  useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false);
    
    if (isDragging) {
      document.addEventListener('mouseup', handleGlobalMouseUp);
      return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
    }
  }, [isDragging]);

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
            cursor: disabled ? 'default' : (isDragging ? 'grabbing' : (isHovering ? 'grab' : 'pointer')),
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