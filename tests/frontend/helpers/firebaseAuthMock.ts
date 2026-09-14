/**
 * Network mock for Firebase Auth (Google Identity Toolkit + Secure Token).
 *
 * The renderer keeps the real Firebase SDK: on a web-mode page load
 * `UserInfoProvider` signs in anonymously exactly as the hosted app does.
 * Instead of letting that reach Google, `installFirebaseAuthMock(page)` answers
 * the Identity Toolkit REST calls the SDK makes — `accounts:signUp` (anonymous
 * user), `accounts:lookup` (user reload) and the Secure Token refresh — with a
 * fake anonymous user whose ID token is a syntactically valid JWT carrying a
 * far-future `exp`. Every other request to a Google host is aborted and
 * recorded so a test can assert that nothing left the mocked surface.
 *
 * Playwright's `page.route` intercepts `fetch` in Chromium and in Electron
 * windows alike, so the same helper serves both projects.
 */
import type { Page, Route } from '@playwright/test';

export const FAKE_FIREBASE_UID = 'e2e-anon-uid-0001';
export const FAKE_FIREBASE_PROJECT = 'tissuelab-e2e';

const b64url = (input: string): string =>
  Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A JWT the SDK will parse (header.payload.signature); the signature is not verified client-side. */
export function fakeIdToken(uid: string, opts: { anonymous?: boolean; email?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'e2e', typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${FAKE_FIREBASE_PROJECT}`,
    aud: FAKE_FIREBASE_PROJECT,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    // Far future so the SDK never decides the token is expiring and refreshes on its own.
    exp: now + 10 * 365 * 24 * 3600,
    ...(opts.email ? { email: opts.email, email_verified: true } : {}),
    firebase: {
      identities: opts.email ? { email: [opts.email] } : {},
      sign_in_provider: opts.anonymous === false ? 'google.com' : 'anonymous',
    },
    ...(opts.anonymous === false ? {} : { provider_id: 'anonymous' }),
  };
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${b64url('e2e-signature')}`;
}

export interface FirebaseAuthMock {
  /** Identity Toolkit / Secure Token calls that were answered, e.g. "accounts:signUp". */
  handled: string[];
  /** Requests to Google hosts that no handler covered (aborted). */
  unmocked: string[];
  uid: string;
  idToken: string;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

/**
 * Install the mock on a page. Call before the first navigation (the SDK signs
 * in during the app's first render). Returns a recorder for assertions.
 */
export async function installFirebaseAuthMock(page: Page, opts: { uid?: string } = {}): Promise<FirebaseAuthMock> {
  const uid = opts.uid || FAKE_FIREBASE_UID;
  const idToken = fakeIdToken(uid);
  const refreshToken = `e2e-refresh-${uid}`;
  const mock: FirebaseAuthMock = { handled: [], unmocked: [], uid, idToken };
  const nowMs = () => String(Date.now());

  const userRecord = () => ({
    localId: uid,
    emailVerified: false,
    providerUserInfo: [],
    validSince: String(Math.floor(Date.now() / 1000) - 60),
    lastLoginAt: nowMs(),
    createdAt: nowMs(),
    lastRefreshAt: new Date().toISOString(),
  });

  // Catch-all first (registered handlers are matched last-in-first-out, so the
  // specific routes below take precedence).
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|firebaseapp\.com|firebaseio\.com|google\.com)\//i, (route) => {
    mock.unmocked.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });

  // Google Identity Services script that `GoogleOAuthProvider` (One-Tap, unused)
  // injects at start-up: answer with an empty script so nothing is downloaded.
  await page.route('https://accounts.google.com/**', (route) => {
    mock.handled.push('gsi');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* e2e: Google Identity Services stub */' });
  });

  // Firebase UI assets (the sign-in modal's Google logo) — keep the page offline.
  await page.route('https://www.gstatic.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>',
    }),
  );

  await page.route('https://identitytoolkit.googleapis.com/**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    }
    const op = url.pathname.split('/').pop() || '';
    mock.handled.push(op);
    if (op === 'accounts:signUp') {
      return json(route, {
        kind: 'identitytoolkit#SignupNewUserResponse',
        idToken,
        refreshToken,
        expiresIn: '3600',
        localId: uid,
      });
    }
    if (op === 'accounts:lookup') {
      return json(route, { kind: 'identitytoolkit#GetAccountInfoResponse', users: [userRecord()] });
    }
    if (op === 'accounts:update') {
      return json(route, { kind: 'identitytoolkit#SetAccountInfoResponse', localId: uid, idToken, refreshToken, expiresIn: '3600' });
    }
    // Anything else (Google sign-in, custom tokens, …) is not part of the mocked surface.
    mock.unmocked.push(`${method} ${url.toString()}`);
    return json(route, { error: { code: 400, message: 'E2E_MOCK_UNSUPPORTED_OPERATION' } }, 400);
  });

  await page.route('https://securetoken.googleapis.com/**', (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': '*' },
      });
    }
    mock.handled.push('token');
    return json(route, {
      access_token: idToken,
      expires_in: '3600',
      token_type: 'Bearer',
      refresh_token: refreshToken,
      id_token: idToken,
      user_id: uid,
      project_id: FAKE_FIREBASE_PROJECT,
    });
  });

  return mock;
}
