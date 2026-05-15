"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { Image as ImageIcon } from 'lucide-react';
import { InlineSpinner } from '@/components/assets/PageLoading';
import { getPreviewAsync } from '@/services/file.service';
import { shortHashFromString } from '@/utils/string.utils';
import { ImagePreviewType } from '@/types/fileManagerTypes';

interface ImagePreviewCellProps {
  fileName: string;
  fullPath: string;
  imageType: ImagePreviewType;
}

const ImagePreviewCell: React.FC<ImagePreviewCellProps> = ({
  fileName,
  fullPath,
  imageType,
}) => {
  const [previewData, setPreviewData] = useState<{
    thumbnail: string | null;
    macro: string | null;
    label: string | null;
    filename: string;
    available: string[];
    source_file?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPreviewData = useCallback(async () => {
    if (previewData || isLoading || loadingRef.current) return;

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      console.log('Loading preview for:', fileName, 'at path:', fullPath);

      // Generate a unique request ID
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const pathHash = shortHashFromString(fullPath, 8);
      const requestId = `preview_${pathHash}_${timestamp}_${randomId}`;

      console.log('🚀 Using async Celery service for preview:', { fileName, fullPath, requestId });
      const data = await getPreviewAsync(fullPath, 'all', 200, requestId);
      console.log('✅ Async preview completed for:', fileName);

      console.log('Preview data for', fileName, ':', data);
      setPreviewData(data);

    } catch (err) {
      console.error('Error fetching slide preview for', fileName, ':', err);
      setError(err instanceof Error ? err.message : 'Failed to load preview');

      setPreviewData({
        thumbnail: null,
        macro: null,
        label: null,
        filename: fileName,
        available: [],
        source_file: fullPath
      });
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [fileName, fullPath, previewData, isLoading]);

  const [elementRef, setElementRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!elementRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !previewData && !isLoading && !loadingRef.current) {
            // add little delay to avoid too many requests
            const delay = Math.random() * 300 + 100; // 100-400ms random delay
            setTimeout(() => {
              if (!loadingRef.current && !previewData) {
                loadPreviewData();
              }
            }, delay);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '50px' // start loading 50px before the element comes into view
      }
    );

    observer.observe(elementRef);
    return () => observer.disconnect();
  }, [elementRef, loadPreviewData, previewData, isLoading]);

  useEffect(() => {
    setPreviewData(null);
    setError(null);
    loadingRef.current = false;
  }, [fullPath, imageType]); // Add imageType to dependencies to reset when type changes

  const getCurrentImage = () => {
    if (!previewData) return null;
    // Ensure we're getting the correct image type
    const imageData = previewData[imageType];

    // Additional validation to prevent cross-contamination
    if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
      return imageData;
    }

    return null;
  };

  if (isLoading) {
    return (
      <div
        ref={setElementRef}
        className="flex h-full w-full items-center justify-center rounded bg-muted"
      >
        <div className="flex flex-col items-center">
          <InlineSpinner size={24} color="#6352a3" />
          <div className="mt-1 px-1 text-center text-xs text-muted-foreground">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (error && !previewData) {
    return (
      <div
        ref={setElementRef}
        className="flex h-full w-full items-center justify-center rounded bg-destructive/10"
      >
        <div className="p-1 text-center">
          <div className="mb-1 text-xs text-destructive">Error</div>
          <button
            onClick={() => {
              setError(null);
              setPreviewData(null);
              loadingRef.current = false;
              loadPreviewData();
            }}
            className="text-xs text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const currentImage = getCurrentImage();

  return (
    <div
      ref={setElementRef}
      className="flex h-full w-full items-center justify-center p-1"
    >
      {currentImage ? (
        <div className="relative w-full h-full">
          <Image
            src={currentImage}
            alt={`${fileName} ${imageType}`}
            fill
            className="object-contain rounded"
            onError={(e) => {
              console.error('Image load error for:', fileName, imageType);
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded bg-muted">
          <div className="text-center">
            <ImageIcon className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">No {imageType}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImagePreviewCell;

