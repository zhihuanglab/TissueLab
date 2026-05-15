"use client";

import { FileText, Monitor, Mouse, Search } from "lucide-react";


interface ViewerStatusBarProps {
  mousePos: { x: number; y: number };
  imageBounds: { x1: number; y1: number; x2: number; y2: number };
  imageRotation: number;
  magnification: number;
  currentWSIFileInfo: { fileName?: string } | null;
  loadingAnnotations: boolean;
  loadingMask?: boolean;
  allTilesLoaded: boolean;
}

export default function ViewerStatusBar({
  mousePos,
  imageBounds,
  imageRotation,
  magnification,
  currentWSIFileInfo,
  loadingAnnotations,
  loadingMask = false,
  allTilesLoaded,
}: ViewerStatusBarProps) {
  return (
    <div style={{
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: '22px',
      background: 'hsl(var(--card))',
      color: 'hsl(var(--card-foreground))',
      fontSize: '11px',
      fontFamily: 'Segoe UI, sans-serif',
      zIndex: 10,
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      borderTop: '1px solid hsl(var(--border))',
      boxShadow: '0 -1px 3px rgba(0,0,0,0.1)'
    }}>
      {/* Mouse coordinates section */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        height: '100%',
        borderRight: '1px solid hsl(var(--border))',
        marginRight: '6px',
        minWidth: '120px',
        whiteSpace: 'nowrap',
        flexShrink: 0
      }}>
        <span style={{ marginRight: '6px', opacity: 0.9, flexShrink: 0 }}><Mouse size={14} /></span>
        <span style={{ 
          fontWeight: '500',
          whiteSpace: 'nowrap'
        }}>
          <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '40px' }}>
            {Math.round(mousePos.x)}
          </span>
          ,{' '}
          <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '40px' }}>
            {Math.round(mousePos.y)}
          </span>
        </span>
      </div>

      {/* View bounds section */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        height: '100%',
        borderRight: '1px solid hsl(var(--border))',
        marginRight: '6px',
        gap: '6px',
        minWidth: '220px',
        whiteSpace: 'nowrap',
        flexShrink: 0
      }}>
        <span style={{ opacity: 0.9, marginRight: '6px', flexShrink: 0 }}><Monitor size={14} /></span>
        <span style={{ 
          fontWeight: '500',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: '180px'
        }}>
          (<span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
            {Math.round(imageBounds.x1)}
          </span>, <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
            {Math.round(imageBounds.y1)}
          </span>) - (<span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
            {Math.round(imageBounds.x2)}
          </span>, <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
            {Math.round(imageBounds.y2)}
          </span>) 
          rotation=<span style={{ display: 'inline-block', textAlign: 'left', minWidth: '16px' }}>{Math.round(imageRotation) % 360}°</span>
        </span>
      </div>

      {/* Zoom section */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        height: '100%',
        minWidth: '60px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        borderRight: currentWSIFileInfo?.fileName ? '1px solid hsl(var(--border))' : 'none',
        marginRight: currentWSIFileInfo?.fileName ? '6px' : '0'
      }}>
        <span style={{ marginRight: '6px', opacity: 0.9, flexShrink: 0 }}><Search size={14} /></span>
        <span style={{ 
          fontWeight: '500', 
          display: 'inline-block', 
          textAlign: 'right', 
          minWidth: '30px',
          whiteSpace: 'nowrap'
        }}>
          {magnification.toFixed(2)}x
        </span>
      </div>

      {/* File name section */}
      {currentWSIFileInfo?.fileName && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          height: '100%',
          maxWidth: '200px'
        }}>
          <span style={{ marginRight: '6px', opacity: 0.9 }}><FileText size={14} /></span>
          <span style={{ 
            fontWeight: '500',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {currentWSIFileInfo.fileName}
          </span>
        </div>
      )}

      {/* Spacer to push content to the left */}
      <div style={{ flex: 1 }}></div>

      {/* Loading indicators section */}
      {/* Priority: tiles > annotations > mask */}
      {!allTilesLoaded && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          height: '100%',
          background: 'hsl(var(--card))',
          borderLeft: '1px solid hsl(var(--border))',
          gap: '6px',
          whiteSpace: 'nowrap',
          minWidth: 'fit-content',
          zIndex: 50,
          boxShadow: '-2px 0 4px rgba(0,0,0,0.2)'
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            border: '1px solid hsl(var(--border))',
            borderTop: '1px solid hsl(var(--card-foreground))',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            flexShrink: 0
          }}></div>
          <span style={{ 
            fontSize: '11px', 
            opacity: 0.9,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '100px'
          }}>Loading tiles...</span>
        </div>
      )}

      {(loadingAnnotations && allTilesLoaded && !loadingMask) && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          height: '100%',
          background: 'hsl(var(--card))',
          borderLeft: '1px solid hsl(var(--border))',
          gap: '6px',
          whiteSpace: 'nowrap',
          minWidth: 'fit-content',
          zIndex: 50,
          boxShadow: '-2px 0 4px rgba(0,0,0,0.2)'
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            border: '1px solid hsl(var(--border))',
            borderTop: '1px solid hsl(var(--card-foreground))',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            flexShrink: 0
          }}></div>
          <span style={{ 
            fontSize: '11px', 
            opacity: 0.9,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '120px'
          }}>Loading Annotations...</span>
        </div>
      )}

      {(loadingMask && allTilesLoaded) && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          height: '100%',
          background: 'hsl(var(--card))',
          borderLeft: '1px solid hsl(var(--border))',
          gap: '6px',
          whiteSpace: 'nowrap',
          minWidth: 'fit-content',
          zIndex: 50,
          boxShadow: '-2px 0 4px rgba(0,0,0,0.2)'
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            border: '1px solid hsl(var(--border))',
            borderTop: '1px solid hsl(var(--card-foreground))',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            flexShrink: 0
          }}></div>
          <span style={{ 
            fontSize: '11px', 
            opacity: 0.9,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '120px'
          }}>Loading mask...</span>
        </div>
      )}
    </div>
  );
}

