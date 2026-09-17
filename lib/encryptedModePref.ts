'use client';

import { useCallback, useSyncExternalStore } from 'react';

import {
  encryptedModeKey,
  readEncryptedMode,
  writeEncryptedMode,
  type LocalMode,
} from '@/hooks/phoneE2e';

/**
 * lib/encryptedModePref.ts — E2E-P5a (a). The shared subscription for the
 * Encrypted-mode setting.
 *
 * ── WHY THIS EXISTS WHEN P2 ALREADY SHIPPED read/write ──────────────────────
 * `hooks/phoneE2e.ts` already owns the storage KEY and the guarded read/write
 * (P2, §12.1 / §13.1: per-DEVICE, stored locally, keyed per account so a shared
 * browser profile does not leak one person's choice to the next). Those are
 * plain functions, and a plain function cannot tell a second component that the
 * value changed. Three places now render this one setting:
 *
 *   1. /app → Settings → Encrypted mode (the switch)
 *   2. the extension account menu (the same switch, other surface)
 *   3. the connection pill + header badge (reads it to explain itself)
 *
 * Without a subscription, turning the switch on in the menu leaves the pill
 * painting the old value until something unrelated re-renders — the exact class
 * of bug that makes a security setting untrustworthy, because the user cannot
 * tell whether the interface disagrees with itself or the setting did not take.
 *
 * So: no second source of truth, no second storage key. This file adds ONLY the
 * notification layer over P2's functions, following hooks/audioSourcePreference.ts
 * — the repo's established useSyncExternalStore convention, including its two
 * halves (`storage` for other tabs, a custom event for this one, because
 * `storage` does not fire in the window that wrote the value).
 *
 * ── THIS IS THE LOCAL SETTING, NOT THE EFFECTIVE MODE ───────────────────────
 * §13.1: the effective mode of a pair is the OR of both sides, latched at
 * Accept. That value is `e2e.mode` from the hook and it is the ONLY thing the
 * SAS and the badges may key on. This file is the user's own switch — what they
 * asked for, not what the pair negotiated. Rows 8-10 of the §13.2 matrix are
 * precisely the cases where the two differ, and conflating them is how a
 * mode-OFF computer would wrongly skip a SAS its peer asked for.
 */

/** Same-tab change notification. `storage` only fires in OTHER tabs. */
const CHANGE_EVENT = 'cc:e2e-mode-changed';

/**
 * Stable server snapshot. OFF is both the §12 default and the safe direction:
 * a hydration mismatch that guessed ON would show a user encryption they had
 * not asked for and do not have.
 */
function getServerSnapshot(): LocalMode {
  return 'off';
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    // A null key is a whole-storage clear (site data wiped) — the setting is
    // gone with it, so re-read rather than ignore.
    if (e.key === null || e.key.startsWith('cc:e2e:')) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/**
 * Read the setting for `email` and subscribe to changes.
 *
 * The setter writes through P2's guarded `writeEncryptedMode` (which swallows a
 * refused localStorage write — a blocked-site-data profile must not take the
 * settings screen down with it) and then notifies. Note the ordering
 * consequence, which is deliberate: if the write was refused, the notification
 * still fires, every subscriber re-reads, and they all see the OLD value. The
 * switch visibly springs back instead of showing ON over a setting that is not
 * stored. Failing visibly is the only honest option for a security control.
 */
export function useEncryptedModePref(
  email: string | null | undefined,
): [LocalMode, (next: LocalMode) => void] {
  const read = useCallback(() => readEncryptedMode(email), [email]);
  const mode = useSyncExternalStore(subscribe, read, getServerSnapshot);

  const setMode = useCallback(
    (next: LocalMode) => {
      writeEncryptedMode(email, next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [email],
  );

  return [mode, setMode];
}

export { encryptedModeKey };
export type { LocalMode };
