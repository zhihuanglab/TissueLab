import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Owns the "is this viewer bound to its slide on the backend?" state.
 *
 * This used to be four separate variables (`isZarrInitializing`, a
 * `pathReadyForDataRef` wire gate, `lastSentPathRef`, and a timeout handle)
 * written from four files and ~47 call sites. They encode one machine, and every
 * stuck-overlay bug so far came from two of them disagreeing — most often a
 * frame arriving while the gate said "closed" but the phase said "done".
 *
 *   idle ──bind()──► binding ──ack()──► rebuilding ──rebuilt()──► bound
 *                       │                                          ▲
 *                       └──── timeout / fail() ──► failed ─────────┘
 *
 * The wire gate is *derived* from the phase, never set on its own:
 *   - binding / rebuilding → closed: the backend handler is not serving this
 *     slide yet, so outbound requests are held and inbound frames dropped.
 *   - bound → open, the normal state.
 *   - failed → open on purpose: the bind gave up, and leaving the gate shut
 *     would silently discard any data that does still arrive.
 */
export type BindPhase = 'idle' | 'binding' | 'rebuilding' | 'bound' | 'failed';

export type PathBinding = {
  phase: BindPhase;
  /** True while a set_path is outstanding (drives "image is loading" UI). */
  isBinding: boolean;
  /** Wire gate for the overlay session / WS handler. Derived from `phase`. */
  gateRef: React.MutableRefObject<boolean>;
  /** Path of the most recent bind attempt (ack matching + send dedupe). */
  boundPathRef: React.MutableRefObject<string | null>;
  /** Read the gate without subscribing to renders (hot path). */
  isBound: () => boolean;
  /** set_path just went out for `path`. Arms the no-ack deadline. */
  bind: (path: string) => void;
  /** Backend acked. Gate stays shut until the overlay caches are rebuilt. */
  ack: () => void;
  /** Overlay caches rebuilt for the new handler — open the gate. */
  rebuilt: () => void;
  /** Bind failed / gave up. Opens the gate so late data is not lost. */
  fail: () => void;
  /** Slide changed: forget the binding and shut the gate. */
  release: () => void;
};

export function usePathBinding(opts: {
  timeoutMs: number;
  /** Deadline passed with no ack. Callers rebuild the overlay from scratch. */
  onTimeout?: (path: string | null) => void;
}): PathBinding {
  const { timeoutMs } = opts;
  const [phase, setPhase] = useState<BindPhase>('idle');
  const phaseRef = useRef<BindPhase>('idle');
  const gateRef = useRef(false);
  const boundPathRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(opts.onTimeout);
  onTimeoutRef.current = opts.onTimeout;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const enter = useCallback(
    (next: BindPhase) => {
      // Only `binding` waits on a deadline; every other phase is terminal for it.
      if (next !== 'binding') clearTimer();
      phaseRef.current = next;
      gateRef.current = next === 'bound' || next === 'failed';
      setPhase((prev) => (prev === next ? prev : next));
    },
    [clearTimer],
  );

  const bind = useCallback(
    (path: string) => {
      clearTimer();
      boundPathRef.current = path;
      enter('binding');
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (phaseRef.current !== 'binding') return;
        console.warn('[PathBinding] no set_path ack; giving up', { path });
        enter('failed');
        onTimeoutRef.current?.(path);
      }, timeoutMs);
    },
    [clearTimer, enter, timeoutMs],
  );

  const ack = useCallback(() => enter('rebuilding'), [enter]);
  const rebuilt = useCallback(() => enter('bound'), [enter]);
  const fail = useCallback(() => enter('failed'), [enter]);
  const release = useCallback(() => {
    boundPathRef.current = null;
    enter('idle');
  }, [enter]);

  const isBound = useCallback(() => gateRef.current, []);

  useEffect(() => clearTimer, [clearTimer]);

  return {
    phase,
    isBinding: phase === 'binding',
    gateRef,
    boundPathRef,
    isBound,
    bind,
    ack,
    rebuilt,
    fail,
    release,
  };
}
