/**
 * WebGL Preserve Drawing Buffer Hook 
 * 
 * (Used in screenshot functionality to ensure Annotorious's WebGL contexts are preserved)
 * 
 * This utility ensures that all WebGL contexts are created with preserveDrawingBuffer: true
 * to enable proper screenshot functionality.
 */

// Store original getContext method (only in browser environment)
let originalGetContext: any = null;

// Override getContext to automatically set preserveDrawingBuffer: true for WebGL contexts
// Only do this in browser environment
if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  originalGetContext = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function(
    contextType: string,
    contextAttributes?: WebGLContextAttributes
  ): any {
    // If it's a WebGL context and preserveDrawingBuffer is not explicitly set
    if ((contextType === 'webgl' || contextType === 'webgl2') && contextAttributes) {
      // Ensure preserveDrawingBuffer is set to true
      contextAttributes.preserveDrawingBuffer = true;
      // console.log(`WebGL context created with preserveDrawingBuffer: true for ${contextType}`);
    } else if ((contextType === 'webgl' || contextType === 'webgl2') && !contextAttributes) {
      // If no contextAttributes provided, create with preserveDrawingBuffer: true
      contextAttributes = { preserveDrawingBuffer: true };
      //console.log(`WebGL context created with default preserveDrawingBuffer: true for ${contextType}`);
    }
    
    // Call the original getContext method
    return originalGetContext.call(this, contextType, contextAttributes);
  };
}