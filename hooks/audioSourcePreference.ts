'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Single source of truth for the user's DEFAULT call-audio destination.
 *
 * Three surfaces read and write this value and must never disagree:
 *   1. the header PC-audio control (components/PcAudioRoute.tsx, mounted in AppShell)
 *   2. the Settings → Call Audio picker (app/app/page.tsx)
 *   3. the in-call override toggle (AudioSourceToggle in components/Dashboard.tsx)
 *
 * None of them keeps its own copy — they all subscribe here via
 * `useAudioSourceDefault()`, which is backed by localStorage and kept in sync
 * across tabs (the `storage` event) and within a tab (a custom event, because
 * `storage` does not fire in the window that wrote the value).
 */

export type AudioSource = 'phone' | 'pc';

export const AUDIO_SOURCE_KEY = 'dnkdialer_audio_source_default';

/** Retired key. Was written by the (previously dead) Settings card and read by
 *  nobody. Migrated into AUDIO_SOURCE_KEY once, then deleted — see
 *  `migrateLegacyKeys`. No code path reads it any more. */
const LEGACY_CALL_MODE_KEY = 'dnkdialer_call_mode';

export const AUDIO_SOURCE_DEFAULT: AudioSource = 'phone';

export const AUDIO_SOURCE_LABEL: Record<AudioSource, string> = {
  phone: 'Phone',
  pc: 'PC',
};

/** Same-tab change notification. `storage` only fires in OTHER tabs. */
const CHANGE_EVENT = 'dnkdialer:audio-source-changed';

function isAudioSource(v: unknown): v is AudioSource {
  return v === 'phone' || v === 'pc';
}

/**
 * One-time migration of `dnkdialer_call_mode` into the shared key.
 *
 * Idempotent and self-healing: after the first run the legacy key is gone, so
 * every later call short-circuits on the first `getItem`. The new key wins on
 * conflict — it is the one the live in-call toggle has been writing all along,
 * so it reflects a real user choice, while the legacy key only ever recorded a
 * click on a card that did nothing.
 */
function migrateLegacyKeys(): void {
  if (typeof window === 'undefined') return;
  try {
    const legacy = window.localStorage.getItem(LEGACY_CALL_MODE_KEY);
    if (legacy === null) return;
    if (isAudioSource(legacy) && window.localStorage.getItem(AUDIO_SOURCE_KEY) === null) {
      window.localStorage.setItem(AUDIO_SOURCE_KEY, legacy);
    }
    window.localStorage.removeItem(LEGACY_CALL_MODE_KEY);
  } catch {
    // localStorage throws in private-browsing / sandboxed iframes.
  }
}

export function readAudioSourceDefault(): AudioSource {
  if (typeof window === 'undefined') return AUDIO_SOURCE_DEFAULT;
  migrateLegacyKeys();
  try {
    const v = window.localStorage.getItem(AUDIO_SOURCE_KEY);
    if (isAudioSource(v)) return v;
    // Pre-FORGE-2 3-mode shape ('earpiece' | 'speaker' | 'bluetooth').
    // Accepted on read so multi-tab sessions stay sane during the migration
    // window; the next write persists the 2-mode shape.
    if (v === 'earpiece' || v === 'speaker') return 'phone';
    if (v === 'bluetooth') return 'pc';
  } catch {
    // Same rationale as above.
  }
  return AUDIO_SOURCE_DEFAULT;
}

export function writeAudioSourceDefault(v: AudioSource): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUDIO_SOURCE_KEY, v);
  } catch {
    // Silent — the in-memory value still updates, the choice just won't survive
    // a reload. Failing loudly here would block a route change on a storage
    // quirk the user cannot act on.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === AUDIO_SOURCE_KEY || e.key === LEGACY_CALL_MODE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Stable server snapshot — avoids a hydration mismatch; React re-reads the
 *  real client value immediately after hydration. */
function getServerSnapshot(): AudioSource {
  return AUDIO_SOURCE_DEFAULT;
}

/**
 * Subscribe to the shared default audio destination.
 *
 * Returns the current value and a setter that persists it and notifies every
 * other subscriber in this tab and in other tabs. The setter does NOT talk to
 * the phone — forwarding SET_AUDIO_SOURCE stays with the caller that owns the
 * bridge, so a Settings-page write never fires a command from a route that
 * has no active call.
 */
export function useAudioSourceDefault(): [AudioSource, (next: AudioSource) => void] {
  const value = useSyncExternalStore(subscribe, readAudioSourceDefault, getServerSnapshot);
  const set = useCallback((next: AudioSource) => writeAudioSourceDefault(next), []);
  return [value, set];
}
