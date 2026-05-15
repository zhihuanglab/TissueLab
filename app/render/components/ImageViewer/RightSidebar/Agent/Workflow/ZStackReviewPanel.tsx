/**
 * Z-Stack Review Panel for Active Learning
 * Allows reviewing nuclei across multiple z-layers with z-profile visualization
 */

import React, { useState, useEffect } from 'react';
import { Layers, ChevronUp, ChevronDown } from 'lucide-react';

interface ZStackReviewPanelProps {
  cellId: string;
  slideId: string;
  zStackInfo?: {
    has_zstack: boolean;
    layer_count: number;
    layer_indices: number[];
  };
  onLayerChange?: (layer: number) => void;
}

const ZStackReviewPanel: React.FC<ZStackReviewPanelProps> = ({
  cellId,
  slideId,
  zStackInfo,
  onLayerChange
}) => {
  const [currentLayer, setCurrentLayer] = useState<number>(0);
  const [layerImages, setLayerImages] = useState<Record<number, string>>({});
  const [zProfile, setZProfile] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Define load functions before useEffect
  const loadLayerImages = async () => {
    setLoading(true);
    try {
      // Load cell images from each z-layer
      const images: Record<number, string> = {};
      
      for (const layerIdx of zStackInfo?.layer_indices || []) {
        const response = await fetch(`/api/tasks/cell-review-tile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slide_id: slideId,
            cell_id: cellId,
            z_layer: layerIdx,
            window_size_px: 128,
            target_fov_um: 20.0
          })
        });
        
        const data = await response.json();
        if (data.success && data.data?.image) {
          images[layerIdx] = data.data.image;
        }
      }
      
      setLayerImages(images);
    } catch (error) {
      console.error('[ZStack Review] Error loading layer images:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadZProfile = async () => {
    try {
      // Load z-profile data (intensity, area, etc. across layers)
      const response = await fetch(`/api/active-learning/z-profile?slide_id=${slideId}&cell_id=${cellId}`);
      const data = await response.json();
      
      if (data.success) {
        setZProfile(data.data);
      }
    } catch (error) {
      console.error('[ZStack Review] Error loading z-profile:', error);
    }
  };

  // Load data when component mounts or dependencies change
  useEffect(() => {
    // Only load if we have valid z-stack info
    if (!zStackInfo || !zStackInfo.has_zstack) {
      return;
    }
    
    // Load images for all layers
    loadLayerImages();
    // Load z-profile data
    loadZProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, slideId, zStackInfo]);

  // Don't render if no z-stack
  if (!zStackInfo || !zStackInfo.has_zstack) {
    return null;
  }

  const handleLayerChange = (newLayer: number) => {
    setCurrentLayer(newLayer);
    if (onLayerChange) {
      onLayerChange(newLayer);
    }
  };

  const goToPreviousLayer = () => {
    if (currentLayer > 0) {
      handleLayerChange(currentLayer - 1);
    }
  };

  const goToNextLayer = () => {
    if (zStackInfo && currentLayer < zStackInfo.layer_count - 1) {
      handleLayerChange(currentLayer + 1);
    }
  };

  return (
    <div className="z-stack-review-panel bg-card rounded-lg p-4 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <Layers size={18} className="text-primary" />
        <h3 className="text-foreground font-semibold">Z-Stack View</h3>
        <span className="text-muted-foreground text-sm">
          Cell #{cellId}
        </span>
      </div>

      {/* Layer Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={goToPreviousLayer}
          disabled={currentLayer === 0}
          className="p-2 bg-primary rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronUp size={20} className="text-primary-foreground" />
        </button>

        <div className="text-center">
          <div className="text-foreground font-bold text-lg">
            Layer {currentLayer + 1} / {zStackInfo.layer_count}
          </div>
          <input
            type="range"
            min={0}
            max={zStackInfo.layer_count - 1}
            value={currentLayer}
            onChange={(e) => handleLayerChange(parseInt(e.target.value))}
            className="w-full mt-2"
          />
        </div>

        <button
          onClick={goToNextLayer}
          disabled={currentLayer === zStackInfo.layer_count - 1}
          className="p-2 bg-primary rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronDown size={20} className="text-primary-foreground" />
        </button>
      </div>

      {/* Current Layer Image */}
      <div className="mb-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 bg-muted/40 rounded">
            <div className="text-muted-foreground">Loading...</div>
          </div>
        ) : layerImages[currentLayer] ? (
          <img
            src={layerImages[currentLayer]}
            alt={`Layer ${currentLayer + 1}`}
            className="w-full h-auto rounded border-2 border-primary"
          />
        ) : (
          <div className="flex items-center justify-center h-32 bg-muted/40 rounded">
            <div className="text-muted-foreground">No image available</div>
          </div>
        )}
      </div>

      {/* Z-Profile Visualization */}
      {zProfile && (
        <div className="bg-muted/40 rounded p-3">
          <h4 className="text-foreground text-sm font-semibold mb-2">Z-Profile</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Max Area:</span>
              <span className="text-foreground ml-2">{zProfile.max_area?.toFixed(1)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Volume:</span>
              <span className="text-foreground ml-2">{zProfile.volume_estimate?.toFixed(1)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Z-Extent:</span>
              <span className="text-foreground ml-2">{zProfile.z_extent} layers</span>
            </div>
            <div>
              <span className="text-muted-foreground">Consistency:</span>
              <span className="text-foreground ml-2">{(zProfile.shape_consistency * 100)?.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Layer Thumbnails */}
      <div className="mt-4">
        <h4 className="text-foreground text-sm font-semibold mb-2">All Layers</h4>
        <div className="grid grid-cols-5 gap-2">
          {zStackInfo.layer_indices.map((layerIdx) => (
            <button
              key={layerIdx}
              onClick={() => handleLayerChange(layerIdx)}
              className={`relative aspect-square rounded overflow-hidden border-2 ${
                currentLayer === layerIdx
                  ? 'border-primary'
                  : 'border-border opacity-60 hover:opacity-100'
              }`}
            >
              {layerImages[layerIdx] ? (
                <img
                  src={layerImages[layerIdx]}
                  alt={`Layer ${layerIdx + 1}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-muted/40 flex items-center justify-center">
                  <span className="text-xs text-muted-foreground">{layerIdx + 1}</span>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ZStackReviewPanel;

