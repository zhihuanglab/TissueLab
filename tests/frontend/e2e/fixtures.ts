import { test as base, expect } from '@playwright/test';

import { installFirebaseAuthMock, type FirebaseAuthMock } from '../helpers/firebaseAuthMock';

export { expect };

/** Addresses published by global-setup.ts. */
export function e2eEnv() {
  const baseURL = process.env.TL_E2E_BASE_URL;
  const apiURL = process.env.TL_E2E_API_URL;
  const communityURL = process.env.TL_E2E_COMMUNITY_URL;
  if (!baseURL || !apiURL || !communityURL) {
    throw new Error('TL_E2E_BASE_URL / TL_E2E_API_URL / TL_E2E_COMMUNITY_URL are not set — did global-setup run? (npm run test:e2e from app/render)');
  }
  return {
    baseURL,
    apiURL,
    /** The mock of the hosted TissueLab community (`mock-community-server.ts`). */
    communityURL,
    rendererOrigin: new URL(baseURL).origin,
    backendOrigin: new URL(apiURL).origin,
    communityOrigin: new URL(communityURL).origin,
    slideName: process.env.TL_E2E_SLIDE_NAME || null,
  };
}

/**
 * Cloud hosts the open edition must never talk to. The hosted TissueLab
 * servers are replaced by the mock community during the run; Firestore /
 * Storage are never contacted for an anonymous session.
 */
export const FORBIDDEN_URL_TOKENS = ['vlm.ai', 'tissuelab.org', ':5002', 'firestore.googleapis', 'firebasestorage.googleapis'];
/**
 * Google hosts the Firebase Auth SDK talks to while signing in anonymously
 * (plus the Identity Services script `GoogleOAuthProvider` injects). They are
 * answered by `installFirebaseAuthMock` (page.route) and never reach the
 * network — the `guards` fixture fails the test if one slips through.
 */
export const MOCKED_AUTH_HOSTS = ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'accounts.google.com', 'www.gstatic.com'];
/** Console errors that would indicate leftover cloud wiring. */
export const FORBIDDEN_CONSOLE_TOKENS = ['Firestore', '5002', 'ctrl.vlm.ai'];
/** Console errors that mean a React render/effect loop — always a bug, so every test fails on them. */
export const RENDER_LOOP_CONSOLE_TOKENS = ['Maximum update depth exceeded', 'Too many re-renders'];
export const renderLoopErrors = (consoleErrors: string[]): string[] =>
  consoleErrors.filter((m) => mentionsAny(m, RENDER_LOOP_CONSOLE_TOKENS).length > 0);

/**
 * Requests to cloud hosts that are tolerated (annotated instead of failing).
 * Empty: the open edition must not talk to any cloud host.
 */
export const KNOWN_CLOUD_LEAKS: string[] = [];

export const mentionsAny = (text: string, tokens: string[]): string[] => {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token.toLowerCase()));
};

export const isMockedAuthHost = (url: string): boolean => {
  try {
    return MOCKED_AUTH_HOSTS.includes(new URL(url).host);
  } catch {
    return false;
  }
};

export interface Guards {
  pageErrors: string[];
  consoleErrors: string[];
  requests: string[];
  /** The Firebase Auth network mock installed on this page (recorder). */
  firebase: FirebaseAuthMock;
  /** Console errors that mention one of FORBIDDEN_CONSOLE_TOKENS. */
  forbiddenConsoleErrors: () => string[];
  /** Requests whose URL contains one of FORBIDDEN_URL_TOKENS (including known leaks). */
  forbiddenRequests: () => string[];
  /** Forbidden requests that are not in KNOWN_CLOUD_LEAKS. */
  unexpectedForbiddenRequests: () => string[];
  /** Origins other than the renderer / backend / mock community / mocked auth hosts (and non-network schemes). */
  foreignOrigins: () => string[];
}

const LOCAL_SCHEMES = /^(about:|data:|blob:|chrome-error:|chrome-extension:)/i;

type Options = {
};

/**
 * Every test records page errors, console errors and outgoing requests, and
 * boots the page with the Firebase Auth mock so the app signs in anonymously
 * without network — exactly the production flow. The fixture fails the test
 * on teardown when the page contacted a forbidden cloud host, when a Google
 * request escaped the auth mock, and annotates any other unexpected origin.
 */
export const test = base.extend<Options & { guards: Guards }>({
  baseURL: async ({}, use) => {
    await use(e2eEnv().baseURL);
  },
  guards: [
    async ({ page }, use, testInfo) => {
      const { rendererOrigin, backendOrigin, communityOrigin } = e2eEnv();
      const firebase = await installFirebaseAuthMock(page);
      const guards: Guards = {
        pageErrors: [],
        consoleErrors: [],
        requests: [],
        firebase,
        forbiddenConsoleErrors: () => guards.consoleErrors.filter((m) => mentionsAny(m, FORBIDDEN_CONSOLE_TOKENS).length > 0),
        forbiddenRequests: () => guards.requests.filter((u) => mentionsAny(u, FORBIDDEN_URL_TOKENS).length > 0),
        unexpectedForbiddenRequests: () => guards.forbiddenRequests().filter((u) => !KNOWN_CLOUD_LEAKS.some((k) => u.startsWith(k))),
        foreignOrigins: () => {
          const origins = new Set<string>();
          for (const url of guards.requests) {
            if (LOCAL_SCHEMES.test(url) || isMockedAuthHost(url)) continue;
            let origin: string;
            try {
              origin = new URL(url).origin;
            } catch {
              origin = url;
            }
            if (origin !== rendererOrigin && origin !== backendOrigin && origin !== communityOrigin) origins.add(origin);
          }
          return [...origins];
        },
      };
      page.on('pageerror', (error) => guards.pageErrors.push(String(error?.stack || error)));
      page.on('console', (message) => {
        if (message.type() === 'error') guards.consoleErrors.push(message.text());
      });
      page.on('request', (request) => guards.requests.push(request.url()));

      await use(guards);

      const foreign = guards.foreignOrigins();
      if (foreign.length) {
        testInfo.annotations.push({ type: 'external-origins', description: foreign.join(', ') });
        console.warn(`[e2e] ${testInfo.title}: requests left the local stack -> ${foreign.join(', ')}`);
      }
      const known = guards.forbiddenRequests().filter((u) => KNOWN_CLOUD_LEAKS.some((k) => u.startsWith(k)));
      if (known.length) {
        testInfo.annotations.push({ type: 'known-cloud-leak', description: [...new Set(known)].join(', ') });
      }
      expect(
        guards.unexpectedForbiddenRequests(),
        'requests to cloud hosts (vlm.ai / tissuelab.org / :5002 / Firestore / Firebase Storage)',
      ).toEqual([]);
      expect(firebase.unmocked, 'Google requests that escaped the Firebase Auth mock').toEqual([]);
      expect(renderLoopErrors(guards.consoleErrors), 'React update-depth loop logged to the console').toEqual([]);
    },
    { auto: true },
  ],
});
