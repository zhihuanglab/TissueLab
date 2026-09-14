import { toast } from 'sonner';

const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000;
let lastRateLimitToastAt = 0;

export const notifyRateLimitExceeded = (message?: string) => {
  const now = Date.now();
  if (now - lastRateLimitToastAt < RATE_LIMIT_TOAST_COOLDOWN_MS) return;
  lastRateLimitToastAt = now;
  toast.error(message?.trim() || 'Too many frequent requests, try again later');
};
