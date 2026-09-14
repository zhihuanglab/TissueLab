import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Unit tests never touch the network. Every test that needs `fetch` installs
// its own mock (see helpers/fetchMock.ts); anything else hitting it is a bug.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`Unexpected network call in unit test: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* jsdom storage may be unavailable */
  }
});
