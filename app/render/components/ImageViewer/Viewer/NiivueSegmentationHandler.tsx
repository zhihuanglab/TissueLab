"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useShortcuts } from "@/hooks/viewer/useShortcuts";
import { autoFindAndLoadRadiologyMask } from "@/services/data.service";
import { getErrorMessage } from "@/utils/common/apiResponse";

interface NiivueSegmentationHandlerProps {
  niivueRef: React.RefObject<any>;
  currentPath: string | null;
  onMaskLoaded?: (loaded: boolean) => void;
  onMaskVisibilityChanged?: (visible: boolean) => void;
}

// Helper function to create colormap from class information
const createColormapFromClassInfo = (classInfo: Array<{
  class_id: number;
  dataset_name: string;
  dataset_path: string;
  nonzero_count: number;
}>) => {
  // Predefined colors for different classes (RGB values)
  const colors = [
    [0, 0, 0, 0],        // Background (transparent)
    [255, 0, 0, 255],    // Red
    [0, 255, 0, 255],    // Green  
    [0, 0, 255, 255],     // Blue
    [255, 255, 0, 255],  // Yellow
    [255, 0, 255, 255],  // Magenta
    [0, 255, 255, 255],  // Cyan
    [255, 128, 0, 255],  // Orange
    [128, 0, 255, 255],  // Purple
    [255, 192, 203, 255], // Pink
  ];
  
  const maxClasses = Math.max(...classInfo.map(c => c.class_id));
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  const labels: string[] = ["Background"];
  
  // Initialize with background color
  for (let i = 0; i <= maxClasses; i++) {
    if (i === 0) {
      R.push(0);
      G.push(0);
      B.push(0);
    } else {
      const colorIndex = ((i - 1) % (colors.length - 1)) + 1; // Skip background color
      R.push(colors[colorIndex][0]);
      G.push(colors[colorIndex][1]);
      B.push(colors[colorIndex][2]);
    }
  }
  
  // Add labels for each class
  classInfo.forEach(classItem => {
    labels[classItem.class_id] = classItem.dataset_name;
  });
  
  return {
    R,
    G,
    B,
    labels
  };
};

const NiivueSegmentationHandler: React.FC<NiivueSegmentationHandlerProps> = ({
  niivueRef,
  currentPath,
  onMaskLoaded,
  onMaskVisibilityChanged
}) => {
  const [maskLoaded, setMaskLoaded] = useState(false);
  const [maskVisible, setMaskVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { bindings } = useShortcuts();
  // Keep reference to constructed NVImage mask for potential re-use
  const maskImageRef = useRef<any>(null);

  // Create a valid NIfTI-1 single-file (.nii) with header
  const createNiftiFile = (data: Uint8Array, shape: number[], dtypeStr: string = 'float64'): Uint8Array => {
    // NIfTI-1 header is 348 bytes; set vox_offset=352 and add 4-byte extender (zeros)
    const header = new Uint8Array(348);

    // sizeof_hdr (int32 little-endian) at byte 0
    new DataView(header.buffer).setInt32(0, 348, true);

    // dim[] (int16) at byte 40, dim[0]=number of dims
    const dim = new Int16Array(header.buffer, 40, 8);
    dim[0] = 3; // 3D
    dim[1] = shape[0] || 1;
    dim[2] = shape[1] || 1;
    dim[3] = shape[2] || 1;

    // datatype (int16) at byte 70, bitpix (int16) at byte 72
    const datatype = new Int16Array(header.buffer, 70, 1);
    const bitpix = new Int16Array(header.buffer, 72, 1);
    // Map dtype string to NIfTI datatype codes
    const mapDtype = (s: string) => {
      const t = (s || '').toLowerCase();
      if (t.includes('uint8')) return { dt: 2, bp: 8 };
      if (t.includes('int16')) return { dt: 4, bp: 16 };
      if (t.includes('int32')) return { dt: 8, bp: 32 };
      if (t.includes('float32') || t.includes('single')) return { dt: 16, bp: 32 };
      if (t.includes('float64') || t.includes('double')) return { dt: 64, bp: 64 };
      // default to uint8
      return { dt: 2, bp: 8 };
    };
    const { dt, bp } = mapDtype(dtypeStr);
    datatype[0] = dt;
    bitpix[0] = bp;

    // pixdim (float32) at byte 76: set to 1,1,1
    const pixdim = new Float32Array(header.buffer, 76, 8);
    pixdim[0] = 0.0;
    pixdim[1] = 1.0;
    pixdim[2] = 1.0;
    pixdim[3] = 1.0;

    // qform_code/sform_code (int16) to 0 (unknown)
    new Int16Array(header.buffer, 252, 1)[0] = 0; // qform_code
    new Int16Array(header.buffer, 254, 1)[0] = 0; // sform_code

    // vox_offset (float32) at byte 108 -> 352.0 (data starts after 4-byte extender)
    new Float32Array(header.buffer, 108, 1)[0] = 352.0;

    // magic at 344: 'n+1\0'
    header[344] = 0x6E; // 'n'
    header[345] = 0x2B; // '+'
    header[346] = 0x31; // '1'
    header[347] = 0x00; // '\0'

    // 4-byte extender (zeros) after header
    const extender = new Uint8Array(4); // all zeros

    // Combine header + extender + data
    const niftiFile = new Uint8Array(348 + 4 + data.length);
    niftiFile.set(header, 0);
    niftiFile.set(extender, 348);
    niftiFile.set(data, 352);
    return niftiFile;
  };

  // Load segmentation mask from Zarr file using backend API
  const loadSegmentationMask = useCallback(async () => {
    if (!currentPath || !niivueRef.current) return;
    
    try {
      setIsLoading(true);
      setError(null);
      console.log('Searching for radiology mask using backend API...');
      
      // Use the backend API to automatically find and load radiology mask
      console.log('Calling autoFindAndLoadRadiologyMask with path:', currentPath);
      
      // Prefer sending the full file path so backend can match basename
      console.log('Using file path for Zarr search:', currentPath);
      const result = await autoFindAndLoadRadiologyMask(currentPath);
      console.log('API response:', result);
      
      if (result.success && result.found && result.data) {
        console.log('Radiology mask loaded:', result.shape, 'from dataset:', result.dataset_info?.dataset_path);
        
        // Log merge information if this is a merged dataset
        if (result.is_merged && result.class_info) {
          console.log('Merged dataset detected with', result.num_classes, 'classes:');
          result.class_info.forEach((classInfo: any) => {
            console.log(`  Class ${classInfo.class_id}: ${classInfo.dataset_name} (${classInfo.nonzero_count} voxels)`);
          });
        }
        
         // Handle both single and merged datasets as uint8 labelmaps
        const processMaskData = (buf: ArrayBuffer, dtype: string, isMerged: boolean): Uint8Array => {
          const t = (dtype || '').toLowerCase();
          if (t === 'uint8') {
            // For uint8 data, keep the original values (both single and merged)
            return new Uint8Array(buf);
          }
          
          // Handle other dtypes - convert to uint8 while preserving label values
          let arr: ArrayLike<number>;
          if (t.includes('float64') || t.includes('double')) arr = new Float64Array(buf);
          else if (t.includes('float32') || t.includes('single')) arr = new Float32Array(buf);
          else if (t.includes('int16')) arr = new Int16Array(buf);
          else if (t.includes('int32')) arr = new Int32Array(buf);
          else if (t.includes('uint16')) arr = new Uint16Array(buf);
          else if (t.includes('uint32')) arr = new Uint32Array(buf);
          else arr = new Uint8Array(buf);
          
          const out = new Uint8Array((arr as any).length);
          for (let i = 0; i < (arr as any).length; i++) {
            const val = (arr as any)[i];
            // Preserve label values, ensuring they fit in uint8 (0-255)
            out[i] = val > 0 ? Math.min(Math.max(val, 1), 255) : 0;
          }
          return out;
        };
        // result.data is now a Uint8Array from the binary response
        const dataArray = result.data instanceof Uint8Array ? result.data : processMaskData(result.data, result.dtype || 'uint8', result.is_merged || false);
        // Debug: count non-zero voxels and class distribution for both single and merged data
        try {
          let nonZero = 0;
          const classCounts: { [key: number]: number } = {};
          for (let i = 0; i < dataArray.length; i++) {
            const val = dataArray[i];
            if (val !== 0) {
              nonZero++;
              // Count class distribution for both single and merged datasets
              classCounts[val] = (classCounts[val] || 0) + 1;
            }
          }
          console.log('NiivueSegmentationHandler: mask non-zero voxels =', nonZero, 'of', dataArray.length);
          if (Object.keys(classCounts).length > 0) {
            console.log('Label distribution:', classCounts);
            if (result.is_merged) {
              console.log('(Merged dataset with', result.num_classes, 'classes)');
            } else {
              console.log('(Single dataset)');
            }
          }
        } catch {}
        
        if (!result.shape) {
          throw new Error('Shape is undefined');
        }

        if (!result.dtype) {
          throw new Error('Dtype is undefined');
        }
        
        const nv = niivueRef.current as any;
        let loadState = false;

        // Validate shape and align to background volume
        const back = nv.back || (nv.volumes && nv.volumes.length ? nv.volumes[0] : null);
        if (!back || !back.hdr || !back.hdr.dims || !back.permRAS) {
          throw new Error('Cannot determine background image to align drawing');
        }

        const backDims = back.hdr.dims.slice ? back.hdr.dims.slice() : back.hdr.dims; // [nDim, X, Y, Z, ...]
        const expectedX = backDims[1];
        const expectedY = backDims[2];
        const expectedZ = backDims[3];

        // Validate dimensionality
        if (result.shape.length !== 3) {
          throw new Error(`Mask shape is not 3D: ${JSON.stringify(result.shape)}. Increase maxElements or adjust backend.`);
        }

        const expectedVoxels = expectedX * expectedY * expectedZ;

        let [s0, s1, s2] = result.shape; // unknown order
        console.log('NiivueSegmentationHandler: Received shape from backend:', result.shape);
        console.log('NiivueSegmentationHandler: Expected background dimensions:', { expectedX, expectedY, expectedZ });
        let alignedData = dataArray;

        // Handle subset (2D slice) returned as 3D shape metadata
        if (alignedData.length !== expectedVoxels) {
          // If it's exactly a single XY slice, expand into a 3D volume at mid-Z
          if (alignedData.length === (expectedX * expectedY)) {
            console.log('Expanding 2D slice into 3D volume at middle Z');
            const Z = expectedZ, Y = expectedY, X = expectedX;
            const dest = new Uint8Array(expectedVoxels);
            const midZ = Math.floor(Z / 2);
            for (let y = 0; y < Y; y++) {
              for (let x = 0; x < X; x++) {
                const srcIdx = (y * X) + x; // XY slice
                const dstIdx = (x * Y * Z) + (y * Z) + midZ; // XYZ volume
                dest[dstIdx] = alignedData[srcIdx];
              }
            }
            alignedData = dest;
          } else {
            throw new Error(`Mask voxel count ${alignedData.length} does not match expected ${expectedVoxels}`);
          }
        }

        // Decide permutation to match [X,Y,Z]; support ZYX, YXZ, XZY
        const isXYZ = (s0 === expectedX && s1 === expectedY && s2 === expectedZ);
        const isZYX = (s0 === expectedZ && s1 === expectedY && s2 === expectedX);
        const isYXZ = (s0 === expectedY && s1 === expectedX && s2 === expectedZ);
        const isXZY = (s0 === expectedX && s1 === expectedZ && s2 === expectedY);
        
        console.log('NiivueSegmentationHandler: Coordinate format detection:', {
          isXYZ, isZYX, isYXZ, isXZY,
          received: [s0, s1, s2],
          expected: [expectedX, expectedY, expectedZ]
        });
        if (!(isXYZ || isZYX || isYXZ || isXZY)) {
          throw new Error(`Mask shape ${result.shape.join('x')} does not match background ${expectedX}x${expectedY}x${expectedZ}`);
        }
        // Niivue expects ZYX format, so convert from XYZ to ZYX
        if (isXYZ) {
          console.log('Converting from XYZ to ZYX format for Niivue');
          const X = expectedX, Y = expectedY, Z = expectedZ;
          const src = alignedData;
          const dest = new Uint8Array(src.length);
          
          // Convert from XYZ to ZYX
          for (let x = 0; x < X; x++) {
            for (let y = 0; y < Y; y++) {
              for (let z = 0; z < Z; z++) {
                const srcIdx = (x * Y * Z) + (y * Z) + z; // X,Y,Z source
                const dstIdx = (z * Y * X) + (y * X) + x; // Z,Y,X destination
                dest[dstIdx] = src[srcIdx];
              }
            }
          }
          alignedData = dest;
        } else if (!isZYX) {
          console.log('Reordering mask to ZYX from', isYXZ ? 'YXZ' : 'XZY');
          const X = expectedX, Y = expectedY, Z = expectedZ;
          const src = alignedData;
          const dest = new Uint8Array(src.length);
          if (isYXZ) {
            for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) for (let z = 0; z < Z; z++) {
              const srcIdx = (y * X * Z) + (x * Z) + z; // Y,X,Z
              const dstIdx = (z * Y * X) + (y * X) + x; // Z,Y,X
              dest[dstIdx] = src[srcIdx];
            }
          } else if (isXZY) {
            for (let x = 0; x < X; x++) for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) {
              const srcIdx = (x * Z * Y) + (z * Y) + y; // X,Z,Y
              const dstIdx = (z * Y * X) + (y * X) + x; // Z,Y,X
              dest[dstIdx] = src[srcIdx];
            }
          }
          alignedData = dest;
        }

        // Final sanity check
        try {
          let nonZeroAligned = 0;
          for (let i = 0; i < alignedData.length; i++) if (alignedData[i] !== 0) nonZeroAligned++;
          console.log('NiivueSegmentationHandler: aligned non-zero voxels =', nonZeroAligned, 'of', alignedData.length);
        } catch {}

        // Build drawing bitmap aligned to background
        const drawingBitmap: any = {
          hdr: { dims: backDims },
          permRAS: back.permRAS.slice ? back.permRAS.slice() : back.permRAS,
          img: alignedData
        };
        loadState = nv.loadDrawing(drawingBitmap);
        console.log('NiivueSegmentationHandler: loadDrawing completed', loadState);

        // Set up colormap for merged datasets
        if (result.is_merged && result.class_info && result.class_info.length > 0) {
          console.log('Setting up colormap for merged dataset with', result.num_classes, 'classes');
          
          // Create colormap based on class information
          const colormap = createColormapFromClassInfo(result.class_info);
          nv.setDrawColormap(colormap);
          nv.setDrawOpacity(0.5)
        } else {
          // For single datasets, use default settings
          nv.setDrawingOpacity?.(0.5);
          if ('drawOpacity' in nv) nv.drawOpacity = 0.5;
          if (nv.opts && typeof nv.opts === 'object') nv.opts.drawOpacity = 0.5;
        }
        
        nv.updateGLVolume?.();
        nv.drawScene?.();
        
        setMaskLoaded(true);
        setMaskVisible(true);
        // Defer parent updates to avoid setState during render of another component
        Promise.resolve().then(() => {
          onMaskLoaded?.(true);
          onMaskVisibilityChanged?.(true);
        });
        console.log('Radiology mask loaded successfully');
      } else {
        console.log('No radiology mask found:', result.message);
        setError(result.message || 'No radiology mask found');
      }
    } catch (error) {
      console.error('Failed to load radiology mask:', error);
      console.error('Error details:', error);
      setError(getErrorMessage(error, 'Failed to load radiology mask'));
    } finally {
      setIsLoading(false);
    }
  }, [currentPath, niivueRef, onMaskLoaded, onMaskVisibilityChanged]);

  // Toggle mask visibility
  const toggleMaskVisibility = useCallback(() => {
    if (!niivueRef.current || !maskLoaded) return;

    setMaskVisible(prev => {
      console.log('NiivueSegmentationHandler: toggleMaskVisibility ->', { prev });
      const newVisibility = !prev;
      // Toggle drawing overlay via official API
      const targetOpacity = newVisibility ? 0.5 : 0.0;
      const nv = niivueRef.current as any;
      console.log('NiivueSegmentationHandler: toggleMaskVisibility ->', { targetOpacity });
      // Only change opacity
      nv.setDrawingOpacity?.(targetOpacity);
      // Keep internal mirrors in sync if present
      if ('drawOpacity' in nv) nv.drawOpacity = targetOpacity;
      if (nv.opts && typeof nv.opts === 'object') nv.opts.drawOpacity = targetOpacity;
      nv.updateGLVolume?.();
      nv.drawScene?.();
      // Defer parent updates to next microtask to avoid React warning
      Promise.resolve().then(() => onMaskVisibilityChanged?.(newVisibility));
      return newVisibility;
    });
  }, [maskLoaded, niivueRef, onMaskVisibilityChanged]);

  // Keyboard event handling
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the target is an input element
      const target = event.target as HTMLElement;
      const isInputElement = target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.contentEditable === 'true';

      if (isInputElement) {
        return;
      }
      
      // Ignore auto-repeat
      if (event.repeat) {
        return;
      }
      
      const eventKeyNorm = (event.key === ' ')
        ? 'Space'
        : (event.key && event.key.length === 1 ? event.key.toLowerCase() : event.code);
      const normalize = (k?: string) => (k ? (k.length === 1 ? k.toLowerCase() : k) : '');
      const bindingKey = 'Space';

      if (eventKeyNorm === normalize(bindingKey)) {
        event.preventDefault();
        if (maskLoaded) {
          toggleMaskVisibility();
        } else {
          loadSegmentationMask();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [bindings.toggleNuclei, maskLoaded, loadSegmentationMask, toggleMaskVisibility]);

  // Reset mask state when path changes
  useEffect(() => {
    setMaskLoaded(false);
    setMaskVisible(false);
    setError(null);
  }, [currentPath]);

  // Expose methods for external control
  useEffect(() => {
    if (niivueRef.current) {
      niivueRef.current.loadSegmentationMask = loadSegmentationMask;
      niivueRef.current.toggleMaskVisibility = toggleMaskVisibility;
      niivueRef.current.maskLoaded = maskLoaded;
      niivueRef.current.maskVisible = maskVisible;
    }
  }, [niivueRef, loadSegmentationMask, toggleMaskVisibility, maskLoaded, maskVisible]);

  return null; // This component doesn't render anything, it just handles logic
};

export default NiivueSegmentationHandler;
