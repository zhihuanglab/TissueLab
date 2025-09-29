'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';

interface ImageComparisonSliderProps {
  beforeImage: string;
  afterImage: string;
  width?: number;
  height?: number;
  beforePlaceholder?: 'blur' | 'empty';
  beforeBlurDataURL?: string;
  afterPlaceholder?: 'blur' | 'empty';
  afterBlurDataURL?: string;
  customClassName?: string;
  showTransparencyGrid?: boolean;
}

export default function ImageComparisonSlider({
  beforeImage,
  afterImage,
  width = 600,
  height = 400,
  beforePlaceholder,
  beforeBlurDataURL,
  afterPlaceholder,
  afterBlurDataURL,
  customClassName,
  showTransparencyGrid = true,
}: ImageComparisonSliderProps) {
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMove = (event: MouseEvent | TouchEvent) => {
    if (!isDragging || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const x = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const position = ((x - containerRect.left) / containerRect.width) * 100;

    setSliderPosition(Math.min(Math.max(position, 0), 100));
  };

  const handleMouseDown = () => {
    setIsDragging(true);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    document.addEventListener('mousemove', handleMove, { signal });
    document.addEventListener('mouseup', handleMouseUp, { signal });
    document.addEventListener('touchmove', handleMove, { signal });
    document.addEventListener('touchend', handleMouseUp, { signal });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  // Define transparent grid background style
  const transparencyGridStyle = {
    backgroundImage: `
      linear-gradient(45deg, #ccc 25%, transparent 25%), 
      linear-gradient(-45deg, #ccc 25%, transparent 25%), 
      linear-gradient(45deg, transparent 75%, #ccc 75%), 
      linear-gradient(-45deg, transparent 75%, #ccc 75%)
    `,
    backgroundSize: '16px 16px',
    backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
    backgroundColor: 'white',
  };

  return (
    <div
      ref={containerRef}
      className={`relative mx-auto w-full max-w-3xl overflow-hidden rounded-lg ${customClassName}`}
      style={{ aspectRatio: `${width}/${height}`, willChange: 'transform' }}
    >
      {/* Transparent grid background */}
      {showTransparencyGrid && (
        <div className='absolute inset-0' style={transparencyGridStyle} />
      )}

      {/* After Image (left) */}
      <div className='absolute inset-0' style={{ willChange: 'opacity' }}>
        <Image
          src={afterImage}
          alt='After'
          width={width}
          height={height}
          className='h-full w-full object-cover'
          placeholder={afterPlaceholder}
          blurDataURL={afterBlurDataURL}
          draggable={false}
        />
      </div>

      {/* Before Image with Clip Path (right)*/}
      <div
        className='absolute inset-0'
        style={{
          clipPath: `polygon(${sliderPosition}% 0, 100% 0, 100% 100%, ${sliderPosition}% 100%)`,
          willChange: 'clip-path',
        }}
      >
        <Image
          src={beforeImage}
          alt='Before'
          width={width}
          height={height}
          className='h-full w-full object-cover'
          placeholder={beforePlaceholder}
          blurDataURL={beforeBlurDataURL}
          draggable={false}
        />
      </div>

      {/* Slider */}
      <div
        className='absolute inset-y-0'
        style={{ left: `${sliderPosition}%` }}
      >
        <div className='absolute inset-y-0 -ml-px w-0.5 bg-white shadow-[0_0_10px_rgba(0,0,0,0.3)]' />
        <button
          className='absolute top-1/2 h-10 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-sm bg-white shadow-[0_0_10px_rgba(0,0,0,0.3)] active:cursor-grabbing'
          onMouseDown={handleMouseDown}
          onTouchStart={handleMouseDown}
          aria-label='Comparison slider'
        >
          <div className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'></div>
        </button>
      </div>
    </div>
  );
}