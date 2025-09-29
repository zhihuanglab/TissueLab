import axios from "axios";
import { getOrCreateDeviceId } from "./helperUtils";
import { AUTH_MISSING_ERROR, getAuthToken, notifyMissingAuth } from "./authToken";

const http = axios.create();

http.interceptors.request.use(async (config) => {
  try {
    const headers = { ...(config.headers || {}) } as Record<string, string>;
    const hasAuthHeader = Boolean(headers.Authorization);

    headers['X-Device-Id'] = getOrCreateDeviceId();

    if (!hasAuthHeader) {
      const token = await getAuthToken();
      if (!token) {
        notifyMissingAuth();
        return Promise.reject(new Error(AUTH_MISSING_ERROR));
      }
      headers.Authorization = `Bearer ${token}`;
    }

    config.headers = headers as any;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(AUTH_MISSING_ERROR);
    if (error.message === AUTH_MISSING_ERROR) {
      notifyMissingAuth();
    }
    return Promise.reject(error);
  }
  return config;
});

export default http;
