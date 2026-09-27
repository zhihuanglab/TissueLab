import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import { InlineSpinner } from '@/components/assets/PageLoading';
import {
    Archive,
    ChevronDown,
    ChevronRight,
    Database,
    Folder,
    Layers,
    Upload
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { AdvancedZarrViewer, formatBytes, formatDataType } from './AdvancedZarrViewer';
import ZarrReplaceDialog from './ZarrReplaceDialog';

// Type definitions
interface ZarrCardProps {
  currentPath: string | null;
}

import {
    getZarrFileInfo,
    getZarrStructure,
    validateZarrFile
} from '@/services/data.service';

import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { RootState } from '@/store';
import { isSegmentationHandlerNotReadyError, segFetch } from '@/utils/common/segFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import eventBus from '@/utils/common/eventBus';

/** Reload the instance-scoped segmentation handler for ``filePath``. */
const reloadSegHandler = async (filePath: string, instanceId?: string | null): Promise<void> => {
  const response = await segFetch(instanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath }),
    returnAxiosFormat: true,
  });

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to set file path');
  }
};

// Utility functions (formatBytes and formatDataType are imported from AdvancedZarrViewer)

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

// Main Zarr Card component
const ZarrCard: React.FC<ZarrCardProps> = ({ currentPath }) => {
  const { assertWritable, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);
  const [zarrFileStructure, setZarrFileStructure] = useState<any>(null);
  const [zarrFileInfo, setZarrFileInfo] = useState<any>(null);
  const [zarrFileExists, setZarrFileExists] = useState(false);
  // Default to `true` so the very first paint shows "Loading…" instead
  // of flashing "No Zarr data found" before the load effect even fires
  // — without a currentPath the loading branch is gated below anyway.
  const [zarrLoading, setZarrLoading] = useState(true);
  const [showZarrViewer, setShowZarrViewer] = useState(false);
  const [showReplaceDialog, setShowReplaceDialog] = useState(false);
  const [zarrTree, setZarrTree] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [actualDataFilePath, setActualDataFilePath] = useState<string | null>(null);
  const lastLoadedSlide = useRef<string | null>(null);
  const loadSequence = useRef(0);

  const loadZarrFileDirectly = useCallback(async (opts?: { skipSegReload?: boolean }) => {
    if (!currentPath) return;
    const loadKey = `${activeInstanceId ?? ''}::${currentPath}`;
    if (lastLoadedSlide.current === loadKey) return;
    const sequence = ++loadSequence.current;
    const isCurrentLoad = () => loadSequence.current === sequence;
    lastLoadedSlide.current = loadKey;
    
    const fileName = currentPath.split(/[\\/]/).pop();
    if (!fileName) return;

    // Only check for .zarr file
    const zarrFilePath = `${currentPath}.zarr`;
    
    console.log('Loading Zarr data:', fileName);
    console.log('Zarr file path:', zarrFilePath);
    setZarrLoading(true);
    
    try {
      setError(null);
      
      // Bind handler unless caller already did (e.g. WS forceReload after replace).
      if (!opts?.skipSegReload) {
        try {
          await reloadSegHandler(currentPath, activeInstanceId);
          if (!isCurrentLoad()) return;
          console.log('Successfully set file path on backend:', currentPath);
        } catch (pathError) {
          if (isSegmentationHandlerNotReadyError(pathError)) return;
          console.warn('Failed to set file path on backend:', pathError);
          if (!isCurrentLoad()) return;
          setZarrFileExists(false);
          setError(getErrorMessage(pathError, 'Failed to set file path on backend'));
          return;
        }
      }
      
      // Validate zarr file
      try {
        const validationResult = await validateZarrFile(zarrFilePath);
        if (!validationResult.is_valid) {
          setZarrFileExists(false);
          setError(validationResult.error || 'File is not a valid Zarr file');
          return;
        }
        console.log('Zarr file validation successful:', validationResult);
      } catch (validationError) {
        console.log('Zarr file not found or not accessible:', validationError);
        setZarrFileExists(false);
        setError(getErrorMessage(validationError, 'Zarr file not found or not accessible'));
        return;
      }

      // Get Zarr file info and structure
      const [fileInfo, structure] = await Promise.all([
        getZarrFileInfo(zarrFilePath).catch(e => {
          console.warn('Failed to get Zarr file info:', e);
          return null;
        }),
        getZarrStructure(zarrFilePath, '/', true, 3, true).catch(e => {
          console.warn('Failed to get Zarr structure:', e);
          return null;
        })
      ]);

      if (!isCurrentLoad()) return;

      console.log('Zarr file info:', fileInfo);
      console.log('Zarr structure:', structure);

      if (structure?.root || fileInfo) {
        setZarrTree(structure);
        setZarrFileStructure(structure);
        setZarrFileInfo(fileInfo);
        setZarrFileExists(true);
        setActualDataFilePath(zarrFilePath);
        console.log('Successfully loaded Zarr data');
      } else {
        throw new Error('Failed to load Zarr file structure or info');
      }

    } catch (error) {
      if (!isCurrentLoad()) return;
      setError(getErrorMessage(error, 'Unknown error occurred'));
      console.warn('Failed to load Zarr data:', error);
      setZarrFileExists(false);
    } finally {
      if (isCurrentLoad()) setZarrLoading(false);
    }
  }, [currentPath, activeInstanceId]);

  useEffect(() => {
    if (!currentPath) {
      // Reset lastLoadedSlide when currentPath is cleared
      lastLoadedSlide.current = null;
      loadSequence.current += 1;
      return;
    }
      // reset states
      setZarrFileStructure(null);
      setZarrFileInfo(null);
      setZarrFileExists(false);
      setError(null);
      setActualDataFilePath(null);
      
      // Reset lastLoadedSlide to force reload when currentPath changes
      lastLoadedSlide.current = null;
      
      loadZarrFileDirectly();
  }, [currentPath, loadZarrFileDirectly]);

  // Extract groups with their arrays for grouped display
  interface GroupedData {
    groupName: string;
    groupPath: string;
    arrays: any[];
    level: number;
  }

  const extractGroupsWithArrays = (obj: any, parentPath: string = '', level: number = 0): GroupedData[] => {
    const result: GroupedData[] = [];
    
    if (!obj) return result;
    
    // If it's a group, collect its direct arrays and process children
    if (obj.type === 'group' && obj.children) {
      const directArrays: any[] = [];
      const childGroups: any[] = [];
      
      obj.children.forEach((child: any) => {
        if (child.type === 'array' || child.type === 'dataset') {
          directArrays.push(child);
        } else if (child.type === 'group') {
          childGroups.push(child);
        }
      });
      
      // Skip root level - don't add root as a group
      // For root, directly process its children
      if (obj.full_path === '/') {
        // Process child groups recursively (skip root itself)
        childGroups.forEach((child: any) => {
          result.push(...extractGroupsWithArrays(child, obj.full_path, level));
        });
      } else {
        // For non-root groups, add them if they have arrays
        if (directArrays.length > 0) {
          result.push({
            groupName: obj.name,
            groupPath: obj.full_path,
            arrays: directArrays,
            level: level
          });
        }
        
        // Process child groups recursively
        childGroups.forEach((child: any) => {
          result.push(...extractGroupsWithArrays(child, obj.full_path, level + 1));
        });
      }
    }
    
    return result;
  };

  // Extract root-level arrays (arrays directly under root)
  const extractRootArrays = (obj: any): any[] => {
    if (!obj || obj.type !== 'group' || !obj.children) return [];
    
    return obj.children
      .filter((child: any) => child.type === 'array' || child.type === 'dataset')
      .map((child: any) => child);
  };

  const arrays = zarrFileStructure?.root ? extractDatasetsAsArray(zarrFileStructure.root) : [];
  const rootArrays = zarrFileStructure?.root ? extractRootArrays(zarrFileStructure.root) : [];
  const groupedData = zarrFileStructure?.root ? extractGroupsWithArrays(zarrFileStructure.root) : [];
  
  // State for expanded groups - initialize empty (no root to expand)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  
  // Reset expanded groups when structure changes
  useEffect(() => {
    if (zarrFileStructure?.root) {
      setExpandedGroups(new Set());
    }
  }, [zarrFileStructure]);
  
  const toggleGroup = (groupPath: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupPath)) {
        newSet.delete(groupPath);
      } else {
        newSet.add(groupPath);
      }
      return newSet;
    });
  };

  return (
    <>
      <div className="border border-border/50 rounded-lg overflow-hidden bg-card shadow-sm">
        <div className="p-3 border-b border-border bg-muted">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Database className="h-4 w-4 text-primary" />
            Workspace
          </div>
        </div>
        <div className="p-3">
          {!currentPath ? (
            <div className="text-muted-foreground text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm">No file loaded</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Please select a file to view its Zarr data
              </div>
            </div>
          ) : zarrLoading ? (
            // Loading takes precedence over `!zarrFileExists` — the load
            // effect resets `zarrFileExists` to false mid-flight, so
            // checking it first would flash "No Zarr data found" every
            // time the user navigates between slides.
            <div className="text-muted-foreground text-center py-6">
              <div className="flex items-center justify-center gap-2">
                <InlineSpinner size={24} color="#6352a3" />
                <span className="text-sm">Loading Zarr structure...</span>
              </div>
            </div>
          ) : !zarrFileExists ? (
            <div className="text-muted-foreground text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm">No Zarr data found</span>
              </div>
              <div className="text-xs text-muted-foreground break-all">
                {error || `Expected: ${currentPath.split(/[\\/]/).pop()}.zarr`}
              </div>
            </div>
          ) : zarrFileStructure && zarrFileInfo ? (
            <div className="space-y-3">
              {/* Zarr file basic information */}
              <div className="flex items-center justify-between p-3 bg-primary/10 rounded-lg border border-border">
                <div className="flex items-center gap-2">
                  <div>
                    <div className="text-sm font-medium text-foreground break-all">
                      {currentPath.split(/[\\/]/).pop()}.zarr
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Zarr Scientific Data Format
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs bg-green-500/20 text-green-500 px-2 py-1 rounded-full">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
                    Available
                  </span>
                </div>
              </div>

              {/* Quick statistics cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-primary/10 p-3 rounded-lg border border-border">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Datasets</span>
                  </div>
                  <div className="text-xl font-bold text-foreground">
                    {zarrFileStructure.total_arrays || arrays.length}
                  </div>
                </div>
                
                <div className="bg-accent/50 p-3 rounded-lg border border-border">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Folder className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Groups</span>
                  </div>
                  <div className="text-xl font-bold text-foreground">
                    {zarrFileStructure.total_groups || 1}
                  </div>
                </div>
                
                <div className="bg-muted/50 p-3 rounded-lg border border-border">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Archive className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Size</span>
                  </div>
                  <div className="text-lg font-bold text-foreground">
                    {zarrFileInfo.file_size ? formatBytes(zarrFileInfo.file_size) : 'Unknown'}
                  </div>
                </div>
              </div>

              {/* Dataset preview table */}
              <div className="border border-border rounded-lg">
                <div className="p-2.5 bg-muted border-b border-border">
                  <h3 className="text-sm font-medium text-foreground">Structure</h3>
                </div>
                <div className="overflow-visible">
                  <table className="w-full text-xs table-auto">
                    <thead className="bg-muted">
                      <tr>
                        <th className="border border-border px-2 py-1.5 text-left w-2/5">Name</th>
                        <th className="border border-border px-2 py-1.5 text-left w-1/5">Type</th>
                        <th className="border border-border px-2 py-1.5 text-left w-1/5">Shape</th>
                        <th className="border border-border px-2 py-1.5 text-left w-1/5">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Root-level arrays (displayed directly without group header) */}
                      {rootArrays.length > 0 && rootArrays.map((dataset, index) => (
                        <tr key={`root-${index}`} className="hover:bg-accent">
                          <td className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed">
                            {dataset.name}
                          </td>
                          <td className="border border-border px-2 py-1.5">
                            <span className="inline-block bg-primary/20 text-primary px-1.5 py-0.5 rounded text-xs break-all">
                              {formatDataType(dataset.dtype)}
                            </span>
                          </td>
                          <td className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed">
                            {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                          </td>
                          <td className="border border-border px-2 py-1.5 text-xs break-all">
                            {dataset.disk_size != null ? formatBytes(dataset.disk_size) : 'Unknown'}
                          </td>
                        </tr>
                      ))}
                      
                      {/* Grouped data (non-root groups) */}
                      {groupedData.length > 0 && groupedData.map((group, groupIndex) => (
                        <React.Fragment key={group.groupPath}>
                          {/* Group header row */}
                          <tr 
                            className="bg-muted/50 hover:bg-muted cursor-pointer"
                            onClick={() => toggleGroup(group.groupPath)}
                          >
                            <td 
                              colSpan={4} 
                              className="border border-border px-1 py-1.5 font-medium text-foreground"
                              style={{ paddingLeft: `${8 + group.level * 12}px` }}
                            >
                              <div className="flex items-center gap-1.5">
                                {expandedGroups.has(group.groupPath) ? (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                )}
                                <Folder className="h-3 w-3 text-primary" />
                                <span>{group.groupName}</span>
                                <span className="text-muted-foreground text-xs ml-1">
                                  ({group.arrays.length} {group.arrays.length === 1 ? 'dataset' : 'datasets'})
                                </span>
                              </div>
                            </td>
                          </tr>
                          {/* Group arrays */}
                          {expandedGroups.has(group.groupPath) && group.arrays.map((dataset, index) => (
                            <tr key={`${group.groupPath}-${index}`} className="hover:bg-accent">
                              <td 
                                className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed"
                                style={{ paddingLeft: `${16 + group.level * 12}px` }}
                              >
                                {dataset.name}
                              </td>
                              <td className="border border-border px-2 py-1.5">
                                <span className="inline-block bg-primary/20 text-primary px-1.5 py-0.5 rounded text-xs break-all">
                                  {formatDataType(dataset.dtype)}
                                </span>
                              </td>
                              <td className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed">
                                {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                              </td>
                              <td className="border border-border px-2 py-1.5 text-xs break-all">
                                {dataset.disk_size != null ? formatBytes(dataset.disk_size) : 'Unknown'}
                              </td>
                            </tr>
                          ))}
                        </React.Fragment>
                      ))}
                      
                      {/* Fallback: if no root arrays and no groups, show all arrays flat */}
                      {rootArrays.length === 0 && groupedData.length === 0 && arrays.length > 0 && arrays.map((dataset, index) => (
                        <tr key={index} className="hover:bg-accent">
                          <td className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed">
                            {dataset.name}
                          </td>
                          <td className="border border-border px-2 py-1.5">
                            <span className="inline-block bg-primary/20 text-primary px-1.5 py-0.5 rounded text-xs break-all">
                              {formatDataType(dataset.dtype)}
                            </span>
                          </td>
                          <td className="border border-border px-2 py-1.5 font-mono text-xs break-all leading-relaxed">
                            {dataset.shape ? dataset.shape.join(' × ') : 'Unknown'}
                          </td>
                          <td className="border border-border px-2 py-1.5 text-xs break-all">
                            {dataset.disk_size != null ? formatBytes(dataset.disk_size) : 'Unknown'}
                          </td>
                        </tr>
                      ))}
                      
                      {/* Empty state */}
                      {rootArrays.length === 0 && groupedData.length === 0 && arrays.length === 0 && (
                        <tr>
                          <td colSpan={4} className="border border-border px-1 py-3 text-center text-muted-foreground italic">
                            No datasets found
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Open detailed viewer — read-only inspection is allowed */}
              <button
                onClick={() => setShowZarrViewer(true)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-primary text-primary-foreground rounded-[6px] transition-all duration-200 shadow-md hover:shadow-lg hover:bg-primary/90"
              >
                <span className="font-medium text-xs">Open Advanced Zarr Viewer</span>
              </button>

              {/* Replace preprocessing with your own .zarr */}
              <button
                onClick={() => {
                  if (!assertWritable('replace preprocessing')) {
                    return;
                  }
                  setShowReplaceDialog(true);
                }}
                disabled={!pathWritable}
                title={writeBlockTitle}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-border text-foreground rounded-[6px] transition-colors duration-200 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span className="font-medium text-xs">Replace preprocessing…</span>
              </button>
            </div>
          ) : (
            <div className="text-destructive text-center py-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Database className="h-6 w-6 text-destructive" />
                <span className="text-sm">Error loading Zarr data</span>
              </div>
              <div className="text-xs text-destructive/80">
                {error || 'Failed to load or parse the Zarr file structure'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Zarr viewer modal */}
      <AdvancedZarrViewer
        isOpen={showZarrViewer}
        onClose={() => setShowZarrViewer(false)}
        zarrTree={zarrTree}
        zarrFilePath={actualDataFilePath || `${currentPath}.zarr`}
        zarrFileInfo={zarrFileInfo}
        currentPath={currentPath}
        fileName={currentPath?.split(/[\\/]/).pop()}
      />

      {/* Replace preprocessing dialog */}
      <ZarrReplaceDialog
        isOpen={showReplaceDialog}
        onClose={() => setShowReplaceDialog(false)}
        targetSlidePath={currentPath}
        onReplaced={async () => {
          if (currentPath) {
            eventBus.emit('refresh-websocket-path', { path: currentPath, forceReload: true });
          }
          lastLoadedSlide.current = null;
          // Handler rebound via WS above — only refresh this card's structure view.
          await loadZarrFileDirectly({ skipSegReload: true });
        }}
      />
    </>
  );
};

export default ZarrCard;
