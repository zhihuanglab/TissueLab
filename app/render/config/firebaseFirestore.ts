'use client';

import { app } from './firebaseConfig';
import {
  Firestore,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentSingleTabManager,
} from 'firebase/firestore';

let db: Firestore | null = null;

/**
 * Returns a singleton Firestore for `app` with explicit local cache settings.
 * Avoids default multi-tab IndexedDB + listener churn issues that can trigger
 * FIRESTORE INTERNAL ASSERTION FAILED (e.g. b815 / ca9) under Next.js HMR or React Strict Mode.
 */
export function getFirestoreDb(): Firestore {
  if (db) return db;

  if (typeof window !== 'undefined') {
    try {
      const isDev = process.env.NODE_ENV === 'development';
      db = initializeFirestore(app, {
        localCache: isDev
          ? memoryLocalCache()
          : persistentLocalCache({
              tabManager: persistentSingleTabManager({}),
            }),
      });
      return db;
    } catch {
      // Firestore already started (HMR, or another module called getFirestore first)
    }
  }

  db = getFirestore(app);
  return db;
}
