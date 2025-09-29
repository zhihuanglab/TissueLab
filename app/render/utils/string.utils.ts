// Utility helpers for safe string handling in the browser

// Create a safe base64 encoder for arbitrary Unicode strings.
// This converts the string to UTF-8 bytes before base64-encoding.
export const toBase64Safe = (input: string): string => {
  try {
    // Prefer Node/SSR Buffer if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Buf: any = (globalThis as any).Buffer;
    if (Buf?.from) {
      return Buf.from(input, 'utf-8').toString('base64');
    }

    // Browser path: UTF-8 → base64 via shared encoder
    const bytes = new TextEncoder().encode(input);
    return base64EncodeBytes(bytes);
  } catch (error) {
    // As a last resort, return a short random string to avoid crashing callers
    return Math.random().toString(36).slice(2);
  }
};

// Encode raw bytes (Uint8Array) to base64 without using btoa
export const bytesToBase64 = (bytes: Uint8Array): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Buf: any = (globalThis as any).Buffer;
    if (Buf?.from) {
      return Buf.from(bytes).toString('base64');
    }
    return base64EncodeBytes(bytes);
  } catch {
    return '';
  }
};

// Internal shared base64 encoder for bytes (browser path)
const base64EncodeBytes = (bytes: Uint8Array): string => {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;

  while (i + 2 < bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += table[(n >> 18) & 63]
        +  table[(n >> 12) & 63]
        +  table[(n >> 6)  & 63]
        +  table[n & 63];
    i += 3;
  }

  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += table[(n >> 18) & 63]
        +  table[(n >> 12) & 63]
        +  '=='
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += table[(n >> 18) & 63]
        +  table[(n >> 12) & 63]
        +  table[(n >> 6)  & 63]
        +  '='
  }
  return out;
};

// Generate a short alphanumeric hash string from any input string
export const shortHashFromString = (input: string, length: number = 8): string => {
  const base64 = toBase64Safe(input);
  const cleaned = base64.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length >= length) return cleaned.slice(0, length);
  // Pad with random chars if too short
  return (cleaned + Math.random().toString(36).replace(/[^a-zA-Z0-9]/g, "")).slice(0, length);
};

// Sanitize a filename for safe storage on server (preserve extension)
export const sanitizeFilename = (originalName: string): string => {
  if (!originalName) return `file_${Date.now()}`;

  // Normalize Unicode (NFKC to reduce compatibility issues)
  let name = originalName.normalize("NFKC");

  // Split extension (handles names beginning with a dot carefully)
  const lastDot = name.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot !== name.length - 1;
  const base = hasExt ? name.slice(0, lastDot) : name;
  const ext = hasExt ? name.slice(lastDot) : "";

  // Replace all whitespace including NBSP-like characters with underscores
  const whitespaceRegex = /[\s\u00A0\u202F\u2007\u2060\uFEFF]+/g;
  let safeBase = base.replace(whitespaceRegex, "_");

  // Remove/replace characters that commonly cause issues across OS/filesystems
  // Includes: path separators, quotes, control chars, and other reserved/specials
  safeBase = safeBase
    .replace(/[\x00-\x1F\x7F]/g, "") // control chars
    .replace(/[\\\/\:*?"<>|]/g, "_")
    .replace(/[\'`]/g, "_")
    .replace(/[\[\]\{\}\#\%\^~\+\=\,;!@]/g, "_")
    .replace(/\.+/g, ".") // collapse multiple dots in base name
    .replace(/_+/g, "_") // collapse multiple underscores
    .replace(/^_+|_+$/g, ""); // trim leading/trailing underscores

  // Ensure we have a non-empty base name
  if (!safeBase) safeBase = "file";

  // Limit total filename length reasonably (including extension)
  const maxLen = 200;
  let finalName = safeBase + ext;
  if (finalName.length > maxLen) {
    const allowedBaseLen = Math.max(1, maxLen - ext.length);
    finalName = safeBase.slice(0, allowedBaseLen) + ext;
  }

  return finalName;
};


