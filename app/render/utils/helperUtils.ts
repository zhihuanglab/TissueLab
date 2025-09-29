import { DependencyList } from 'react';

export const generateUUID = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for browsers without crypto.randomUUID
  const buffer = new Uint8Array(16);
  crypto.getRandomValues(buffer);
  const fallbackUUID = Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${fallbackUUID.slice(0, 8)}-${fallbackUUID.slice(8, 12)}-4${fallbackUUID.slice(12, 15)}-${((buffer[8] & 0x3f) | 0x80).toString(16)}${fallbackUUID.slice(15, 18)}-${fallbackUUID.slice(18)}`;
};

export const buildUrlWithParams = (
  path: string,
  params: Record<string, string> = {}
) => {
  // parse parameters in original path
  const [basePath, pathQuery] = path.split('?');
  const pathParams = new URLSearchParams(pathQuery);
  const currentParams = new URLSearchParams(params);
  // create new URL parameters object
  const mergedParams = new URLSearchParams({
    ...Object.fromEntries(pathParams.entries()),
    ...Object.fromEntries(currentParams.entries()),
  });

  return `${basePath}?${mergedParams.toString()}`;
};

// get or create device id
export const getOrCreateDeviceId = () => {
  // Check if we're in a browser environment
  if (typeof window === 'undefined') {
    return generateUUID(); // Return a new UUID for server-side rendering
  }
  
  const deviceId = sessionStorage.getItem('tissuelab-device-id');
  if (!deviceId) {
    const newDeviceId = generateUUID();
    sessionStorage.setItem('tissuelab-device-id', newDeviceId);
    return newDeviceId;
  } else {
    return deviceId;
  }
};

export function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (Object.getPrototypeOf(value) === null) {
    return true;
  }

  let proto = value;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }

  return Object.getPrototypeOf(value) === proto;
}

export function depsAreSame(
  oldDeps: DependencyList,
  deps: DependencyList
): boolean {
  if (oldDeps === deps) return true;
  for (let i = 0; i < oldDeps.length; i++) {
    if (!Object.is(oldDeps[i], deps[i])) return false;
  }
  return true;
}

export function getFileBase64(file: File, size?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(size ? file.slice(0, size) : file);
    reader.onload = (event) => {
      const result = event.target?.result as string;
      resolve(size ? result?.slice(0, size) : result || '');
    };
    reader.onerror = (event) => {
      reject(event.target?.error);
    };
  });
}