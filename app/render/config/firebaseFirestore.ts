'use client';

import { app } from './firebase.config';
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
        // Default Firestore behavior is to throw on any `undefined` value
        // anywhere in the payload — including deeply nested optional fields
        // in objects we hand off (e.g. cohort.criteria, cohort.schema.*).
        // That made cohort cards vanish across refreshes: the in-memory
        // state still rendered them but `setDoc` rejected the whole write
        // and the caller only logged to console. Treat undefined as "skip
        // this field" so partially-populated docs land cleanly.
        ignoreUndefinedProperties: true,
      });
      return db;
    } catch {
      // Firestore already started (HMR, or another module called getFirestore first)
    }
  }

  db = getFirestore(app);
  return db;
}
