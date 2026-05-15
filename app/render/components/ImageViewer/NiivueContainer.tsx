"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from "react-redux";
import { RootState } from "@/store";
import { setCurrentPath } from "@/store/slices/svsPathSlice";
import { addWSIInstance } from '@/store/slices/wsiSlice';
import { createInstance } from "@/services/file.service";
import { createDownloadLink } from "@/utils/dashboard/fileManager.service";
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { getErrorMessage } from "@/utils/common/apiResponse";
import NiivueSegmentationHandler from "./NiivueSegmentationHandler";

interface NiivueContainerProps {
  instanceId?: string;
}

const NiivueContainer: React.FC<NiivueContainerProps> = ({ instanceId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const niivueRef = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNiivueReady, setIsNiivueReady] = useState(false);
  const [maskLoaded, setMaskLoaded] = useState(false);
  const [maskVisible, setMaskVisible] = useState(false);
  const [colormap, setColormap] = useState<string>('ct_bones');
  const [availableColormaps, setAvailableColormaps] = useState<string[]>([]);
  const [windowLevel, setWindowLevel] = useState<string>('0');
  const [windowWidth, setWindowWidth] = useState<string>('1000');
  const canvasId = `niivue-canvas-${instanceId || 'default'}`;
  
  const dispatch = useDispatch();
  const { setInstanceId } = useAnnotatorInstance();
  
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const instances = useSelector((state: RootState) => state.wsi.instances);
  
  const currentInstance = instanceId ? instances[instanceId] : null;

  const cacheKeyForPath = (path: string): string => {
    const forward = path.replace(/\\/g, '/');
    const noLeading = forward.replace(/^\/+/, '');
    return noLeading.toLowerCase();
  };

  // IndexedDB blob cache (simple implementation in component scope)
  const openBlobDb = async (): Promise<IDBDatabase> => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('tissuelab-niivue-cache', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        if (!db.objectStoreNames.contains('index')) {
          db.createObjectStore('index'); // pathKey -> { sha1, updatedAt }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };

  const computeSha1 = async (blob: Blob): Promise<string> => {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const byteArray = Array.from(new Uint8Array(hashBuffer));
    const hex = byteArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hex;
  };

  const getCachedBlob = useCallback(async (rawKey: string): Promise<Blob | null> => {
    const pathKey = cacheKeyForPath(rawKey);
    try {
      const db = await openBlobDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['blobs', 'meta', 'index'], 'readonly');
        const idxReq = tx.objectStore('index').get(pathKey);
        idxReq.onsuccess = () => {
          const idx = idxReq.result as { sha1?: string } | undefined;
          const blobKey = idx?.sha1 || pathKey; // fallback to legacy key
          const metaReq = tx.objectStore('meta').get(blobKey);
          metaReq.onsuccess = () => {
            const meta = metaReq.result as { expires_at?: number | string } | undefined;
            if (meta?.expires_at) {
              let expiresMs: number;
              if (typeof meta.expires_at === 'string') {
                expiresMs = Date.parse(meta.expires_at);
              } else {
                expiresMs = meta.expires_at < 1e12 ? meta.expires_at * 1000 : meta.expires_at;
              }
              if (isFinite(expiresMs) && expiresMs - Date.now() <= 30_000) {
                console.log('NiivueContainer: IDB cache expired for key', blobKey, 'exp:', new Date(expiresMs).toISOString());
                resolve(null);
                return;
              }
            }
            const blobReq = tx.objectStore('blobs').get(blobKey);
            blobReq.onsuccess = () => {
              if (blobReq.result) {
                console.log('NiivueContainer: IDB cache hit for key', blobKey);
              } else {
                console.log('NiivueContainer: IDB cache miss for key', blobKey);
              }
              resolve(blobReq.result || null);
            };
            blobReq.onerror = () => reject(blobReq.error);
          };
          metaReq.onerror = () => reject(metaReq.error);
        };
        idxReq.onerror = () => reject(idxReq.error);
      });
    } catch {
      return null;
    }
  }, []);

  const setCachedBlob = useCallback(async (rawKey: string, blob: Blob, expiresAt?: number | string, contentKeyOverride?: string) => {
    const pathKey = cacheKeyForPath(rawKey);
    try {
      const db = await openBlobDb();
      const sha1 = contentKeyOverride && contentKeyOverride.trim().length > 0 ? contentKeyOverride : await computeSha1(blob);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['blobs', 'meta', 'index'], 'readwrite');
        const putBlob = tx.objectStore('blobs').put(blob, sha1);
        let expiresMs: number;
        if (typeof expiresAt === 'string') {
          const parsed = Date.parse(expiresAt);
          expiresMs = isFinite(parsed) ? parsed : (Date.now() + 24 * 60 * 60 * 1000);
        } else if (typeof expiresAt === 'number') {
          expiresMs = expiresAt < 1e12 ? (expiresAt * 1000) : expiresAt; // seconds -> ms if needed
        } else {
          expiresMs = Date.now() + 24 * 60 * 60 * 1000; // default 24h TTL
        }
        const putMeta = tx.objectStore('meta').put({ expires_at: expiresMs }, sha1);
        const putIndex = tx.objectStore('index').put({ sha1, updatedAt: Date.now() }, pathKey);
        let done1 = false, done2 = false, done3 = false;
        const check = () => { if (done1 && done2) resolve(); };
        const check3 = () => { if (done1 && done2 && done3) resolve(); };
        putBlob.onsuccess = () => { done1 = true; console.log('NiivueContainer: IDB wrote blob for key', sha1); check3(); };
        putMeta.onsuccess = () => { done2 = true; console.log('NiivueContainer: IDB wrote meta for key', sha1); check3(); };
        putIndex.onsuccess = () => { done3 = true; console.log('NiivueContainer: IDB indexed path', pathKey, '->', sha1); check3(); };
        putBlob.onerror = () => reject(putBlob.error);
        putMeta.onerror = () => reject(putMeta.error);
        putIndex.onerror = () => reject(putIndex.error);
      });
    } catch {}
  }, []);

  // Session cache helpers for FileManager signed URLs
  const getCachedFmUrl = (path: string): string | null => {
    try {
      const raw = sessionStorage.getItem(`niivue:fmLink:${path}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.url || !data?.expires_at) return null;
      const now = Date.now();
      const expires = new Date(data.expires_at).getTime();
      // Safety margin: 30 seconds
      if (expires - now > 30_000) return data.url as string;
      return null;
    } catch {
      return null;
    }
  };

  const setCachedFmUrl = (path: string, url: string, expires_at?: number | string) => {
    try {
      const payload = { url, expires_at: expires_at ?? Date.now() + 5 * 60 * 1000 };
      sessionStorage.setItem(`niivue:fmLink:${path}`, JSON.stringify(payload));
    } catch {}
  };

  // Get available colormaps from Niivue
  const getAvailableColormaps = useCallback(() => {
    if (niivueRef.current && typeof niivueRef.current.colormaps === 'function') {
      try {
        const maps = niivueRef.current.colormaps().filter((name: string) => name.startsWith("ct_"));
        setAvailableColormaps(maps);
        
        // Always apply ct_bones colormap on initialization and sync window values
        if (maps.length > 0) {
          setColormap('ct_bones');
          // Apply the ct_bones colormap immediately
          if (niivueRef.current.volumes.length > 0) {
            const volumeId = niivueRef.current.volumes[0].id;
            niivueRef.current.setColormap(volumeId, 'ct_bones');
            
            // Force a scene update and then sync window level/width
            niivueRef.current.drawScene();
            
            // Use a small delay to ensure colormap is fully applied
            setTimeout(() => {
              const volume = niivueRef.current.volumes[0];
              if (volume.cal_min !== undefined && volume.cal_max !== undefined) {
                const newLevel = (volume.cal_min + volume.cal_max) / 2;
                const newWidth = volume.cal_max - volume.cal_min;
                setWindowLevel(Math.round(newLevel).toString());
                setWindowWidth(Math.round(newWidth).toString());
              }
            }, 10);
          }
        }
      } catch (error) {
        console.warn('Failed to get colormaps from Niivue:', error);
        setAvailableColormaps([]);
      }
    }
  }, [niivueRef]);

  // Handler for changing colormap
  const handleColormapChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const newColormap = event.target.value;
    if (niivueRef.current && niivueRef.current.volumes.length > 0) {
      const volumeId = niivueRef.current.volumes[0].id;
      niivueRef.current.setColormap(volumeId, newColormap);
      setColormap(newColormap); // Update component state
      
      // Sync window level/width with the new colormap
      const volume = niivueRef.current.volumes[0];
      if (volume.cal_min !== undefined && volume.cal_max !== undefined) {
        const newLevel = (volume.cal_min + volume.cal_max) / 2;
        const newWidth = volume.cal_max - volume.cal_min;
        setWindowLevel(Math.round(newLevel).toString());
        setWindowWidth(Math.round(newWidth).toString());
        console.log(`Synced window level: ${newLevel}, width: ${newWidth}`);
      }
    }
  }, [niivueRef]);

  // Handler for changing window level
  const handleWindowLevelChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setWindowLevel(value); // Always update the display value
    
    // Only update volume if value is not empty and is a valid number
    if (value !== '') {
      const newLevel = parseInt(value, 10);
      if (!isNaN(newLevel) && niivueRef.current && niivueRef.current.volumes.length > 0) {
        const volume = niivueRef.current.volumes[0];
        if (volume.cal_min !== undefined && volume.cal_max !== undefined) {
          const currentWidth = parseInt(windowWidth, 10) || 1000;
          volume.cal_min = newLevel - currentWidth / 2;
          volume.cal_max = newLevel + currentWidth / 2;
          niivueRef.current.updateGLVolume();
          niivueRef.current.drawScene();
          console.log(`Window level set to: ${newLevel}`);
        }
      }
    }
  }, [niivueRef, windowWidth]);

  // Handler for changing window width
  const handleWindowWidthChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setWindowWidth(value); // Always update the display value
    
    // Only update volume if value is not empty and is a valid number
    if (value !== '') {
      const newWidth = parseInt(value, 10);
      if (!isNaN(newWidth) && newWidth > 0 && niivueRef.current && niivueRef.current.volumes.length > 0) {
        const volume = niivueRef.current.volumes[0];
        if (volume.cal_min !== undefined && volume.cal_max !== undefined) {
          const currentLevel = parseInt(windowLevel, 10) || 0;
          volume.cal_min = currentLevel - newWidth / 2;
          volume.cal_max = currentLevel + newWidth / 2;
          niivueRef.current.updateGLVolume();
          niivueRef.current.drawScene();
          console.log(`Window width set to: ${newWidth}`);
        }
      }
    }
  }, [niivueRef, windowLevel]);
  // Use available colormaps from Niivue
  const colormapOptions = availableColormaps.map(name => ({ value: name, label: name }));

  // Initialize Niivue
  useEffect(() => {
    if (!canvasRef.current || niivueRef.current) return;

    const initializeNiivue = async () => {
      try {
        const { Niivue } = await import('@niivue/niivue');
        const nv = new Niivue();
        nv.attachTo(canvasId);
        
        // Disable Niivue's built-in loading text
        if (nv.opts) {
          nv.opts.loadingText = '';
        }
        
        // Set default drag mode to slicer3D
        try {
          if (typeof nv.setDragMode === 'function') {
            nv.setDragMode('slicer3D');
            console.log('Drag mode set to slicer3D');
          } else {
            console.log('setDragMode function not available');
          }
        } catch (error) {
          console.warn('Could not set drag mode:', error);
        }
        
        niivueRef.current = nv;
        setIsNiivueReady(true);
        console.log('Niivue initialized successfully with slicer3D drag mode');
        
        // Get available colormaps after Niivue is ready
        setTimeout(() => {
          getAvailableColormaps();
        }, 100);
      } catch (err) {
        console.error('Failed to initialize Niivue:', err);
        setError('Failed to initialize Niivue viewer');
      }
    };

    initializeNiivue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  // Load file when instance changes
  useEffect(() => {
    console.log('NiivueContainer: Checking file loading requirements', {
      hasNiivue: !!niivueRef.current,
      hasInstance: !!currentInstance,
      hasPath: !!currentPath
    });
    
    if (!isNiivueReady || !niivueRef.current) {
      console.log('NiivueContainer: Niivue not ready yet, waiting...', {
        isNiivueReady,
        hasNiivueRef: !!niivueRef.current
      });
      return;
    }
    
    if (!currentInstance) {
      console.log('NiivueContainer: No current instance, waiting...');
      return;
    }
    
    if (!currentPath) {
      console.log('NiivueContainer: No current path, waiting...');
      return;
    }
    
    console.log('NiivueContainer: All requirements met, proceeding with file load...');

    const loadFile = async () => {
      setIsLoading(true);
      setError(null);
      
      // Small delay to ensure niivue is fully ready
      await new Promise(resolve => setTimeout(resolve, 100));
      
      try {
        console.log('NiivueContainer: Starting to load file:', currentPath);
        const fileExtension = currentPath.toLowerCase().split('.').pop();
        console.log('NiivueContainer: File extension:', fileExtension);
        
        if (fileExtension === 'nii' || fileExtension === 'gz') {
          // Load NIfTI file
          console.log('NiivueContainer: Loading NIfTI file');
          
        // Resolve URL for Niivue based on environment
        let fileUrl = currentPath;
        try {
          const isElectron = typeof window !== 'undefined' && (window as any).electron;
          if (isElectron) {
            // Electron: read local file and create a blob URL (supports absolute paths)
            console.log('NiivueContainer: Electron environment detected, reading file...');
            const fileData = await (window as any).electron.invoke('read-file', currentPath);
            const blob = new Blob([fileData], { type: 'application/octet-stream' });
            fileUrl = URL.createObjectURL(blob);
            console.log('NiivueContainer: Created blob URL:', fileUrl);
          } else {
            // Web: try IndexedDB blob cache first
            const lower = currentPath.toLowerCase();
            const isHttp = lower.startsWith('http://') || lower.startsWith('https://');
            if (isHttp) {
              fileUrl = currentPath;
            } else {
              const cachedBlob = await getCachedBlob(currentPath);
              if (cachedBlob) {
                console.log('NiivueContainer: Using cached Blob from IndexedDB');
                fileUrl = URL.createObjectURL(cachedBlob);
              } else {
                // Fallback to FM signed URL, then fetch and cache blob
                const cachedLink = getCachedFmUrl(currentPath);
                let fmUrl: string;
                let expiresAt: any = undefined;
                let etagFromApi: string | undefined;
                if (cachedLink) {
                  fmUrl = cachedLink;
                } else {
                  console.log('NiivueContainer: Generating FM download URL...');
                  const link = await createDownloadLink(currentPath);
                  fmUrl = `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/download/${link.download_token}`;
                  expiresAt = link.expires_at;
                  etagFromApi = (link as any)?.etag as string | undefined;
                  setCachedFmUrl(currentPath, fmUrl, expiresAt);
                }
                // Download blob once and cache it
                console.log('NiivueContainer: Fetching via FM to populate cache...');
                const resp = await fetch(fmUrl);
                if (!resp.ok) throw new Error(`FM fetch failed: ${resp.status}`);
                const blob = await resp.blob();
                // Prefer backend-provided etag as content key to avoid hashing large blobs
                await setCachedBlob(currentPath, blob, typeof expiresAt === 'number' ? expiresAt : undefined, etagFromApi);
                fileUrl = URL.createObjectURL(blob);
              }
            }
          }
        } catch (fetchError) {
          console.error('NiivueContainer: Failed to resolve file URL:', fetchError);
          throw fetchError;
        }
          
          const volumeList = [{
            url: fileUrl,
            name: currentPath.split(/[\\/]/).pop() || 'volume',
            colormap: 'gray',
            opacity: 1,
            visible: true,
            cal_min: 0,
            cal_max: 1000
          }];
          
          try {
            console.log('NiivueContainer: Calling loadVolumes...');
            
            // Add timeout to prevent hanging
            const loadPromise = niivueRef.current.loadVolumes(volumeList);
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Load timeout after 30 seconds')), 30000)
            );
            
            await Promise.race([loadPromise, timeoutPromise]);
            console.log('NIfTI file loaded successfully');
            
            // Apply ct_bones colormap after volume is loaded
            setTimeout(() => {
              if (niivueRef.current && niivueRef.current.volumes.length > 0) {
                const volumeId = niivueRef.current.volumes[0].id;
                niivueRef.current.setColormap(volumeId, 'ct_bones');
                niivueRef.current.drawScene();
                console.log('Applied ct_bones colormap after NIfTI load');
                
                // Sync window level/width
                setTimeout(() => {
                  const volume = niivueRef.current.volumes[0];
                  if (volume.cal_min !== undefined && volume.cal_max !== undefined) {
                    const newLevel = (volume.cal_min + volume.cal_max) / 2;
                    const newWidth = volume.cal_max - volume.cal_min;
                    setWindowLevel(Math.round(newLevel).toString());
                    setWindowWidth(Math.round(newWidth).toString());
                    console.log(`Synced window after NIfTI load - level: ${newLevel}, width: ${newWidth}`);
                  }
                }, 100);
              }
            }, 200);
          } catch (loadError) {
            console.error('NiivueContainer: Load volumes error:', loadError);
            
            // Try alternative loading method
            console.log('NiivueContainer: Trying alternative loading method...');
            try {
              const altLoadPromise = niivueRef.current.loadVolume(fileUrl);
              const altTimeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Alternative load timeout after 30 seconds')), 30000)
              );
              
              await Promise.race([altLoadPromise, altTimeoutPromise]);
              console.log('NiivueContainer: NIfTI file loaded successfully with loadVolume');
            } catch (altError) {
              console.error('NiivueContainer: Alternative loading error:', altError);
              throw loadError; // Throw original error
            }
          }
          
        } else if (fileExtension === 'dcm') {
          // DICOM files should be handled by backend and OpenSeadragon
          console.log('NiivueContainer: DICOM files are handled by backend and OpenSeadragon, not Niivue');
          setError('DICOM files should be opened with OpenSeadragon viewer instead of Niivue');
          return;
        } else {
          console.warn('NiivueContainer: Unsupported file extension:', fileExtension);
          setError(`Unsupported file type: ${fileExtension}`);
        }
        
      } catch (err) {
        console.error('Failed to load file:', err);
        setError(getErrorMessage(err, 'Failed to load file'));
      } finally {
        setIsLoading(false);
      }
    };

    loadFile();
  }, [currentInstance, currentPath, isNiivueReady, getCachedBlob, setCachedBlob]);

  // Handle file upload
  const handleUpload = useCallback(async (filePath: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Check if we are in Electron environment
      const isElectron = typeof window !== 'undefined' && window.electron;
      
      let relativePath: string;
      
      if (isElectron) {
        relativePath = filePath;
        console.log('Electron environment detected. Using full path:', relativePath);
      } else {
        // In web mode, Niivue will download via FM using the full FM path
        // Keep the FM path (e.g., users/.../file.nii.gz) so we can create a signed URL later
        relativePath = filePath;
        console.log('Web environment. Using FM path as relative path:', relativePath);
      }

      // Create instance for the file
      const instanceData = await createInstance(relativePath);
      console.log('NiivueContainer: instanceData:', instanceData);
      
      // Set instanceId in context
      setInstanceId(instanceData.instanceId);
      
      // Add the new instance to Redux state
      dispatch(addWSIInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: {
          dimensions: instanceData.dimensions,
          level_count: instanceData.level_count,
          total_tiles: instanceData.total_tiles,
          file_format: instanceData.file_format
        },
        fileInfo: {
          fileName: filePath.split(/[\\/]/).pop() || '',
          filePath: relativePath
        }
      }));
      
      dispatch(setCurrentPath({ path: relativePath }));
      
    } catch (err) {
      console.error('Error processing file:', err);
      setError(getErrorMessage(err, 'Failed to process file'));
    } finally {
      setIsLoading(false);
    }
  }, [dispatch, setInstanceId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (niivueRef.current) {
        try {
          // Check if close method exists before calling it
          if (typeof niivueRef.current.close === 'function') {
            niivueRef.current.close();
          } else {
            // Alternative cleanup methods
            if (typeof niivueRef.current.destroy === 'function') {
              niivueRef.current.destroy();
            } else if (typeof niivueRef.current.dispose === 'function') {
              niivueRef.current.dispose();
            }
          }
        } catch (err) {
          console.error('Error closing Niivue:', err);
        }
      }
    };
  }, []);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="text-red-500 text-lg font-semibold mb-2">Error</div>
          <div className="text-gray-600">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-black">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-10">
          <div className="text-white text-lg">Loading...</div>
        </div>
      )}
      <canvas
        ref={canvasRef}
        id={canvasId}
        className="w-full h-full"
        style={{ display: 'block' }}
      />
      
       {/* Top bar with colormap selector and window controls */}
       <div className="absolute top-0 left-0 right-0 bg-black bg-opacity-75 text-white p-2 flex items-center justify-between">
         <div className="flex items-center space-x-4">
           {colormapOptions.length > 0 && (
             <div className="flex items-center space-x-2">
               <label htmlFor="colormap-select" className="text-sm font-medium">
                 Colormap:
               </label>
               <select
                 id="colormap-select"
                 value={colormap}
                 onChange={handleColormapChange}
                 className="px-2 py-1 rounded border border-gray-300 bg-white text-black text-sm min-w-[120px]"
               >
                 {colormapOptions.map((option) => (
                   <option key={option.value} value={option.value}>
                     {option.label}
                   </option>
                 ))}
               </select>
             </div>
           )}
           
           {/* Window Level/Width controls */}
           <div className="flex items-center space-x-2">
             <label htmlFor="window-level" className="text-sm font-medium">
               Level:
             </label>
             <input
               id="window-level"
               type="text"
               value={windowLevel}
               onChange={handleWindowLevelChange}
               className="w-20 px-2 py-1 rounded border border-gray-300 bg-white text-black text-sm"
             />
             <label htmlFor="window-width" className="text-sm font-medium">
               Width:
             </label>
             <input
               id="window-width"
               value={windowWidth}
               onChange={handleWindowWidthChange}
               className="w-20 px-2 py-1 rounded border border-gray-300 bg-white text-black text-sm"
             />
           </div>
         </div>
       </div>
      
      {/* Radiology mask status indicator */}
      {maskLoaded && (
        <div className={`absolute right-4 bg-black bg-opacity-75 text-white px-3 py-2 rounded text-sm ${colormapOptions.length > 0 ? 'top-12' : 'top-4'}`}>
          Radiology Mask: {maskVisible ? 'Visible' : 'Hidden'}
        </div>
      )}
      
      {/* Niivue Segmentation Handler */}
      <NiivueSegmentationHandler
        niivueRef={niivueRef}
        currentPath={currentPath}
        onMaskLoaded={setMaskLoaded}
        onMaskVisibilityChanged={setMaskVisible}
      />
    </div>
  );
};

export default NiivueContainer;
