/**
 * WebGL Context Manager
 * 
 * Manages the creation and release of WebGL contexts to prevent context leaks
 */

interface WebGLContextInfo {
  canvas: HTMLCanvasElement;
  context: WebGLRenderingContext | WebGL2RenderingContext;
  contextType: 'webgl' | 'webgl2';
  created: number;
}

class WebGLContextManager {
  private contexts: Map<string, WebGLContextInfo> = new Map();
  private maxContexts = 16; // Most browsers limit to 16 WebGL contexts

  /**
   * Create a WebGL context
   */
  createContext(
    canvas: HTMLCanvasElement, 
    contextType: 'webgl' | 'webgl2' = 'webgl2',
    contextAttributes?: WebGLContextAttributes
  ): WebGLRenderingContext | WebGL2RenderingContext | null {
    const contextId = this.generateContextId(canvas);
    
    // If a context already exists, release it first
    if (this.contexts.has(contextId)) {
      this.releaseContext(contextId);
    }

    // Check context limit
    if (this.contexts.size >= this.maxContexts) {
      console.warn(`WebGL context limit reached (${this.maxContexts}). Releasing oldest context.`);
      this.releaseOldestContext();
    }

    // Create new context
    const context = canvas.getContext(contextType, contextAttributes) as WebGLRenderingContext | WebGL2RenderingContext;
    
    if (context) {
      this.contexts.set(contextId, {
        canvas,
        context,
        contextType,
        created: Date.now()
      });
      
      console.log(`WebGL context created: ${contextId} (${this.contexts.size}/${this.maxContexts})`);
    }

    return context;
  }

  /**
   * Release a specific WebGL context
   */
  releaseContext(contextId: string): boolean {
    const contextInfo = this.contexts.get(contextId);
    if (!contextInfo) {
      console.warn(`WebGL context not found for release: ${contextId}`);
      return false;
    }

    const { context } = contextInfo;
    
    // Force release WebGL context
    const loseContext = context.getExtension('WEBGL_lose_context');
    if (loseContext) {
      loseContext.loseContext();
      console.log(`WebGL context released: ${contextId} (${this.contexts.size - 1}/${this.maxContexts})`);
    } else {
      console.warn(`WEBGL_lose_context extension not available for context: ${contextId}`);
    }

    this.contexts.delete(contextId);
    return true;
  }

  /**
   * Release the oldest WebGL context
   */
  private releaseOldestContext(): void {
    let oldestId = '';
    let oldestTime = Date.now();

    this.contexts.forEach((info, id) => {
      if (info.created < oldestTime) {
        oldestTime = info.created;
        oldestId = id;
      }
    });

    if (oldestId) {
      this.releaseContext(oldestId);
    }
  }

  /**
   * Release all WebGL contexts
   */
  releaseAllContexts(): void {
    const contextIds = Array.from(this.contexts.keys());
    for (const id of contextIds) {
      this.releaseContext(id);
    }
    console.log('All WebGL contexts released');
  }

  /**
   * Generate context ID
   */
  private generateContextId(canvas: HTMLCanvasElement): string {
    // Use canvas's id or generate a unique ID
    return canvas.id || `webgl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the current context count
   */
  getContextCount(): number {
    return this.contexts.size;
  }

  /**
   * Get context information
   */
  getContextInfo(contextId: string): WebGLContextInfo | undefined {
    return this.contexts.get(contextId);
  }

  /**
   * Check if near context limit
   */
  isNearLimit(): boolean {
    return this.contexts.size >= this.maxContexts * 0.8;
  }
}

// Global instance
export const webglContextManager = new WebGLContextManager();

// Clean up all contexts when the page is unloaded
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    webglContextManager.releaseAllContexts();
  });
}

export default webglContextManager;

