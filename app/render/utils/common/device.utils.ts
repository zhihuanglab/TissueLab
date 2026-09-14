// Device ID management utilities

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

