import {
    BarChart3,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Database,
    FileText,
    Folder,
    HardDrive,
    Hash,
    Info,
    Settings,
    Table2,
    Type,
    X,
    Trash2,
    Edit2,
    Check,
    X as XIcon
} from 'lucide-react';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getZarrArrayInfo, deleteNucleiAnnotation, updateNucleiAnnotationClass, deleteTissueAnnotation, updateTissueAnnotationClass } from '@/services/data.service';
import EventBus from '@/utils/EventBus';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Utility functions
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const formatDataType = (dtype: string): string => {
  if (!dtype) return 'Dataset';
  
  // Check for numpy string types: |S<n>, |U<n>, <S<n>, >S<n>, etc.
  // Examples: |S115, |U10, <S20, >S5
  const stringTypePattern = /^[<>|]?[SU]\d+$/;
  if (stringTypePattern.test(dtype)) {
    return 'String';
  }
  
  // Check for structured array dtype (list format)
  // Examples: [('cell_class', 'i4'), ('cell_color', 'i4'), ...]
  // or: [('cell_class', '<i4'), ('cell_color', '<i4'), ...]
  // Check if it starts with '[' and contains tuples
  if (dtype.trim().startsWith('[') && dtype.includes('(') && dtype.includes(',')) {
    try {
      // Extract field names from tuples
      // Match pattern: ('field_name', 'type') or ("field_name", "type")
      // Handle both single and double quotes
      const fieldPattern = /\(['"]([^'"]+)['"]\s*,\s*[^)]+\)/g;
      const fields: string[] = [];
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(dtype)) !== null) {
        fields.push(fieldMatch[1]);
      }
      
      if (fields.length > 0) {
        // Just return "Structured Array" without field details
        return 'Structured Array';
      }
    } catch (e) {
      // If parsing fails, return as-is
      return dtype;
    }
  }
  
  // Keep other types as-is (int32, float16, etc.)
  return dtype;
};

const getTypeIcon = (type: string) => {
  switch (type) {
    case 'dataset':
    case 'array': return <Table2 className="h-3 w-3 text-primary" />;
    case 'group': return <Folder className="h-3 w-3 text-muted-foreground" />;
    case 'attribute': return <Hash className="h-3 w-3 text-accent-foreground" />;
    default: return <FileText className="h-3 w-3 text-muted-foreground" />;
  }
};

// Extract datasets/arrays from Zarr structure (returns array)
const extractDatasetsAsArray = (obj: any): any[] => {
  const datasets: any[] = [];
  
  // Support both 'dataset' (H5/Zarr) and 'array' (legacy Zarr) types
  if (obj?.type === 'dataset' || obj?.type === 'array') {
    datasets.push(obj);
  } else if (obj?.children) {
    obj.children.forEach((child: any) => {
      datasets.push(...extractDatasetsAsArray(child));
    });
  }
  
  return datasets;
};

// Detail info panel component
const DetailInfoPanel = ({ item, itemKey, currentPath, onDataUpdate }: { 
  item: any; 
  itemKey: string;
  currentPath: string | null;
  onDataUpdate?: (itemKey: string, data: any) => void;
}) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    general: true,
    attributes: true,
    storage: true,
    datatype: true
  });

  // Pagination state for Data Preview
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [pageInput, setPageInput] = useState('1');
  const [loading, setLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(item.preview);
  const [previewTotal, setPreviewTotal] = useState<number | null>(item.preview_total || null);
  const [previewTotalPages, setPreviewTotalPages] = useState<number | null>(item.preview_total_pages || null);
  const [classNames, setClassNames] = useState<string[]>(item.class_names || []);
  const [editingCellId, setEditingCellId] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  // Track previous itemKey to detect actual item changes
  const prevItemKeyRef = useRef<string>(itemKey);
  
  // Track component mount status to prevent state updates on unmounted component
  const isMountedRef = useRef<boolean>(true);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // Load paginated data from server
  const loadPageData = useCallback(async (page: number, limit: number) => {
    if (!currentPath || itemKey === 'root') return;
    
    setLoading(true);
    try {
      const zarrFilePath = `${currentPath}.zarr`;
      const arrayInfo = await getZarrArrayInfo(
        zarrFilePath, 
        item.full_path, 
        true, 
        undefined, // previewSize not used in pagination mode
        page, 
        limit
      );
      
      // Check again after async operation completes
      if (!isMountedRef.current) return;
      
      if (arrayInfo.preview !== undefined) {
        setPreviewData(arrayInfo.preview);
        setPreviewTotal(arrayInfo.preview_total || null);
        setPreviewTotalPages(arrayInfo.preview_total_pages || null);
        
        // Update class names if available
        if (arrayInfo.class_names) {
          setClassNames(arrayInfo.class_names);
        }
        
        // Update parent cache when data changes
        if (onDataUpdate) {
          onDataUpdate(itemKey, arrayInfo);
        }
      }
    } catch (error) {
      // Only log error if component is still mounted
      if (isMountedRef.current) {
        console.error('Failed to load paginated data:', error);
      }
    } finally {
      // Only update loading state if component is still mounted
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [currentPath, itemKey, item.full_path, onDataUpdate]);

  // Reset pagination only when itemKey actually changes (switching to a different item)
  useEffect(() => {
    if (prevItemKeyRef.current !== itemKey) {
      // Item actually changed, reset pagination
      prevItemKeyRef.current = itemKey;
      setCurrentPage(1);
      setPageInput('1');
      setPreviewData(item.preview);
      setPreviewTotal(item.preview_total || null);
      setPreviewTotalPages(item.preview_total_pages || null);
      if (item.class_names) {
        setClassNames(item.class_names);
      }
      
      // Auto-load first page for annotation types if preview data is not available
      const isNucleiAnnotations = item.full_path && (
        item.full_path === 'user_annotation/nuclei_annotations' ||
        item.full_path.endsWith('/user_annotation/nuclei_annotations') ||
        (item.full_path.endsWith('/nuclei_annotations') && item.full_path.includes('user_annotation'))
      );
      const isTissueAnnotations = item.full_path && (
        item.full_path === 'user_annotation/tissue_annotations' ||
        item.full_path.endsWith('/user_annotation/tissue_annotations') ||
        (item.full_path.endsWith('/tissue_annotations') && item.full_path.includes('user_annotation'))
      );
      
      // Always load first page for annotation types to ensure data is available
      if ((isNucleiAnnotations || isTissueAnnotations) && currentPath) {
        // Load first page automatically
        loadPageData(1, itemsPerPage).catch(err => {
          console.error('Failed to auto-load preview data:', err);
        });
      }
    } else {
      // Same item, update preview data only on initial load (when previewTotal is null)
      // This handles the case when data is loaded asynchronously
      if (previewTotal === null && item.preview_total !== null && item.preview) {
        setPreviewData(item.preview);
        setPreviewTotal(item.preview_total || null);
        setPreviewTotalPages(item.preview_total_pages || null);
      }
      // Always update classNames if available, even for same item (in case it loads asynchronously)
      if (item.class_names && item.class_names.length > 0) {
        setClassNames(item.class_names);
      }
    }
    // Include item properties in dependencies but use prevItemKeyRef to prevent unnecessary resets
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, item.preview, item.preview_total, item.preview_total_pages, item.class_names, loadPageData, currentPath, itemsPerPage]);

  // Cleanup: mark component as unmounted when it unmounts
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const SectionHeader = ({ title, icon, sectionKey }: { title: string; icon: React.ReactNode; sectionKey: string }) => (
    <div 
      className="flex items-center justify-between p-2.5 bg-muted border-b border-border cursor-pointer hover:bg-accent"
      onClick={() => toggleSection(sectionKey)}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      {expandedSections[sectionKey] ? 
        <ChevronDown className="h-3 w-3 text-muted-foreground" /> : 
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
      }
    </div>
  );

  const PropertyRow = ({ label, value, type = 'text' }: { label: string; value: any; type?: string }) => (
    <div className="grid grid-cols-3 gap-3 py-1.5 text-xs border-b border-border">
      <div className="font-medium text-muted-foreground">{label}:</div>
      <div className="col-span-2">
        {type === 'badge' ? (
          <span className="inline-block bg-primary/20 text-primary px-1.5 py-0.5 rounded text-xs">
            {value}
          </span>
        ) : type === 'array' ? (
          <span className="font-mono text-xs">
            [{Array.isArray(value) ? value.join(', ') : value}]
          </span>
        ) : (
          <span className="text-foreground text-xs">{String(value)}</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* General Object Info */}
      <div className="border border-border rounded-lg overflow-hidden">
        <SectionHeader 
          title="General Object Info" 
          icon={<Info className="h-3 w-3" />} 
          sectionKey="general" 
        />
        {expandedSections.general && (
          <div className="p-3 space-y-1">
            <PropertyRow label="Name" value={item.name || itemKey} />
            <PropertyRow label="Path" value={item.full_path || `/${itemKey}`} />
            <PropertyRow 
              label="Type" 
              value={item.type || 'Dataset'} 
              type="badge" 
            />
            <PropertyRow label="Object Reference" value="Auto-generated" />
            
            {item.shape && (
              <>
                <PropertyRow label="Rank" value={item.shape.length} />
                <PropertyRow 
                  label="Dimensions" 
                  value={item.shape} 
                  type="array" 
                />
                <PropertyRow 
                  label="Max Dimensions" 
                  value={item.shape} 
                  type="array" 
                />
                <PropertyRow 
                  label="Total Size" 
                  value={item.disk_size != null ? formatBytes(item.disk_size) : 'Unknown'} 
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* Data Type Info */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Datatype Information" 
          icon={<Type className="h-3 w-3" />} 
          sectionKey="datatype" 
        />
        {expandedSections.datatype && (
          <div className="p-3 space-y-1">
            <PropertyRow 
              label="Class" 
              value={item.dtype ? 'Zarr Array' : 'Unknown'} 
              type="badge" 
            />
            <PropertyRow 
              label="Base Type" 
              value={item.dtype || 'Unknown'} 
            />
            <PropertyRow 
              label="Size" 
              value={item.dtype ? `${item.dtype.includes('int') ? '8' : '8'} bytes` : 'Unknown'} 
            />
            <PropertyRow 
              label="Byte Order" 
              value="Little Endian" 
            />
            <PropertyRow 
              label="Character Set" 
              value="ASCII" 
            />
          </div>
        )}
      </div>

      {/* Storage Layout */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Storage Layout & Filters" 
          icon={<HardDrive className="h-3 w-3" />} 
          sectionKey="storage" 
        />
        {expandedSections.storage && (
          <div className="p-3 space-y-1">
            <PropertyRow label="Storage Layout" value={item.chunks ? "CHUNKED" : "CONTIGUOUS"} type="badge" />
            <PropertyRow label="Compression" value={item.compression || "NONE"} />
            <PropertyRow label="Filters" value={item.compression ? item.compression.toUpperCase() : "NONE"} />
            <PropertyRow label="Fill Value" value={item.fillvalue !== undefined ? String(item.fillvalue) : "Default"} />
            <PropertyRow 
              label="Allocation" 
              value="Late allocation (data written on first write)" 
            />
            <PropertyRow label="External Files" value="None" />
            {item.chunks && (
              <PropertyRow 
                label="Chunk Size" 
                value={item.chunks} 
                type="array" 
              />
            )}
          </div>
        )}
      </div>

      {/* Object Attributes */}
      <div className="border rounded-lg overflow-hidden">
        <SectionHeader 
          title="Object Attributes" 
          icon={<Settings className="h-3 w-3" />} 
          sectionKey="attributes" 
        />
        {expandedSections.attributes && (
          <div className="p-3">
            <div className="text-xs text-muted-foreground italic mb-2">
              Attribute Creation Order: Creation Order NOT Tracked
            </div>
            <div className="text-xs text-muted-foreground">
              Number of attributes = {item.attributes ? Object.keys(item.attributes).length : 0}
            </div>
            <div className="mt-3 border border-border rounded">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th className="border border-border px-2 py-1.5 text-left">Name</th>
                    <th className="border border-border px-2 py-1.5 text-left">Type</th>
                    <th className="border border-border px-2 py-1.5 text-left">Array Size</th>
                    <th className="border border-border px-2 py-1.5 text-left">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {item.attributes && Object.keys(item.attributes).length > 0 ? (
                    Object.entries(item.attributes).map(([attrName, attrInfo]: [string, any]) => (
                      <tr key={attrName}>
                        <td className="border border-border px-2 py-1.5 font-mono">{attrName}</td>
                        <td className="border border-border px-2 py-1.5">{attrInfo.dtype || 'unknown'}</td>
                        <td className="border border-border px-2 py-1.5">{attrInfo.shape ? attrInfo.shape.join('×') : '1'}</td>
                        <td className="border border-border px-2 py-1.5 max-w-32 truncate" title={String(attrInfo.value)}>
                          {String(attrInfo.value)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="border border-border px-2 py-3 text-center text-muted-foreground italic text-xs">
                        No custom attributes available for this dataset
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Data Preview */}
      {(() => {
        // Special handling for user_annotation/nuclei_annotations: show #, Original Cell ID, and Value columns
        const isNucleiAnnotations = item.full_path && (
          item.full_path === 'user_annotation/nuclei_annotations' ||
          item.full_path.endsWith('/user_annotation/nuclei_annotations') ||
          (item.full_path.endsWith('/nuclei_annotations') && item.full_path.includes('user_annotation'))
        );
        
        // Special handling for user_annotation/tissue_annotations: show #, Original Patch ID, and Value columns
        const isTissueAnnotations = item.full_path && (
          item.full_path === 'user_annotation/tissue_annotations' ||
          item.full_path.endsWith('/user_annotation/tissue_annotations') ||
          (item.full_path.endsWith('/tissue_annotations') && item.full_path.includes('user_annotation'))
        );
        
        // Combined check for both annotation types
        const isAnnotationType = isNucleiAnnotations || isTissueAnnotations;
        
        // For annotation types, always show Data Preview table (even if data is loading or empty)
        // For other types, only show if preview data exists
        if (!isAnnotationType && !previewData && !item.preview) {
          return null;
        }
        
        // Use server-side pagination data if available, otherwise use client-side
        const useServerPagination = previewTotal !== null && previewTotalPages !== null;
        const displayData = previewData || item.preview;
        const dataArray = Array.isArray(displayData) ? displayData : [];
        const totalItems = useServerPagination ? (previewTotal ?? 0) : dataArray.length;
        const totalPages = useServerPagination ? (previewTotalPages ?? 1) : Math.max(1, Math.ceil(dataArray.length / itemsPerPage));
        const startIndex = useServerPagination ? (currentPage - 1) * itemsPerPage : (currentPage - 1) * itemsPerPage;
        const currentData = useServerPagination ? dataArray : dataArray.slice(startIndex, startIndex + itemsPerPage);
        const isArrayOfArrays = Array.isArray(displayData) && displayData.length > 0 && Array.isArray(displayData[0]);

        const handlePageChange = async (newPage: number) => {
          const validPage = Math.max(1, Math.min(newPage, totalPages));
          setCurrentPage(validPage);
          setPageInput(String(validPage));
          
          // Load data from server if using server-side pagination
          if (useServerPagination && currentPath) {
            await loadPageData(validPage, itemsPerPage);
          }
        };

        const handlePageInputChange = (value: string) => {
          setPageInput(value);
        };

        const handlePageInputSubmit = async () => {
          const pageNum = parseInt(pageInput, 10);
          if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
            await handlePageChange(pageNum);
          } else {
            setPageInput(String(currentPage));
          }
        };

        const handleItemsPerPageChange = async (value: string) => {
          const newItemsPerPage = parseInt(value, 10);
          setItemsPerPage(newItemsPerPage);
          const newTotalPages = useServerPagination 
            ? Math.max(1, Math.ceil(totalItems / newItemsPerPage))
            : Math.max(1, Math.ceil(dataArray.length / newItemsPerPage));
          const newPage = Math.min(currentPage, newTotalPages);
          setCurrentPage(newPage);
          setPageInput(String(newPage));
          
          // Reload data with new page size if using server-side pagination
          if (useServerPagination && currentPath) {
            await loadPageData(newPage, newItemsPerPage);
          }
        };

        const handleRequestDelete = (cellId: number) => {
          setDeleteTargetId(cellId);
        };

        const handleConfirmDelete = async () => {
          if (deleteTargetId === null || !currentPath || itemKey === 'root' || !isAnnotationType) return;
          const cellId = deleteTargetId;
          setDeleteTargetId(null);
          setLoading(true);
          try {
            const zarrFilePath = `${currentPath}.zarr`;
            if (isNucleiAnnotations) {
              await deleteNucleiAnnotation(zarrFilePath, item.full_path, cellId);
              EventBus.emit('refresh-annotations');
            } else if (isTissueAnnotations) {
              await deleteTissueAnnotation(zarrFilePath, item.full_path, cellId);
              EventBus.emit('refresh-patches');
              EventBus.emit('refresh-annotations');
            }
            await loadPageData(currentPage, itemsPerPage);
          } catch (error: any) {
            alert(getErrorMessage(error, 'Failed to delete annotation'));
          } finally {
            setLoading(false);
          }
        };

        const handleStartEdit = async (cellId: number, currentValue: string) => {
          // Ensure classNames is available before starting edit
          // Use item.class_names as fallback if classNames state is empty
          const availableClassNames = classNames.length > 0 ? classNames : (item.class_names || []);
          if (availableClassNames.length > 0 && classNames.length === 0) {
            setClassNames(availableClassNames);
          }
          
          // If classNames is still empty, actively load data to get class names
          if (classNames.length === 0 && availableClassNames.length === 0 && currentPath && !loading) {
            // Load first page to get class names before starting edit
            // Await to ensure data is loaded before dropdown is rendered
            try {
              await loadPageData(currentPage, itemsPerPage);
            } catch (err) {
              console.error('Failed to load class names:', err);
            }
          }
          
          // Check after async operations (loadPageData may have taken time)
          if (!isMountedRef.current) return;
          
          setEditingCellId(cellId);
          setEditingValue(currentValue);
        };

        const handleCancelEdit = () => {
          setEditingCellId(null);
          setEditingValue('');
        };

        const handleSaveEdit = async (cellId: number) => {
          if (!currentPath || itemKey === 'root' || !isAnnotationType || !editingValue) return;
          
          setLoading(true);
          try {
            const zarrFilePath = `${currentPath}.zarr`;
            if (isNucleiAnnotations) {
              await updateNucleiAnnotationClass(zarrFilePath, item.full_path, cellId, editingValue);
              // Trigger refresh for nuclei annotations (same as patch below)
              EventBus.emit('refresh-annotations');
              // IMPORTANT: Trigger WebSocket refresh to update cell colors on the canvas
              EventBus.emit('refresh-websocket-path', { path: currentPath, forceReload: true });
            } else if (isTissueAnnotations) {
              await updateTissueAnnotationClass(zarrFilePath, item.full_path, cellId, editingValue);
              // Trigger refresh for tissue/patch annotations to update counts in Tissue Classification panel
              // Use same pattern as nuclei: emit refresh-patches (which calls refreshPatchClassificationData)
              // and also emit refresh-annotations for consistency
              EventBus.emit('refresh-patches');
              EventBus.emit('refresh-annotations');
              // IMPORTANT: Trigger WebSocket refresh to update patch colors on the canvas
              EventBus.emit('refresh-websocket-path', { path: currentPath, forceReload: true });
            }
            
            // Reload current page data after update
            await loadPageData(currentPage, itemsPerPage);
            
            // Check after async operations
            if (!isMountedRef.current) return;
            
            setEditingCellId(null);
            setEditingValue('');
          } catch (error: any) {
            alert(getErrorMessage(error, 'Failed to update annotation'));
          } finally {
            setLoading(false);
          }
        };

        const deleteItemType = isNucleiAnnotations ? 'cell' : 'patch';

        return (
          <>
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="p-2.5 bg-muted border-b border-border">
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <BarChart3 className="h-3 w-3" />
                  Data Preview
                </div>
              </div>
            <div className="p-3">
              {/* Pagination Controls */}
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Items per page:</span>
                  <Select value={String(itemsPerPage)} onValueChange={handleItemsPerPageChange}>
                    <SelectTrigger className="w-20 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[101]">
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Total {totalItems} items, Page {currentPage} / {totalPages}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handlePageChange(1)}
                      disabled={currentPage === 1}
                      title="First"
                    >
                      <ChevronsLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      title="Previous"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">Page:</span>
                      <Input
                        type="number"
                        min="1"
                        max={totalPages}
                        value={pageInput}
                        onChange={(e) => handlePageInputChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handlePageInputSubmit();
                          }
                        }}
                        className="w-24 h-8 text-xs text-center"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={handlePageInputSubmit}
                      >
                        Go
                      </Button>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      title="Next"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handlePageChange(totalPages)}
                      disabled={currentPage === totalPages}
                      title="Last"
                    >
                      <ChevronsRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="overflow-auto border border-border rounded h-80">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      {isAnnotationType ? (
                        // Special case: nuclei_annotations and tissue_annotations show three columns: #, Original ID, Value, and Delete button
                        <>
                          <th className="border border-border px-1.5 py-1 text-left">#</th>
                          <th className="border border-border px-1.5 py-1 text-left">
                            {isNucleiAnnotations ? 'Original Cell ID' : 'Original Patch ID'}
                          </th>
                          <th className="border border-border px-1.5 py-1 text-left">Value</th>
                          <th className="border border-border px-1.5 py-1 text-center w-16">Action</th>
                        </>
                      ) : (
                        <>
                          <th className="border border-border px-1.5 py-1 text-left">#</th>
                          {isArrayOfArrays && displayData && displayData[0] ? 
                            displayData[0].map((_: any, idx: number) => (
                              <th key={idx} className="border border-border px-1.5 py-1 text-left">
                                Col_{idx}
                              </th>
                            )) : 
                            <th className="border border-border px-1.5 py-1 text-left">Value</th>
                          }
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td 
                          colSpan={isAnnotationType ? 4 : (isArrayOfArrays && displayData?.[0] ? (displayData[0].length || 0) + 1 : 2)}
                          className="border border-border px-1.5 py-4 text-center text-muted-foreground text-xs"
                        >
                          Loading...
                        </td>
                      </tr>
                    ) : currentData.length === 0 ? (
                      <tr>
                        <td 
                          colSpan={isAnnotationType ? 4 : (isArrayOfArrays && displayData?.[0] ? (displayData[0].length || 0) + 1 : 2)}
                          className="border border-border px-1.5 py-4 text-center text-muted-foreground text-xs"
                        >
                          No data
                        </td>
                      </tr>
                    ) : (
                      currentData.map((row: any, i: number) => {
                        const globalIndex = useServerPagination ? startIndex + i : startIndex + i;
                        return (
                          <tr key={globalIndex} className={i % 2 ? 'bg-muted' : 'bg-card'}>
                            {isAnnotationType && Array.isArray(row) && row.length >= 2 ? (
                              // Special case: nuclei_annotations and tissue_annotations show three columns plus delete button
                              // # column shows table row index, Original ID shows row[0], Value shows row[1]
                              <>
                                <td className="border border-border px-1.5 py-1 font-medium text-muted-foreground">{globalIndex}</td>
                                <td className="border border-border px-1.5 py-1 whitespace-nowrap">{String(row[0])}</td>
                                <td className="border border-border px-1.5 py-1 whitespace-nowrap">
                                  {editingCellId === Number(row[0]) ? (
                                    <div className="flex items-center gap-1">
                                      {(() => {
                                        // Get available class names (from state or item prop)
                                        const availableClassNames = classNames.length > 0 ? classNames : (item.class_names || []);
                                        
                                        // If no class names available, show loading state
                                        if (availableClassNames.length === 0) {
                                          return (
                                            <div className="h-7 px-3 py-1.5 text-xs border border-border rounded-md bg-muted text-muted-foreground flex items-center">
                                              Loading classes...
                                            </div>
                                          );
                                        }
                                        
                                        // Render Select with available class names
                                        return (
                                          <Select value={editingValue} onValueChange={setEditingValue}>
                                            <SelectTrigger className="h-7 text-xs w-40">
                                              <SelectValue placeholder="Select class" />
                                            </SelectTrigger>
                                            <SelectContent className="z-[101]">
                                              {availableClassNames.map((className: string) => (
                                                <SelectItem key={className} value={className}>
                                                  {className}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        );
                                      })()}
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-green-600 hover:text-green-700 hover:bg-green-50"
                                        onClick={() => handleSaveEdit(Number(row[0]))}
                                        title="Save changes"
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                        onClick={handleCancelEdit}
                                        title="Cancel editing"
                                      >
                                        <XIcon className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1">
                                      <span className="flex-1">{String(row[1])}</span>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-primary hover:text-primary hover:bg-primary/10"
                                        onClick={() => handleStartEdit(Number(row[0]), String(row[1]))}
                                        title={`Edit class for ${isNucleiAnnotations ? 'cell' : 'patch'} ID ${row[0]}`}
                                      >
                                        <Edit2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  )}
                                </td>
                                <td className="border border-border px-1.5 py-1 text-center">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => handleRequestDelete(Number(row[0]))}
                                    title={`Delete annotation for ${isNucleiAnnotations ? 'cell' : 'patch'} ID ${row[0]}`}
                                    disabled={editingCellId === Number(row[0])}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="border border-border px-1.5 py-1 font-medium text-muted-foreground">{globalIndex}</td>
                                {Array.isArray(row) ? 
                                  row.map((cell: any, j: number) => (
                                    <td key={j} className="border border-border px-1.5 py-1 whitespace-nowrap">
                                      {String(cell)}
                                    </td>
                                  )) : 
                                  <td className="border border-border px-1.5 py-1 whitespace-nowrap">
                                    {String(row)}
                                  </td>
                                }
                              </>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <AlertDialog open={deleteTargetId !== null} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
            <AlertDialogContent className="z-[200]">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete annotation</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the annotation for {deleteItemType} ID {deleteTargetId}. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleConfirmDelete}>Continue</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
        );
      })()}

    </div>
  );
};

// File info panel component
const FileInfoPanel = ({ zarrStructure, zarrFilePath, zarrFileInfo }: { 
  zarrStructure: any; 
  zarrFilePath: string;
  zarrFileInfo?: any;
}) => {
  const fileName = zarrFilePath?.split('/').pop() || 'unknown.zarr';
  
  const datasets = zarrStructure?.root ? extractDatasetsAsArray(zarrStructure.root) : [];
  
  return (
    <div className="space-y-4">
      {/* File Header */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-primary/10 border-b border-border">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Database className="h-4 w-4 text-primary" />
            Zarr File Information
          </div>
        </div>
        <div className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="col-span-2">
              <span className="font-medium text-muted-foreground">File Name:</span>
              <div className="mt-0.5 font-mono text-xs break-all leading-relaxed">{fileName}</div>
            </div>
            <div>
              <span className="font-medium text-muted-foreground">Path:</span>
              <div className="mt-0.5 font-mono text-xs">/</div>
            </div>
            <div>
              <span className="font-medium text-muted-foreground">Zarr Version:</span>
              <div className="mt-0.5">{zarrFileInfo?.zarr_version || '2.17.2'}</div>
            </div>
            <div>
              <span className="font-medium text-muted-foreground">File Size:</span>
              <div className="mt-0.5">{zarrFileInfo?.file_size != null ? formatBytes(zarrFileInfo.file_size) : 'Unknown'}</div>
            </div>
          </div>
          <div className="pt-1.5 border-t border-border">
              <span className="inline-block bg-primary/20 text-primary px-2 py-0.5 rounded-full text-xs font-medium">
                Zarr Root Group
            </span>
          </div>
        </div>
      </div>

      {/* File Statistics */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-muted border-b border-border">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <BarChart3 className="h-3 w-3" />
            File Contents Summary
          </div>
        </div>
        <div className="p-3">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-center p-2.5 bg-primary/10 rounded border border-border">
              <div className="text-lg font-bold text-primary">{zarrStructure?.total_arrays || datasets.length}</div>
              <div className="text-xs text-muted-foreground">Total Arrays</div>
            </div>
            <div className="text-center p-2.5 bg-accent/50 rounded border border-border">
              <div className="text-lg font-bold text-foreground">{zarrStructure?.total_groups || 1}</div>
              <div className="text-xs text-muted-foreground">Total Groups</div>
            </div>
          </div>
          
          <div className="space-y-1.5">
            <h4 className="text-sm font-medium text-foreground">Array Overview</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-border text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th className="border border-border px-2 py-1.5 text-left">Name</th>
                    <th className="border border-border px-2 py-1.5 text-left">Type</th>
                    <th className="border border-border px-2 py-1.5 text-left">Dimensions</th>
                    <th className="border border-border px-2 py-1.5 text-left">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.length > 0 ? datasets.map((dataset, index) => (
                    <tr key={index} className="hover:bg-accent">
                      <td className="border border-border px-2 py-1.5 font-mono text-xs">{dataset.name}</td>
                      <td className="border border-border px-2 py-1.5">
                        <span className="inline-block bg-primary/20 text-primary px-1.5 py-0.5 rounded text-xs">
                          {formatDataType(dataset.dtype)}
                        </span>
                      </td>
                      <td className="border border-border px-2 py-1.5 font-mono text-xs">
                        {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                      </td>
                      <td className="border border-border px-2 py-1.5 text-xs">
                        {dataset.disk_size != null ? formatBytes(dataset.disk_size) : 'Unknown'}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="border border-border px-2 py-3 text-center text-muted-foreground italic">
                        No datasets found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* File Attributes */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-2.5 bg-muted border-b border-border">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Settings className="h-3 w-3" />
            Root Group Attributes
          </div>
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground mb-2">
            Number of attributes = {zarrFileInfo?.file_attributes ? Object.keys(zarrFileInfo.file_attributes).length : 0}
          </div>
          {zarrFileInfo?.file_attributes && Object.keys(zarrFileInfo.file_attributes).length > 0 ? (
            <div className="space-y-1">
              {Object.entries(zarrFileInfo.file_attributes).map(([key, value]) => (
                <div key={key} className="text-xs">
                  <span className="font-medium">{key}:</span> {String(value)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              No custom attributes defined for the root group.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Main HDFView style viewer component
const ZarrViewStyleViewer = ({ zarrTree, zarrFilePath, zarrFileInfo, currentPath }: { 
  zarrTree: any; 
  zarrFilePath: string;
  zarrFileInfo?: any;
  currentPath: string | null;
}) => {
  const [selectedItem, setSelectedItem] = useState('root');
  const [datasetCache, setDatasetCache] = useState<Record<string, any>>({});
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set(['root']));

  const initializeExpandedItems = (obj: any): Set<string> => {
    const expanded = new Set<string>(['root']);
    
    const traverse = (item: any) => {
      if (item.children && item.children.length > 0) {
        expanded.add(item.name);
        item.children.forEach(traverse);
      }
    };
    
    if (obj?.children) {
      obj.children.forEach(traverse);
    }
    
    return expanded;
  };

  const extractAllItems = (obj: any, parentPath: string = ''): Record<string, any> => {
    const items: Record<string, any> = {};
    
    if (obj.children) {
      obj.children.forEach((child: any) => {
        const currentPath = parentPath ? `${parentPath}/${child.name}` : child.name;
        items[child.name] = { ...child, full_path: currentPath, parentPath };
        
        // recursive processing of subprojects
        Object.assign(items, extractAllItems(child, currentPath));
      });
    }
    
    return items;
  };

  // build tree structure data
  const buildTreeStructure = (obj: any, parentPath: string = ''): any[] => {
    if (!obj.children) return [];
    
    return obj.children.map((child: any) => {
      const currentPath = parentPath ? `${parentPath}/${child.name}` : child.name;
      return {
        ...child,
        full_path: currentPath,
        parentPath,
        children: child.children ? buildTreeStructure(child, currentPath) : []
      };
    });
  };

  const allItems = zarrTree?.root ? extractAllItems(zarrTree.root) : {};
  const treeStructure = zarrTree?.root ? buildTreeStructure(zarrTree.root) : [];

  // when zarrTree changes, initialize the expanded state
  useEffect(() => {
    if (zarrTree?.root) {
      setExpandedItems(initializeExpandedItems(zarrTree.root));
    }
  }, [zarrTree]);

  const handleItemClick = async (itemKey: string, event: React.MouseEvent) => {
    event.preventDefault();
    setSelectedItem(itemKey);

    // if chosen item is a dataset/array and not already cached, try to load its preview
    if (itemKey !== 'root' && allItems[itemKey] && (allItems[itemKey].type === 'dataset' || allItems[itemKey].type === 'array') && currentPath) {
      const item = allItems[itemKey];
      const isNucleiAnnotations = item.full_path && (
        item.full_path === 'user_annotation/nuclei_annotations' ||
        item.full_path.endsWith('/user_annotation/nuclei_annotations') ||
        (item.full_path.endsWith('/nuclei_annotations') && item.full_path.includes('user_annotation'))
      );
      const isTissueAnnotations = item.full_path && (
        item.full_path === 'user_annotation/tissue_annotations' ||
        item.full_path.endsWith('/user_annotation/tissue_annotations') ||
        (item.full_path.endsWith('/tissue_annotations') && item.full_path.includes('user_annotation'))
      );
      
      // For annotation types, always load preview data (even if cached) to ensure it's up to date
      // For other types, only load if not already cached
      const shouldLoad = (isNucleiAnnotations || isTissueAnnotations) || (!item.preview && !datasetCache[itemKey]);
      
      if (shouldLoad) {
        try {
          const zarrFilePath = `${currentPath}.zarr`;
          // Load first page with default page size (25)
          const arrayInfo = await getZarrArrayInfo(zarrFilePath, item.full_path, true, undefined, 1, 25);
          
          // update datasetCache state
          setDatasetCache(prev => ({
            ...prev,
            [itemKey]: arrayInfo
          }));

          // update original item object
          allItems[itemKey] = { ...allItems[itemKey], ...arrayInfo };
        } catch (error) {
          console.error('Failed to load dataset preview:', error);
        }
      }
    }
  };

  const handleToggleExpand = (itemKey: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemKey)) {
        newSet.delete(itemKey);
      } else {
        newSet.add(itemKey);
      }
      return newSet;
    });
  };

  // recursive rendering of tree structure
  const renderTreeNode = (item: any, level: number = 0) => {
    const isExpanded = expandedItems.has(item.name);
    const hasChildren = item.children && item.children.length > 0;
    const indentStyle = { paddingLeft: `${level * 14 + 10}px` }; 

    return (
      <div key={item.name}>
        <div 
          className={`flex items-center gap-1.5 py-1.5 cursor-pointer hover:bg-accent ${
            selectedItem === item.name ? 'bg-primary/20 border-l-4 border-l-primary' : ''
          }`}
          style={indentStyle}
          onClick={(e) => handleItemClick(item.name, e)}
        >
          {hasChildren ? (
            <button
              onClick={(e) => handleToggleExpand(item.name, e)}
              className="flex-shrink-0 p-0.5 hover:bg-accent rounded"
            >
              {isExpanded ? 
                <ChevronDown className="h-3 w-3 text-muted-foreground" /> : 
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              }
            </button>
          ) : (
            <div className="w-4" /> 
          )}
          
          {getTypeIcon(item.type || 'dataset')}
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <div className="text-xs font-medium text-foreground truncate" title={item.name}>
              {item.name}
            </div>
            <div className="text-xs text-muted-foreground flex-shrink-0">
              {item.shape ? item.shape.join('×') : item.type === 'group' ? 'group' : 'scalar'}
            </div>
          </div>
        </div>
        
        {hasChildren && isExpanded && (
          <div>
            {item.children.map((child: any) => renderTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const handleDataUpdate = (itemKey: string, data: any) => {
    // Update cache when data is refreshed
    setDatasetCache(prev => ({
      ...prev,
      [itemKey]: { ...prev[itemKey], ...data }
    }));
  };

  const renderInfoPanel = () => {
    if (selectedItem === 'root') {
      return <FileInfoPanel zarrStructure={zarrTree} zarrFilePath={zarrFilePath} zarrFileInfo={zarrFileInfo} />;
    }

    const item = datasetCache[selectedItem] || allItems[selectedItem];
    if (!item) return null;

    return (
      <DetailInfoPanel 
        item={item} 
        itemKey={selectedItem} 
        currentPath={currentPath}
        onDataUpdate={handleDataUpdate}
      />
    );
  };

  return (
    <div className="h-full flex bg-muted">
      {/* Left sidebar tree navigation */}
      <div className="w-72 bg-card border-r border-border flex flex-col">
        <div className="border-b border-border p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Database className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Zarr Structure</h2>
            </div>
          </div>
          <div className="text-xs text-muted-foreground break-all">
            {zarrFilePath?.split(/[\\/]/).pop() || 'unknown.zarr'}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {/* Root group */}
          <div 
            className={`flex items-center gap-1.5 px-3 py-2 cursor-pointer hover:bg-accent border-b border-border ${
              selectedItem === 'root' ? 'bg-primary/20 border-l-4 border-l-primary' : ''
            }`}
            onClick={(e) => handleItemClick('root', e)}
          >
            <Folder className="h-3 w-3 text-primary" />
            <span className="text-xs font-medium">
              {'Root'}
            </span>
          </div>

          {/* Tree structure */}
          <div>
            {treeStructure.map((item: any) => renderTreeNode(item, 0))}
          </div>
        </div>
      </div>

      {/* Right info panel */}
      <div className="flex-1 bg-card overflow-y-auto overflow-x-hidden min-w-0">
        <div className="p-4 max-w-full">
          {renderInfoPanel()}
        </div>
      </div>
    </div>
  );
};

// Advanced Zarr Viewer Modal Component
interface AdvancedZarrViewerProps {
  isOpen: boolean;
  onClose: () => void;
  zarrTree: any;
  zarrFilePath: string;
  zarrFileInfo?: any;
  currentPath: string | null;
  fileName?: string;
}

export const AdvancedZarrViewer: React.FC<AdvancedZarrViewerProps> = ({
  isOpen,
  onClose,
  zarrTree,
  zarrFilePath,
  zarrFileInfo,
  currentPath,
  fileName
}) => {
  if (!isOpen || !zarrTree) return null;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-[100] p-4 pt-8 pr-16">
      <div className="bg-card rounded-lg shadow-2xl border border-border w-full h-full max-w-7xl max-h-[calc(95vh-2rem)] flex flex-col">
        {/* Title bar */}
        <div className="border-b border-border p-3 flex justify-between items-center bg-primary text-primary-foreground rounded-t-lg electron-no-drag">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <div>
              <h2 className="text-lg font-semibold">Zarr File Viewer</h2>
              <div className="text-xs opacity-90 break-all">
                {fileName || zarrFilePath?.split(/[\\/]/).pop() || 'unknown.zarr'}
              </div>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-primary-foreground hover:text-gray-700 p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-primary-foreground/20 rounded-lg transition-colors cursor-pointer electron-no-drag flex-shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Viewer content */}
        <div className="flex-1 overflow-hidden rounded-b-lg">
          <ZarrViewStyleViewer 
            zarrTree={structuredClone(zarrTree)}
            zarrFilePath={zarrFilePath} 
            zarrFileInfo={zarrFileInfo}
            currentPath={currentPath} 
          />
        </div>
      </div>
    </div>
  );
};

export default AdvancedZarrViewer;
