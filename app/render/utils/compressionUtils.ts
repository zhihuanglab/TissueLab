import { init, decompress } from '@bokuweb/zstd-wasm';

// Zstd decompression function using @bokuweb/zstd-wasm
// Initialize Zstd WASM module immediately when module is imported
const zstdInitPromise = (async () => {
  try {
    await init();
    return true;
  } catch (error) {
    console.error('Failed to initialize zstd-wasm:', error);
    throw error;
  }
})();

export const decompressZstd = async (compressedData: ArrayBuffer): Promise<Uint8Array> => {
  return new Promise(async (resolve, reject) => {
    try {
      // Wait for Zstd WASM module to be initialized (already started on module import)
      await zstdInitPromise;
      
      // Validate input data
      if (!compressedData || compressedData.byteLength === 0) {
        reject(new Error('Zstd decompression failed: Empty or invalid input data'));
        return;
      }
      
      const compressed = new Uint8Array(compressedData);
      
      // Decompress using Zstd
      const decompressed = decompress(compressed);
      
      if (!decompressed || decompressed.length === 0) {
        reject(new Error('Zstd decompression failed: Decompressed data is empty'));
        return;
      }
      
      resolve(decompressed);
    } catch (error: any) {
      // Provide more detailed error information
      const errorMessage = error?.message || String(error);
      const errorCode = error?.code || error?.errno || 'unknown';
      const dataSize = compressedData?.byteLength || 0;
      
      console.error('[Zstd] Decompression error details:', {
        error: errorMessage,
        code: errorCode,
        dataSize,
        dataPreview: dataSize > 0 && dataSize <= 32 
          ? Array.from(new Uint8Array(compressedData.slice(0, Math.min(32, dataSize))))
              .map(b => '0x' + b.toString(16).padStart(2, '0'))
              .join(' ')
          : 'too large to preview'
      });
      
      reject(new Error(`Zstd decompression failed: ${errorMessage} (code: ${errorCode}, data size: ${dataSize} bytes)`));
    }
  });
};

