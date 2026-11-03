import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { tileTransport } from './tileDemand';

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
    epoch?: number;
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
    ...tileTransport(),
    width,
    height,
    tileSize: tile_size,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel,
    // Authentication stays on the viewer so token refresh applies to every tile.
    getTileUrl(level: number, x: number, y: number) {
      let url = getTileUrl(level, x, y);
      if (Number.isInteger(options?.epoch)) url += `${url.includes('?') ? '&' : '?'}content_epoch=${options!.epoch}`;
      return level === 0 ? `${url}${url.includes('?') ? '&' : '?'}overview=1` : url;
    },
    _key: `${currentInstanceId}_${currentWSIFileInfo?.filePath || ''}_${width}_${height}_${keySuffix}_${options?.epoch ?? ''}`,
    // The backend session these tiles belong to (tileSession restores it).
    _instanceId: currentInstanceId,
  };
}

/** Preload a layer, then switch once its overview has usable pixels (including cached tiles). */
export function preloadTileLayer(viewer: any, tileSource: any): () => void {
  const world = viewer.world;
  const previous = world.getItemCount() ? world.getItemAt(0) : null;
  let item: any = null;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout>;
  const remove = (image: any) => {
    if (image && world.getIndexOfItem(image) >= 0) world.removeItem(image);
  };
  const cleanup = () => {
    disposed = true;
    clearTimeout(timeout);
    viewer.removeHandler('tile-loaded', loaded);
    world.removeHandler('remove-item', removed);
    item?.removeHandler('fully-loaded-change', covered);
  };
  const cancel = () => { cleanup(); remove(item); };
  const switchLayer = () => {
    if (disposed || viewer.isDestroyed() || !item || world.getIndexOfItem(item) < 0) return;
    cleanup();
    item.setOpacity(1);
    remove(previous);
  };
  // OSD also reports fullyLoaded when every requested tile failed and was
  // marked missing. That is not coverage: keep the working layer in that case.
  const covered = () => {
    if (item?.tilesMatrix?.[0]?.[0]?.[0]?.loaded) switchLayer();
  };
  // After the overview deadline any real pixels of the new layer will do.
  let overviewOverdue = false;
  const loaded = (event: any) => {
    if (event.tiledImage !== item || (event.tile?.level !== 0 && !overviewOverdue)) return;
    // OSD resolves this after the handler returns. Returning/awaiting it here deadlocks OSD.
    void event.promise.then(switchLayer, cancel);
  };
  const removed = (event: any) => { if (event.item === item) cleanup(); };
  viewer.addHandler('tile-loaded', loaded);
  world.addHandler('remove-item', removed);
  // The viewer already reports the new layer, so a slow or failed overview
  // must not strand it: switch to whatever detail has loaded. With nothing
  // loaded yet, keep the old pixels (never a blank layer) and switch on the
  // first tile that does arrive.
  timeout = setTimeout(() => {
    if (!item) { cancel(); return; }
    overviewOverdue = true;
    const levels = Object.values(item.tilesMatrix ?? {}) as any[];
    if (levels.some(columns => Object.values(columns).some((rows: any) =>
      Object.values(rows).some((tile: any) => tile.loaded)))) switchLayer();
  }, 30000);
  try {
    viewer.addTiledImage({
      tileSource, index: 1, preload: true, opacity: 0,
      success: (event: any) => {
        item = event.item;
        if (disposed || viewer.isDestroyed()) { remove(item); return; }
        item.addHandler('fully-loaded-change', covered);
        covered();
      },
      error: cancel,
    });
  } catch (error) { cancel(); throw error; }
  return () => { if (!disposed) cancel(); };
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

