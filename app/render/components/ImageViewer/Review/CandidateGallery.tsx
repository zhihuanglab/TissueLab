"use client";

import React, { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ReviewCandidate } from "@/store/slices/reviewSlice";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, RotateCcw, ChevronDown, X } from "lucide-react";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { apiFetch } from '@/utils/common/apiFetch';

interface CandidateGalleryProps {
  candidates: ReviewCandidate[];
  loading: boolean;
  error: string | null;
  total: number;
  page: number;
  pageSize: number;
  zoom: number;
  sort?: 'asc' | 'desc';
  selectedCandidateId?: string;
  slideId?: string; // Add slideId prop for correct slide identification
  availableClasses?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  targetClassName?: string;
  showReclassified?: boolean;
  onPageChange: (page: number) => void;
  onLabelCandidate: (cellId: string, label: 1 | 0) => void;
  onRemoveCandidate: (cellId: string) => void;
  onReclassifyCandidate?: (cellId: string, newClass: string) => void;
  onRetry: () => void;
  onSortChange?: (sort: 'asc' | 'desc') => void;
  onCandidateClick?: (candidate: ReviewCandidate) => void;
  onShowReclassifiedChange?: (show: boolean) => void;
  // New: Batch processing related props
  pendingReclassifications?: Map<string, string>; // cellId -> newClassName
  onPendingReclassification?: (cellId: string, newClass: string) => void;
  onCancelPendingReclassification?: (cellId: string) => void;
}

const CandidateGallery: React.FC<CandidateGalleryProps> = ({
  candidates,
  loading,
  error,
  total,
  page,
  pageSize,
  zoom,
  sort = 'asc',
  selectedCandidateId,
  slideId, // Extract slideId prop
  availableClasses = [],
  targetClassName,
  showReclassified = true,
  onPageChange,
  onLabelCandidate,
  onRemoveCandidate,
  onReclassifyCandidate,
  onRetry,
  onSortChange,
  onCandidateClick,
  onShowReclassifiedChange,
  // New: Batch processing related props
  pendingReclassifications = new Map(),
  onPendingReclassification,
  onCancelPendingReclassification,
}) => {
  // Add safety check for candidates - memoize to prevent unnecessary re-renders
  const safeCandidates = useMemo(() => candidates || [], [candidates]);
  
  
  const totalPages = Math.ceil(total / pageSize);
  

  // Keyboard shortcuts for Y/N labeling
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (safeCandidates.length === 0 || loading) return;

    // Find the first unlabeled candidate
    const unlabeledCandidate = safeCandidates.find(c => c.label === undefined);
    if (!unlabeledCandidate) return;

    if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      onLabelCandidate(unlabeledCandidate.cell_id, 1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      onLabelCandidate(unlabeledCandidate.cell_id, 0);
    }
  }, [safeCandidates, loading, onLabelCandidate]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Loading state
  if (loading) {
    return (
      <div>
        <h6 className="text-sm font-medium text-gray-700 mb-2">
          Candidate Pool (Loading...)
        </h6>
        <div className="border border-gray-200 rounded p-4">
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="aspect-square bg-gray-100 animate-pulse rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div>
        <h6 className="text-sm font-medium text-gray-700 mb-2">
          Candidate Pool (Error)
        </h6>
        <div className="border border-red-200 rounded p-4 bg-red-50">
          <div className="text-center">
            <div className="text-red-600 mb-2">
              <svg className="mx-auto h-8 w-8" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-sm text-red-700 mb-3">{error}</p>
            <Button onClick={onRetry} size="sm" variant="outline">
              <RotateCcw className="h-4 w-4 mr-1" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (safeCandidates.length === 0) {
    return (
      <div>
        <h6 className="text-sm font-medium text-gray-700 mb-2">
          Candidate Pool (Empty)
        </h6>
        <div className="border border-gray-200 rounded p-4 bg-gray-50">
          <div className="text-center text-gray-500">
            <div className="mb-2">
              <svg className="mx-auto h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
            </div>
            <p className="text-sm">No candidates found with current settings</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header with controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div>
          <h6 className="text-sm font-medium text-foreground">
            Candidate Pool ({total} total)
          </h6>
          <div className="text-xs text-muted-foreground mt-1">
            Use Y/N keys for quick labeling
          </div>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Sort toggle - only show if onSortChange is provided */}
          {onSortChange && (
            <>
              <span className="text-xs text-muted-foreground font-medium">
                Uncertainty:
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSortChange(sort === 'asc' ? 'desc' : 'asc')}
                style={{ fontSize: '11px', padding: '2px 8px', height: '24px' }}
              >
                {sort === 'asc' ? 'Low→High' : 'High→Low'}
              </Button>
            </>
          )}
          
          {/* Reclassified filter toggle */}
          {onShowReclassifiedChange && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showReclassified}
                onChange={(e) => onShowReclassifiedChange(e.target.checked)}
                style={{ width: '14px', height: '14px' }}
              />
              <span className="text-xs text-muted-foreground select-none">
                Show reclassified
              </span>
            </label>
          )}
        </div>
      </div>

      {/* Gallery container - fixed height like loading state */}
      <div className="border border-border rounded-md bg-background">
        {/* Gallery grid - same as loading state */}
        <div style={{ padding: '8px' }}>
          <div className="grid grid-cols-4 gap-2">
            {/* Display only first 12 candidates (3 rows × 4 columns) */}
            {safeCandidates.slice(0, 12).map((candidate, index) => (
              <CandidateTile
                key={`${candidate.cell_id}-${index}`}
                candidate={candidate}
                zoom={zoom}
                targetClassName={targetClassName}
                isSelected={selectedCandidateId === candidate.cell_id}
                slideId={slideId} // Pass slideId to CandidateTile
                availableClasses={availableClasses}
                onLabelCandidate={onLabelCandidate}
                onRemoveCandidate={onRemoveCandidate}
                onReclassifyCandidate={onReclassifyCandidate}
                onCandidateClick={onCandidateClick}
                // New: Batch processing related
                pendingReclassification={pendingReclassifications.get(candidate.cell_id)}
                onPendingReclassification={onPendingReclassification}
                onCancelPendingReclassification={onCancelPendingReclassification}
              />
            ))}
          </div>
        </div>

        {/* Fixed pagination area - only when needed */}
        {totalPages > 1 && (
          <div className="border-t border-border px-2 py-2 pb-3 bg-muted" style={{ minHeight: '40px' }}>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages} ({total} total)
              </div>
              
              <div className="flex items-center space-x-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => onPageChange(page - 1)}
                  className="h-6 w-6 p-0"
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                
                {/* Editable page input - click to edit, Enter to jump */}
                <div className="relative flex items-center text-xs font-medium group">
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    defaultValue={page + 1}
                    key={page}
                    aria-label="Page number, press Enter to jump"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const target = e.target as HTMLInputElement;
                        const newPage = Math.max(1, Math.min(totalPages, parseInt(target.value) || 1));
                        onPageChange(newPage - 1);
                        target.blur();
                      }
                    }}
                    onBlur={(e) => {
                      e.target.value = String(page + 1);
                    }}
                    className="w-10 h-5 text-center text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="px-1">/</span>
                  <span>{totalPages}</span>
                  {/* CSS tooltip - shows above on hover */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    Press Enter to jump
                  </div>
                </div>
                
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => onPageChange(page + 1)}
                  className="h-6 w-6 p-0"
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Individual candidate tile component
interface CandidateTileProps {
  candidate: ReviewCandidate;
  zoom: number;
  targetClassName?: string;
  isSelected?: boolean;
  slideId?: string; // Add slideId prop
  availableClasses?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  onLabelCandidate: (cellId: string, label: 1 | 0) => void;
  onRemoveCandidate: (cellId: string) => void;
  onReclassifyCandidate?: (cellId: string, newClass: string) => void;
  onCandidateClick?: (candidate: ReviewCandidate) => void;
  // New: Batch processing related
  pendingReclassification?: string; // Target class name for pending reclassification
  onPendingReclassification?: (cellId: string, newClass: string) => void;
  onCancelPendingReclassification?: (cellId: string) => void;
}

const CandidateTile: React.FC<CandidateTileProps> = ({
  candidate,
  zoom,
  targetClassName,
  isSelected,
  slideId, // Add slideId parameter
  availableClasses = [],
  onLabelCandidate,
  onRemoveCandidate,
  onReclassifyCandidate,
  onCandidateClick,
  // New: Batch processing related
  pendingReclassification,
  onPendingReclassification,
  onCancelPendingReclassification,
}) => {
  const { cell_id, prob, crop, label } = candidate;
  const { image, bbox, bounds, contour } = crop;
  
  
  const [showDropdown, setShowDropdown] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  
  // Z-stack layer selection
  const [fixedZLayer, setFixedZLayer] = useState<number | null>(null);
  const [layerImage, setLayerImage] = useState<string | null>(null);
  const [layerLoading, setLayerLoading] = useState(false);
  
  // Check if candidate has z-stack info
  const isZStack = (candidate.crop as any)?.is_zstack === true;
  const numZLayers = (candidate.crop as any)?.num_z_layers || 1;

  // Special classes that don't show probability
  const specialClasses = new Set(["Other", "Not Sure", "Incorrect Segmentation"]);
  const isSpecialClass = specialClasses.has(targetClassName || "");
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleImageError = useCallback(() => {
    if (retryCount < 3) {
      const delay = (retryCount + 1) * 1000;
      setTimeout(() => {
        setRetryCount(prev => prev + 1);
        setImageError(false);
      }, delay);
    } else {
      setImageError(true);
    }
  }, [retryCount]);

  // Reset error state when image URL changes (for reclassified images)
  useEffect(() => {
    setImageError(false);
    setRetryCount(0);
  }, [image]);
  
  // Load specific z-layer when user selects a fixed layer
  const loadFixedZLayer = useCallback(async (layerIdx: number) => {
    if (!slideId || !isZStack) return;
    
    setLayerLoading(true);
    try {
      const payload = {
        slide_id: slideId,
        cell_id: cell_id,
        centroid: candidate.centroid,
        window_size_px: 128,
        fixed_z_layer: layerIdx,  
        contour_type: null  
      };
      
      const response = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
          returnAxiosFormat: true,
        }
      );
      
      const body = response.data as { image?: string; data?: { image?: string } };
      const img = body?.data?.image ?? body?.image;
      if (img) {
        setLayerImage(img);
      }
    } catch (error) {
      console.error('[Z-Stack] Failed to load layer:', error);
    } finally {
      setLayerLoading(false);
    }
  }, [slideId, cell_id, candidate.centroid, isZStack]);
  
  // Handle layer selection
  const handleLayerSelect = useCallback((layerIdx: number | null) => {
    setFixedZLayer(layerIdx);
    if (layerIdx !== null) {
      loadFixedZLayer(layerIdx);
    } else {
      setLayerImage(null);  // Reset to show GIF
    }
  }, [loadFixedZLayer]);

  const handleClassSelect = (selectedClass: string) => {
    setShowDropdown(false);
    
    // Batch processing mode: don't call API immediately, cache the selection
    if (onPendingReclassification) {
      try {
        onPendingReclassification(cell_id, selectedClass);
      } catch (error) {
        console.error('[AL CandidateGallery] Error in onPendingReclassification:', error);
      }
    } else if (onReclassifyCandidate) {
      // Compatible with old mode: if no batch processing handler, call API immediately
      try {
        onReclassifyCandidate(cell_id, selectedClass);
      } catch (error) {
        console.error('[AL CandidateGallery] Error in onReclassifyCandidate:', error);
      }
    }
  };

  // Calculate dropdown position
  const updateDropdownPosition = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.top - 8, // 8px above the button
        left: rect.left,
        width: rect.width
      });
    }
  };

  // No longer need click outside handler - dropdown only closes via close button

  const fixedOptions = [
    { id: "Other", name: "Other", color: "#F3F4F5", isTemporary: true },
    { id: "Not Sure", name: "Not Sure", color: "#FED7AA", isTemporary: true },
    { id: "Incorrect Segmentation", name: "Incorrect Segmentation", color: "#FECACA", isTemporary: true }
  ];

  // Calculate red box position based on contour (like nuclei.io-main implementation)
  // Memoize to prevent recalculation on every render and avoid boundary shrinking
  const redBoxStyle = useMemo(() => {
    if (contour && contour.length > 0) {
      try {
        // Find min/max coordinates from contour points
        const xs = contour.map(p => p.x);
        const ys = contour.map(p => p.y);
        let minX = Math.min(...xs);
        let maxX = Math.max(...xs);
        let minY = Math.min(...ys);
        let maxY = Math.max(...ys);
        
        // Coordinate system fix: Convert from slide coordinates to patch coordinates
        // If contour values are much larger than 128, they're in slide coordinates
        const isSlideCoordinates = minX > 128 || minY > 128 || maxX > 1000 || maxY > 1000;
        
        if (isSlideCoordinates && bounds) {
          // Convert from slide coordinates to 128x128 patch coordinates
          minX = (minX - bounds.x) * (128 / bounds.w);
          maxX = (maxX - bounds.x) * (128 / bounds.w);
          minY = (minY - bounds.y) * (128 / bounds.h);
          maxY = (maxY - bounds.y) * (128 / bounds.h);
        }
        
        // Add offset like nuclei.io-main (offset_on_screen)
        const offset = 8; // pixels offset (match nuclei.io-main default)
        const left = Math.max(0, minX - offset);
        const top = Math.max(0, minY - offset);
        const right = Math.min(128, maxX + offset);
        const bottom = Math.min(128, maxY + offset);
        const width = right - left;
        const height = bottom - top;
        
        // Ensure valid dimensions
        if (width > 0 && height > 0) {
          return {
            position: 'absolute' as const,
            left: `${(left / 128) * 100}%`,
            top: `${(top / 128) * 100}%`,
            width: `${(width / 128) * 100}%`,
            height: `${(height / 128) * 100}%`,
            border: '2px solid #cc0000',
            backgroundColor: 'transparent',
            pointerEvents: 'none' as const,
          };
        }
      } catch (error) {
        console.error('Error calculating contour box:', error);
      }
    }
    
    // Fallback to bbox if contour calculation fails
    if (bbox) {
      return {
        position: 'absolute' as const,
        left: `${(bbox.x / 128) * 100}%`,
        top: `${(bbox.y / 128) * 100}%`,
        width: `${(bbox.w / 128) * 100}%`,
        height: `${(bbox.h / 128) * 100}%`,
        border: '2px solid #cc0000',
        backgroundColor: 'transparent',
        pointerEvents: 'none' as const,
      };
    }
    
    // Default fallback
    return {
      position: 'absolute' as const,
      left: '40%',
      top: '40%',
      width: '20%',
      height: '20%',
      border: '2px solid #cc0000',
      backgroundColor: 'transparent',
      pointerEvents: 'none' as const,
    };
  }, [contour, bbox, bounds]); // Only include the actual dependencies used in the calculation

  // Determine border color based on label and selection
  // Use outline for all highlight states to avoid layout shift (outline doesn't take up space)
  let borderColor = 'border-gray-200';
  let boxShadow = '';
  let outlineStyle = '';
  
  if (label === 1) {
    outlineStyle = 'outline outline-2 outline-green-500';
    boxShadow = 'shadow-green-200';
  } else if (label === 0) {
    outlineStyle = 'outline outline-2 outline-red-500';
    boxShadow = 'shadow-red-200';
  } else if (isSelected) {
    outlineStyle = 'outline outline-2 outline-blue-500';
    boxShadow = 'shadow-blue-200';
  }

  const handleTileClick = () => {
    if (onCandidateClick) {
      const candidateData = {
        ...candidate,
        nuclei_id: cell_id,
        cell_id: cell_id,
        centroid: candidate.centroid,
        contour: candidate.crop?.contour,
        slideId: slideId,
        // Pass the current z-layer state from candidate tile to review panel
        // Each tile maintains its own fixedZLayer state independently
        fixedZLayer: fixedZLayer,
        isZStack: isZStack,
        numZLayers: numZLayers
      };
      
      onCandidateClick(candidateData);
    }
  };

  // Determine which image to display: fixed layer image or original (GIF/JPEG)
  const displayImage = (fixedZLayer !== null && layerImage) ? layerImage : image;
  const showLayerLoading = layerLoading && fixedZLayer !== null;
  
  // Force unique key to ensure React re-renders when switching between GIF and fixed layer
  const imageKey = fixedZLayer !== null ? `fixed-${cell_id}-${fixedZLayer}` : `gif-${cell_id}`;

  return (
    <div 
      className={`relative bg-white rounded ${borderColor} ${boxShadow} ${outlineStyle} overflow-hidden cursor-pointer hover:shadow-lg transition-all duration-200 aspect-square`}
      onClick={handleTileClick}
    >
      {/* Z-Stack layer selector - only show for z-stack images */}
      {isZStack && (
        <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
          <select
            value={fixedZLayer === null ? 'gif' : fixedZLayer}
            onChange={(e) => {
              e.stopPropagation();
              const value = e.target.value;
              if (value === 'gif') {
                handleLayerSelect(null);
              } else {
                handleLayerSelect(parseInt(value));
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] py-0.5 bg-white text-blue-600 rounded border border-blue-600 font-medium cursor-pointer hover:bg-blue-50"
            style={{ 
              paddingLeft: '2px',
              paddingRight: '14px',
              width: '38px',
              appearance: 'none',
              backgroundImage: 'url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%232563eb\' stroke-width=\'2.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'%3E%3C/polyline%3E%3C/svg%3E")',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 2px center',
              backgroundSize: '9px'
            }}
            title="Select z-layer to view"
          >
            <option value="gif">GIF</option>
            {Array.from({ length: numZLayers }, (_, i) => (
              <option key={i} value={i}>L{i + 1}</option>
            ))}
          </select>
        </div>
      )}
      
      {/* Main image with teacher's style */}
      <div className="relative w-full h-full">
        {showLayerLoading ? (
          <div className="w-full h-full bg-blue-50 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-1"></div>
              <span className="text-xs text-purple-600">Loading layer...</span>
            </div>
          </div>
        ) : displayImage && !imageError ? (
          <>
            <Image 
              key={imageKey} // Use unique key for GIF vs fixed layer
              src={displayImage} 
              alt={`Candidate ${cell_id}${fixedZLayer !== null ? ` Layer ${fixedZLayer + 1}` : ''}`}
              fill
              className="object-cover"
              style={{ imageRendering: 'pixelated' }}
              onError={handleImageError}
              onLoad={() => {
                // Reset error state on successful load
                setImageError(false);
                setRetryCount(0);
              }}
              unoptimized // Disable optimization for dynamic images
            />
            <div style={redBoxStyle} />
          </>
        ) : imageError ? (
          <div className="w-full h-full bg-red-50 flex flex-col items-center justify-center border border-red-200">
            <div className="text-red-500 mb-1">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <span className="text-xs text-red-600 text-center px-1 font-medium">Cell image error</span>
            <span className="text-xs text-red-400 text-center px-1 mt-1">Failed to load</span>
            <div style={redBoxStyle} />
          </div>
        ) : !image ? (
          <div className="w-full h-full bg-gray-100 flex items-center justify-center">
            <span className="text-xs text-gray-400">No image</span>
          </div>
        ) : (
          <div className="w-full h-full bg-blue-50 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-1"></div>
              <span className="text-xs text-blue-600">Loading...</span>
            </div>
          </div>
        )}
      </div>

      {/* Probability or reclassified label */}
      <div className={`absolute top-1 left-1 text-white px-1.5 py-0.5 rounded text-xs font-medium ${
        (isSpecialClass || (candidate as any).reclassified)
          ? 'bg-orange-500 bg-opacity-90' 
          : 'bg-black bg-opacity-60'
      }`}>
        {(isSpecialClass || (candidate as any).reclassified) 
          ? 'Reclassified' 
          : `P: ${prob.toFixed(3)}`}
      </div>

      {/* Yes/No buttons - compact size */}
      <div className="absolute bottom-1 left-1 right-1 flex space-x-1">
        <Button
          size="sm"
          disabled={label === 0 || !!pendingReclassification}
          className={`flex-1 h-5 text-xs px-1 ${
            label === 1 
              ? 'bg-green-600 text-white' 
              : (label === 0 || pendingReclassification)
              ? 'bg-gray-200 text-gray-400 border border-gray-300 cursor-not-allowed'
              : 'bg-white text-green-600 border border-green-600 hover:bg-green-50'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onLabelCandidate(cell_id, 1);
          }}
          title={
            label === 0 
              ? 'Cannot select YES: NO is already selected. Click NO again to deselect it first.'
              : pendingReclassification
              ? `Cannot select YES: This cell is marked for reclassification to "${pendingReclassification}". Cancel the reclassification first.`
              : targetClassName ? `Confirm as ${targetClassName}` : 'Confirm classification'
          }
        >
          ✓ Yes
        </Button>
        
        {/* No button with dropdown - show target class name for pending reclassification */}
        {pendingReclassification ? (
          <Button
            ref={buttonRef}
            size="sm"
            className="flex-1 h-5 text-xs px-1 bg-orange-500 text-white hover:bg-orange-600"
            title={`Click to cancel reclassification to ${pendingReclassification}`}
            onClick={(e) => {
              e.stopPropagation();
              // When clicking the selected reclassification button, cancel the reclassification
              if (onCancelPendingReclassification) {
                onCancelPendingReclassification(cell_id);
              }
            }}
          >
            → {pendingReclassification.length > 8 ? pendingReclassification.substring(0, 6) + '...' : pendingReclassification}
          </Button>
        ) : (
          <Button
            ref={buttonRef}
            size="sm"
            disabled={label === 1}
            className={`flex-1 h-5 text-xs px-1 ${
              label === 0 
                ? 'bg-red-600 text-white' 
                : label === 1
                ? 'bg-gray-200 text-gray-400 border border-gray-300 cursor-not-allowed'
                : 'bg-white text-red-600 border border-red-600 hover:bg-red-50'
            }`}
            title={
              label === 1
                ? 'Cannot select NO: YES is already selected. Click YES again to deselect it first.'
                : 'Choose different class'
            }
            onClick={(e) => {
              e.stopPropagation();
              updateDropdownPosition();
              setShowDropdown(!showDropdown);
            }}
          >
            ✗ No <ChevronDown className="h-2.5 w-2.5 ml-0.5" />
          </Button>
        )}
        
        {/* Portal dropdown menu */}
        {showDropdown && createPortal(
            <div 
              data-dropdown-menu
              className="fixed bg-card border border-border rounded shadow-lg z-[99999] pointer-events-auto"
              style={{
                top: `${dropdownPosition.top}px`,
                left: `${dropdownPosition.left}px`,
                width: `${Math.max(dropdownPosition.width, 160)}px`,
                transform: 'translateY(-100%)',
                pointerEvents: 'auto' as const
              }}
              onClick={(e) => {
                // Don't stop propagation here - let child buttons handle it
              }}
            >
            <div className="p-2 space-y-1">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-foreground">Select correct class:</div>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowDropdown(false);
                  }}
                  className="p-0.5 hover:bg-accent rounded transition-colors cursor-pointer"
                  title="Close dropdown"
                  style={{ pointerEvents: 'auto' as const }}
                >
                  <X className="h-3 w-3 text-muted-foreground pointer-events-none" />
                </button>
              </div>
              
              {/* Available classes */}
              {availableClasses.map((classObj, index) => (
                <button
                  key={`available-${classObj.id}-${index}`}
                  className="w-full flex items-center gap-2 p-1.5 text-left text-xs bg-card border border-border rounded hover:bg-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClassSelect(classObj.name);
                  }}
                >
                  <div 
                    className="w-2 h-2 rounded border border-border flex-shrink-0 pointer-events-none"
                    style={{ backgroundColor: classObj.color }}
                  />
                  <span className="pointer-events-none">{classObj.name}</span>
                </button>
              ))}
              
              {/* Separator */}
              {availableClasses.length > 0 && (
                <div className="border-t border-border my-1" />
              )}
              
              {/* Fixed options */}
              {fixedOptions.map((option, index) => (
                <button
                  key={`fixed-${option.id}-${index}`}
                  className="w-full flex items-center gap-2 p-1.5 text-left text-xs bg-card border border-border rounded hover:bg-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClassSelect(option.name);
                  }}
                  title="⚠️ Temporary class - will be cleared on reload"
                >
                  <div 
                    className="w-2 h-2 rounded border border-border flex-shrink-0 pointer-events-none"
                    style={{ backgroundColor: option.color }}
                  />
                  <span className="flex-1 pointer-events-none">{option.name}</span>
                  <span className="text-warning text-[10px] pointer-events-none">⏱️</span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>
  );
};

export default CandidateGallery;