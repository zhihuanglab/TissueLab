import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';

/**
 * Function to convert microns to appropriate unit
 */
export function convertToAppropriateUnit(microns: number): { value: number; unit: string } {
  if (microns >= 1000000) {
    return { value: microns / 1000000, unit: 'm' };
  } else if (microns >= 10000) {
    return { value: microns / 10000, unit: 'cm' };
  } else if (microns >= 1000) {
    return { value: microns / 1000, unit: 'mm' };
  } else {
    return { value: microns, unit: 'µm' };
  }
}

/**
 * Create a tile URL generator function
 */
export function createTileUrlGenerator(
  visibleChannels: number[],
  channels: any[],
  currentInstanceId: string | undefined,
  channelSignature: string,
  currentZLayer: number
): (level: number, x: number, y: number) => string {
  return (level: number, x: number, y: number): string => {
    const params = new URLSearchParams();

    visibleChannels.forEach(channelIndex => {
      const channel = channels[channelIndex];
      if (channel && channel.color) {
        params.append('channels[]', channelIndex.toString());
        params.append('colors[]', channel.color.replace('#', ''));
      }
    });

    if (currentInstanceId) {
      params.append('instance_id', currentInstanceId);
    }
    
    // Add z_layer parameter for z-stack support and cache-busting
    params.append('z_layer', currentZLayer.toString());
    
    // cache-busting signature for color changes
    if (channelSignature) {
      params.append('sig', channelSignature);
    }
    const queryString = params.toString();
    return `${AI_SERVICE_API_ENDPOINT}/load/v1/tile/${level}/${x}_${y}.jpeg${queryString ? `?${queryString}` : ''}`;
  };
}

/**
 * Create a tile URL generator function for a specific z-layer
 */
export function createTileUrlGeneratorForLayer(
  visibleChannels: number[],
  channels: any[],
  currentInstanceId: string | undefined,
  channelSignature: string,
  layer: number
): (level: number, x: number, y: number) => string {
  return (level: number, x: number, y: number): string => {
    const params = new URLSearchParams();

    visibleChannels.forEach(channelIndex => {
      const channel = channels[channelIndex];
      if (channel && channel.color) {
        params.append('channels[]', channelIndex.toString());
        params.append('colors[]', channel.color.replace('#', ''));
      }
    });

    if (currentInstanceId) {
      params.append('instance_id', currentInstanceId);
    }
    
    // Use the NEW layer value directly, not currentZLayer state
    params.append('z_layer', layer.toString());
    
    // cache-busting signature for color changes
    if (channelSignature) {
      params.append('sig', channelSignature);
    }
    const queryString = params.toString();
    return `${AI_SERVICE_API_ENDPOINT}/load/v1/tile/${level}/${x}_${y}.jpeg${queryString ? `?${queryString}` : ''}`;
  };
}

/**
 * Create tile source configuration
 */
export function createTileSource(
  dimensions: { width: number; height: number },
  getTileUrl: (level: number, x: number, y: number) => string,
  currentInstanceId: string | undefined,
  currentWSIFileInfo: any,
  options?: {
    zLayer?: number;
    channelSignature?: string;
  }
): any {
  const { width, height } = dimensions;
  const tile_size = 512;
  const maxLevel = Math.max(
    0,
    Math.ceil(Math.log2(Math.max(width, height) / tile_size)),
  );

  const keySuffix = options?.zLayer !== undefined
    ? `zlayer${options.zLayer}`
    : (options?.channelSignature || '');

  return {
    width,
    height,
    tileSize: tile_size,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel,
    getTileUrl: getTileUrl,
    ajaxHeaders: undefined,
    _key: `${currentInstanceId}_${currentWSIFileInfo?.filePath || ''}_${width}_${height}_${keySuffix}`,
    _instanceId: currentInstanceId,
    _dimensions: { width, height }
  };
}

/**
 * Get the largest tiled image from OpenSeadragon viewer world
 * This function finds the tiled image with the largest content size (width * height)
 * Falls back to the first item if no valid size can be determined
 * 
 * @param viewerInstance - OpenSeadragon viewer instance
 * @returns The largest tiled image, or null if no items exist
 */
export function getLargestTiledImage(viewerInstance: any): any | null {
  if (!viewerInstance?.world) {
    return null;
  }

  const itemCount = viewerInstance.world.getItemCount();
  if (itemCount === 0) {
    return null;
  }

  let tiledImage = null;
  let maxSize = 0;

  for (let i = 0; i < itemCount; i++) {
    const item = viewerInstance.world.getItemAt(i);
    const size = item?.getContentSize?.();
    if (size && size.x * size.y > maxSize) {
      maxSize = size.x * size.y;
      tiledImage = item;
    }
  }

  // Fallback to first item if no valid size was found
  if (!tiledImage && itemCount > 0) {
    tiledImage = viewerInstance.world.getItemAt(0);
  }

  return tiledImage;
}

