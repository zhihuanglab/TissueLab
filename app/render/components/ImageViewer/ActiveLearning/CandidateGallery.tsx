"use client";

import React, { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ALCandidate } from "@/store/slices/activeLearningSlice";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, RotateCcw, ChevronDown } from "lucide-react";

interface CandidateGalleryProps {
  candidates: ALCandidate[];
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
  onCandidateClick?: (candidate: ALCandidate) => void;
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
          <h6 style={{ fontSize: '14px', fontWeight: '500', color: '#374151' }}>
            Candidate Pool ({total} total)
          </h6>
          <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
            Use Y/N keys for quick labeling
          </div>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Sort toggle - only show if onSortChange is provided */}
          {onSortChange && (
            <>
              <span style={{ fontSize: '12px', color: '#6b7280', fontWeight: 500 }}>
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
              <span style={{ fontSize: '12px', color: '#6b7280', userSelect: 'none' }}>
                Show reclassified
              </span>
            </label>
          )}
        </div>
      </div>

      {/* Gallery container - fixed height like loading state */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: '6px', backgroundColor: 'white' }}>
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
          <div className="border-t border-gray-200 px-2 py-2 bg-gray-50" style={{ minHeight: '36px' }}>
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-500">
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
                
                <span className="text-xs px-1 font-medium">
                  {page + 1} / {totalPages}
                </span>
                
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
  candidate: ALCandidate;
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
  onCandidateClick?: (candidate: ALCandidate) => void;
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

  const handleClassSelect = (selectedClass: string) => {
    setShowDropdown(false);
    // Batch processing mode: don't call API immediately, cache the selection
    if (onPendingReclassification) {
      onPendingReclassification(cell_id, selectedClass);
    } else if (onReclassifyCandidate) {
      // Compatible with old mode: if no batch processing handler, call API immediately
      onReclassifyCandidate(cell_id, selectedClass);
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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showDropdown && buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('click', handleClickOutside);
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showDropdown]);

  const fixedOptions = [
    { id: "Other", name: "Other", color: "#F3F4F5" },
    { id: "Not Sure", name: "Not Sure", color: "#FED7AA" },
    { id: "Incorrect Segmentation", name: "Incorrect Segmentation", color: "#FECACA" }
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
  let borderColor = 'border-gray-200';
  let boxShadow = '';
  
  if (label === 1) {
    borderColor = 'border-green-500 border-2';
    boxShadow = 'shadow-green-200';
  } else if (label === 0) {
    borderColor = 'border-red-500 border-2';
    boxShadow = 'shadow-red-200';
  } else if (isSelected) {
    borderColor = 'border-blue-500 border-2';
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
        slideId: slideId
      };
      
      onCandidateClick(candidateData);
    }
  };

  return (
    <div 
      className={`relative bg-white rounded ${borderColor} ${boxShadow} overflow-hidden cursor-pointer hover:shadow-lg transition-all duration-200 aspect-square`}
      onClick={handleTileClick}
    >
      {/* Main image with teacher's style */}
      <div className="relative w-full h-full">
        {image && !imageError ? (
          <>
            <Image 
              key={`${image}-${retryCount}`} // Force re-render on retry
              src={image} 
              alt={`Candidate ${cell_id}`}
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
          className={`flex-1 h-5 text-xs px-1 ${
            label === 1 
              ? 'bg-green-600 text-white' 
              : 'bg-white text-green-600 border border-green-600 hover:bg-green-50'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onLabelCandidate(cell_id, 1);
          }}
          title={targetClassName ? `Confirm as ${targetClassName}` : 'Confirm classification'}
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
            className={`flex-1 h-5 text-xs px-1 ${
              label === 0 
                ? 'bg-red-600 text-white' 
                : 'bg-white text-red-600 border border-red-600 hover:bg-red-50'
            }`}
            title="Choose different class"
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
            className="fixed bg-white border border-gray-200 rounded shadow-lg z-[9999]"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: `${Math.max(dropdownPosition.width, 160)}px`,
              transform: 'translateY(-100%)'
            }}
          >
            <div className="p-2 space-y-1">
              <div className="text-xs font-medium text-gray-700 mb-2">Select correct class:</div>
              
              {/* Available classes */}
              {availableClasses.map((classObj, index) => (
                <button
                  key={`available-${classObj.id}-${index}`}
                  className="w-full flex items-center gap-2 p-1.5 text-left text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
                  onClick={() => handleClassSelect(classObj.name)}
                >
                  <div 
                    className="w-2 h-2 rounded border border-gray-300 flex-shrink-0"
                    style={{ backgroundColor: classObj.color }}
                  />
                  <span>{classObj.name}</span>
                </button>
              ))}
              
              {/* Separator */}
              {availableClasses.length > 0 && (
                <div className="border-t my-1" />
              )}
              
              {/* Fixed options */}
              {fixedOptions.map((option, index) => (
                <button
                  key={`fixed-${option.id}-${index}`}
                  className="w-full flex items-center gap-2 p-1.5 text-left text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
                  onClick={() => handleClassSelect(option.name)}
                >
                  <div 
                    className="w-2 h-2 rounded border border-gray-300 flex-shrink-0"
                    style={{ backgroundColor: option.color }}
                  />
                  <span>{option.name}</span>
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