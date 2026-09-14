import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userReducer from '@/store/slices/userSlice';
import { envelope, installFetchMock } from '../helpers/fetchMock';

// ---- Firebase Auth double ------------------------------------------------
// A mutable current user behind `getAuth`, `onAuthStateChanged` that reports it
// (asynchronously, like the SDK) and an anonymous sign-in whose behaviour each
// test decides.
type FakeUser = { uid: string; isAnonymous: boolean; email: string | null; getIdToken: (force?: boolean) => Promise<string> };
const fake = vi.hoisted(() => ({
  currentUser: null as FakeUser | null,
  listeners: [] as Array<(user: FakeUser | null) => void>,
  signInAnonymously: vi.fn<() => Promise<{ user: FakeUser }>>(),
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({
    get currentUser() {
      return fake.currentUser;
    },
    authStateReady: async () => undefined,
    signOut: vi.fn(async () => undefined),
  }),
  onAuthStateChanged: (_auth: unknown, cb: (user: FakeUser | null) => void) => {
    fake.listeners.push(cb);
    queueMicrotask(() => cb(fake.currentUser));
    return () => {
      fake.listeners = fake.listeners.filter((l) => l !== cb);
    };
  },
  signInAnonymously: () => fake.signInAnonymously(),
  GoogleAuthProvider: class {},
  signInWithCredential: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), onSnapshot: vi.fn(() => () => undefined) }));
vi.mock('firebase/storage', () => ({ getStorage: vi.fn(), ref: vi.fn(), getDownloadURL: vi.fn() }));
vi.mock('@/config/firebase.config', () => ({ app: {} }));
vi.mock('@/config/firebaseFirestore', () => ({ getFirestoreDb: () => ({}) }));
vi.mock('@react-oauth/google', () => ({ useGoogleOneTapLogin: () => undefined }));
// The provider re-attaches to running batch jobs after sign-in; that is a
// separate service and must not hit the network here.
vi.mock('@/services/batchApi.service', () => ({
  restoreBatchRuntimesFromServer: vi.fn(async () => undefined),
  resetBatchClientState: vi.fn(async () => undefined),
}));

import { UserInfoProvider, useUserInfo } from '@/contexts/UserInfoProvider';

const anonymousUser = (uid: string, token: string): FakeUser => ({
  uid,
  isAnonymous: true,
  email: null,
  getIdToken: async () => token,
});

/** What the LOCAL service answers on /users/v1/me — always its fixed user. */
const LOCAL_PROFILE = {
  user_id: 'local',
  email: null,
  is_anonymous: false,
  registered_at: 1_700_000_000,
  preferred_name: 'Alan',
  custom_title: 'Pathologist',
  organization: 'TissueLab',
  avatar_url: null,
};

function Probe() {
  const { userIdentity, userInfo, isLoadingUser, authToken } = useUserInfo();
  return (
    <div>
      <span data-testid="identity">{userIdentity}</span>
      <span data-testid="loading">{String(isLoadingUser)}</span>
      <span data-testid="uid">{userInfo?.user_id ?? ''}</span>
      <span data-testid="name">{userInfo?.preferred_name ?? ''}</span>
      <span data-testid="token">{authToken ?? ''}</span>
    </div>
  );
}

function renderProvider() {
  const store = configureStore({ reducer: { user: userReducer } });
  const utils = render(
    <Provider store={store}>
      <UserInfoProvider>
        <Probe />
      </UserInfoProvider>
    </Provider>,
  );
  return { store, ...utils };
}

const localRoutes = () => [
  { method: 'POST', match: '/users/v1/init_me', reply: () => envelope({ success: true, user_id: 'local' }) },
  { method: 'POST', match: '/users/v1/me', reply: () => envelope(LOCAL_PROFILE) },
];

beforeEach(() => {
  fake.currentUser = null;
  fake.listeners = [];
  fake.signInAnonymously.mockReset();
  document.cookie = 'tissuelab_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete (window as any).electron;
});

describe('contexts/UserInfoProvider (Firebase session, local service)', () => {
  it('web mode: signs in anonymously through Firebase, then loads the local profile under the Firebase uid', async () => {
    fake.signInAnonymously.mockImplementation(async () => {
      const user = anonymousUser('anon-1', 'anon-token');
      fake.currentUser = user;
      fake.listeners.forEach((l) => l(user));
      return { user };
    });
    const { calls } = installFetchMock(localRoutes());
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('anon-1'));
    expect(fake.signInAnonymously).toHaveBeenCalledTimes(1);
    // Identity 2 = anonymous Firebase user, the normal state of the open edition.
    expect(screen.getByTestId('identity')).toHaveTextContent('2');
    expect(screen.getByTestId('name')).toHaveTextContent('Alan');
    expect(screen.getByTestId('token')).toHaveTextContent('anon-token');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    // init_me + me went to the local service with the Firebase token.
    const me = calls.find((c) => c.url.endsWith('/users/v1/me'));
    expect(me?.headers.get('authorization')).toBe('Bearer anon-token');
    expect(calls.find((c) => c.url.endsWith('/users/v1/init_me'))).toBeTruthy();
    expect(window.localStorage.getItem('last_user_id')).toBe('anon-1');
    // The last /users/v1/me payload is cached for the next mount (fast sidebar paint).
    expect(JSON.parse(window.localStorage.getItem('tl_cached_user_info') || '{}').user_id).toBe('anon-1');
  });

  it('Firebase unreachable: keeps working as the local user (placeholder token on the local request)', async () => {
    fake.signInAnonymously.mockRejectedValue(new Error('auth/network-request-failed'));
    const { calls } = installFetchMock(localRoutes());
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('local'));
    expect(screen.getByTestId('identity')).toHaveTextContent('2');
    expect(screen.getByTestId('name')).toHaveTextContent('Alan');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    const me = calls.find((c) => c.url.endsWith('/users/v1/me'));
    expect(me).toBeTruthy();
    expect(me!.headers.get('authorization')).toBe('Bearer local-default-token');
  });

  it('desktop (Electron): no anonymous sign-in, the local profile is loaded directly', async () => {
    (window as any).electron = { invoke: vi.fn() };
    installFetchMock(localRoutes());
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('local'));
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
    expect(screen.getByTestId('identity')).toHaveTextContent('2');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
  });

  it('a persisted anonymous Firebase user is picked up without a new sign-in', async () => {
    fake.currentUser = anonymousUser('anon-persisted', 'persisted-token');
    installFetchMock(localRoutes());
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('uid')).toHaveTextContent('anon-persisted'));
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
    expect(screen.getByTestId('token')).toHaveTextContent('persisted-token');
  });
});
