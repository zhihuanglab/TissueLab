'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AvatarCropperProps {
  isOpen: boolean;
  onClose: () => void;
  imageSrc: string;
  onCropComplete: (croppedFile: File) => void;
  fileName: string;
}

const AvatarCropper: React.FC<AvatarCropperProps> = ({
  isOpen,
  onClose,
  imageSrc,
  onCropComplete,
  fileName,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [cropArea, setCropArea] = useState<CropArea>({ x: 50, y: 50, width: 200, height: 200 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 400, height: 400 });

  // Load image and set initial crop area
  useEffect(() => {
    if (isOpen && imageSrc) {
      const img = new Image();
      img.onload = () => {
        setImageLoaded(true);
        
        // Calculate canvas size to fit the image while maintaining aspect ratio
        const maxSize = 400;
        const ratio = Math.min(maxSize / img.width, maxSize / img.height);
        const displayWidth = img.width * ratio;
        const displayHeight = img.height * ratio;
        
        setCanvasSize({ width: displayWidth, height: displayHeight });
        
        // Set initial crop area to center square
        const cropSize = Math.min(displayWidth, displayHeight) * 0.6;
        setCropArea({
          x: (displayWidth - cropSize) / 2,
          y: (displayHeight - cropSize) / 2,
          width: cropSize,
          height: cropSize,
        });
        
        if (imageRef.current) {
          imageRef.current.src = imageSrc;
        }
      };
      img.src = imageSrc;
    }
  }, [isOpen, imageSrc]);

  // Draw the canvas with image and crop overlay
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageLoaded) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Draw crop overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Clear crop area
    ctx.clearRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);
    
    // Draw image again in crop area
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    
    ctx.drawImage(
      img,
      cropArea.x * scaleX,
      cropArea.y * scaleY,
      cropArea.width * scaleX,
      cropArea.height * scaleY,
      cropArea.x,
      cropArea.y,
      cropArea.width,
      cropArea.height
    );

    // Draw crop border
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);

    // Draw resize handles
    const handleSize = 8;
    ctx.fillStyle = '#3b82f6';
    
    // Corner handles
    ctx.fillRect(cropArea.x - handleSize/2, cropArea.y - handleSize/2, handleSize, handleSize);
    ctx.fillRect(cropArea.x + cropArea.width - handleSize/2, cropArea.y - handleSize/2, handleSize, handleSize);
    ctx.fillRect(cropArea.x - handleSize/2, cropArea.y + cropArea.height - handleSize/2, handleSize, handleSize);
    ctx.fillRect(cropArea.x + cropArea.width - handleSize/2, cropArea.y + cropArea.height - handleSize/2, handleSize, handleSize);
  }, [cropArea, imageLoaded]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // Handle mouse events for dragging and resizing
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const handleSize = 8;
    
    // Check if clicking on resize handle
    if (
      x >= cropArea.x + cropArea.width - handleSize/2 && x <= cropArea.x + cropArea.width + handleSize/2 &&
      y >= cropArea.y + cropArea.height - handleSize/2 && y <= cropArea.y + cropArea.height + handleSize/2
    ) {
      setIsResizing(true);
      setDragStart({ x, y });
    }
    // Check if clicking inside crop area for dragging
    else if (
      x >= cropArea.x && x <= cropArea.x + cropArea.width &&
      y >= cropArea.y && y <= cropArea.y + cropArea.height
    ) {
      setIsDragging(true);
      setDragStart({ x: x - cropArea.x, y: y - cropArea.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || (!isDragging && !isResizing)) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isResizing) {
      const newWidth = Math.max(50, x - cropArea.x);
      const newHeight = Math.max(50, y - cropArea.y);
      const size = Math.min(newWidth, newHeight); // Keep it square
      
      setCropArea(prev => ({
        ...prev,
        width: Math.min(size, canvas.width - prev.x),
        height: Math.min(size, canvas.height - prev.y),
      }));
    } else if (isDragging) {
      const newX = Math.max(0, Math.min(x - dragStart.x, canvas.width - cropArea.width));
      const newY = Math.max(0, Math.min(y - dragStart.y, canvas.height - cropArea.height));
      
      setCropArea(prev => ({
        ...prev,
        x: newX,
        y: newY,
      }));
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setIsResizing(false);
  };

  // Generate cropped image
  const handleCrop = async () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageLoaded) return;

    // Create a new canvas for the cropped image
    const cropCanvas = document.createElement('canvas');
    const cropCtx = cropCanvas.getContext('2d');
    if (!cropCtx) return;

    // Set crop canvas size (always square for avatar)
    const finalSize = 300; // Final avatar size
    cropCanvas.width = finalSize;
    cropCanvas.height = finalSize;

    // Calculate source coordinates on the original image
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    
    const sourceX = cropArea.x * scaleX;
    const sourceY = cropArea.y * scaleY;
    const sourceWidth = cropArea.width * scaleX;
    const sourceHeight = cropArea.height * scaleY;

    // Draw the cropped portion
    cropCtx.drawImage(
      img,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      finalSize,
      finalSize
    );

    // Convert to blob and then to file
    cropCanvas.toBlob((blob) => {
      if (blob) {
        // Generate a proper filename with crop suffix
        const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
        const ext = fileName.includes('.') ? fileName.split('.').pop() : 'png';
        const croppedFileName = `${nameWithoutExt}_cropped.${ext}`;
        
        const file = new File([blob], croppedFileName, { type: 'image/png' });
        onCropComplete(file);
        onClose();
      }
    }, 'image/png', 0.95);
  };

  const handleCancel = () => {
    setImageLoaded(false);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent className="max-w-2xl bg-gray-50 border-gray-300">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-gray-800">
            Crop Avatar
          </DialogTitle>
          <DialogDescription className="text-gray-600">
            Drag to move the selection area or resize to crop your avatar
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Canvas for cropping */}
          <div className="flex justify-center">
            <div className="relative border border-gray-300 rounded-lg overflow-hidden">
              <canvas
                ref={canvasRef}
                width={canvasSize.width}
                height={canvasSize.height}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                className="cursor-move"
                style={{ display: imageLoaded ? 'block' : 'none' }}
              />
              {!imageLoaded && (
                <div className="w-96 h-96 flex items-center justify-center bg-gray-100">
                  <span className="text-gray-500">Loading...</span>
                </div>
              )}
            </div>
          </div>

          {/* Hidden image element */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            style={{ display: 'none' }}
            onLoad={() => setImageLoaded(true)}
            alt="Source"
          />

          {/* Action buttons */}
          <div className="flex justify-end space-x-3 pt-4">
            <Button
              onClick={handleCancel}
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCrop}
              className="bg-blue-600 hover:bg-blue-700"
              disabled={!imageLoaded}
            >
              Crop Image
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AvatarCropper;

