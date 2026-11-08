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
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for browsers without crypto.randomUUID (e.g. plain-HTTP LAN access):
  // build an RFC 4122 v4 UUID by hand.
  const buffer = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buffer);
  } else {
    for (let i = 0; i < 16; i++) buffer[i] = Math.floor(Math.random() * 256);
  }
  buffer[6] = (buffer[6] & 0x0f) | 0x40; // version 4
  buffer[8] = (buffer[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

