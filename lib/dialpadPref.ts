'use client';

/**
 * Is the 12-key pad open, on the Dial view?
 *
 * WHY (Dennis 2026-09-17 14:46, verbatim): "I would like to hide the numbers
 * pad in dial tab. I would like it to be reduced into a button thats next to
 * the message button thats next to the call button. If user clicks on it, it
 * then expands and the numbers for dialing appear, click again, hides it."
 *
 * The pad is roughly 180px of the Dial view. Collapsed, that space goes to
 * Recent — which is what the view is actually FOR most of the time, because a
 * redial is one tap and a fresh number is rare. So: DEFAULT COLLAPSED, and the
 * pad is one tap away for the rare case. The typed-number field stays visible
 * either way, so a keyboard user never loses the ability to dial.
 *
 * STORAGE — deliberately the same shape as lib/extensionTheme.ts:
 *   `cc:dialpad:<email>`  the account's own choice
 *   `cc:dialpad:last`     mirror of the most recent write
 * Per account because a shared browser profile is the normal case for this
 * product (it is a Chrome extension), and one person's preference should not
 * follow the next person into the same popup.
 *
 * `last` is the fallback, not a second source of truth. It is read in exactly
 * one situation: we do not know who is signed in yet. That happens on /app
 * phone mode, where the email arrives (if ever) after first paint, and in the
 * extension for the frame before the shell handshake lands. Guessing with the
 * previous choice beats snapping the pad open a frame after the user sees it
 * closed — and when NOTHING is stored anywhere, the answer is collapsed, per
 * the brief.
 *
 * Every read and write is wrapped: localStorage throws outright in a profile
 * with site data blocked, and a keypad preference is not worth a blank panel.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const LAST_KEY = 'cc:dialpad:last';

function keyFor(email: string | null | undefined) {
  return email ? `cc:dialpad:${email.toLowerCase()}` : 'cc:dialpad:anon';
}

function parse(v: string | null): boolean | null {
  if (v === 'open') return true;
  if (v === 'closed') return false;
  return null;
}

/**
 * The stored choice, or `false` (collapsed) when there is nothing to read.
 *
 * Never called on the server — the store below hands React a separate
 * `getServerSnapshot` for that, so this function only ever runs where
 * localStorage exists.
 */
export function readDialpadOpen(email: string | null | undefined): boolean {
  try {
    const own = parse(window.localStorage.getItem(keyFor(email)));
    if (own !== null) return own;
    // Only fall back to the shared mirror while the account is unknown. Once
    // we know who this is, "they have never chosen" means collapsed — not
    // whatever the last person on this machine picked.
    if (!email) {
      const last = parse(window.localStorage.getItem(LAST_KEY));
      if (last !== null) return last;
    }
    return false;
  } catch {
    return false;
  }
}

export function writeDialpadOpen(email: string | null | undefined, open: boolean) {
  const v = open ? 'open' : 'closed';
  try {
    window.localStorage.setItem(keyFor(email), v);
    window.localStorage.setItem(LAST_KEY, v);
  } catch {
    /* site data blocked — the choice still applies for this session */
  }
}

/* ------------------------------------------------------------------ hooks */

/**
 * The store behind {@link useDialpadOpen}.
 *
 * WHY A STORE AND NOT `useState(() => readDialpadOpen(email))`:
 * that is what PhoneModeHeader's ThemeChoice/SizeChoice do, it is what this
 * module shipped first, and ON A PRERENDERED PAGE IT DOES NOT WORK. /extension
 * is statically prerendered, so React hydrates rather than renders: the lazy
 * initialiser runs and returns `true`, and React then keeps the SERVER's
 * attributes anyway. A remembered-open pad came back collapsed on every load,
 * silently, in production only. (The theme picker gets away with the same
 * pattern for one reason: the theme is painted by a blocking boot script onto
 * <html>, not by React state, so React is never the thing that has to be
 * right.)
 *
 * `useSyncExternalStore` is the API for precisely this shape — an external
 * store (localStorage) with a separate SSR snapshot. The server snapshot is
 * the documented default, COLLAPSED; after hydration React reads the client
 * snapshot and re-renders if it disagrees. No mismatch, no silent loss.
 *
 * The snapshot is packed into a STRING rather than an object because
 * useSyncExternalStore compares snapshots by identity and a fresh object every
 * call is an infinite render loop. Two facts travel in it:
 *   `open|closed`  the pad's state
 *   `a|s`          animate, or settle silently
 * The second is what keeps a remembered-open pad from sliding itself open on
 * every single load. Motion answers a person's action; it does not narrate
 * page loads. Until the user touches the toggle, the pad just IS open.
 */
type Snapshot = `${'open' | 'closed'}|${'a' | 's'}`;

const listeners = new Set<() => void>();
let animate = false;

/**
 * Cached PER ACCOUNT KEY, not globally.
 *
 * useSyncExternalStore re-renders whenever getSnapshot returns something new,
 * so a snapshot that is not stable for unchanged inputs is an infinite loop.
 * One shared slot would be stable only while every mounted pad asked about the
 * same account — two pads on different accounts would take turns overwriting
 * it and each would see a change on every call. Nothing renders two pads on
 * two accounts today; a cache whose correctness depends on that staying true
 * is not worth the saving of one Map.
 */
const snapshots = new Map<string, Snapshot>();

function computeSnapshot(email: string | null | undefined): Snapshot {
  const key = keyFor(email);
  const next: Snapshot = `${readDialpadOpen(email) ? 'open' : 'closed'}|${animate ? 'a' : 's'}`;
  const cached = snapshots.get(key);
  if (cached === next) return cached;
  snapshots.set(key, next);
  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `[open, toggle, animate]` for the Dial view's pad, persisted per account.
 *
 * Every mounted pad shares the store, so the two Dial surfaces can never
 * disagree with each other or with what is on disk.
 */
export function useDialpadOpen(
  email: string | null | undefined,
): [boolean, () => void, boolean] {
  const packed = useSyncExternalStore(
    subscribe,
    useCallback(() => computeSnapshot(email), [email]),
    // The server has no storage, and COLLAPSED is the documented default.
    useCallback(() => 'closed|s' as Snapshot, []),
  );

  const toggle = useCallback(() => {
    const [state] = packed.split('|');
    animate = true;
    writeDialpadOpen(email, state !== 'open');
    for (const l of listeners) l();
  }, [email, packed]);

  const [state, motion] = packed.split('|');
  return [state === 'open', toggle, motion === 'a'];
}

/**
 * Honour `prefers-reduced-motion` in JS rather than CSS.
 *
 * The collapse runs off inline styles (see CollapsePanel in Dialpad.tsx) so
 * that ONE implementation serves both the extension and /app phone mode
 * without a rule duplicated into two stylesheets. Inline styles cannot carry a
 * media query, so the query is read here and the duration becomes 0ms.
 * Reduced motion means instant, not "no state change".
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return reduced;
}
