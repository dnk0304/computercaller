'use client';

/**
 * "Sync range" — the user's 7 / 30 / 90 day pick, persisted per account.
 *
 * STORAGE MIRRORS lib/extensionTheme.ts / lib/extensionTextSize.ts EXACTLY, and
 * for the same reasons those two spell out: a per-account key so two accounts
 * in one browser profile do not inherit each other's window, a `:last` key so a
 * surface can read a sane value before the session resolves, and EVERY read and
 * write wrapped because localStorage throws outright — not returns null — in a
 * profile with site data blocked. See extensionTheme.ts for the full argument;
 * this file deliberately does not restate it.
 *
 * UNLIKE theme and size this preference is NOT painted, so there is no boot
 * script: nothing on screen depends on it before React mounts. It is read at
 * the moment an auto-sync fires and when the Settings control renders.
 *
 * Changing the setting deliberately does NOT refetch (dispatch FORGE-U): a user
 * scrubbing through three options would fire three full syncs at the phone.
 * "Sync now", right beside it, is the explicit re-pull.
 */

import {
  DEFAULT_SYNC_RANGE_DAYS,
  isSyncRangeDays,
  type SyncRangeDays,
} from '@/lib/autoSync';

const LAST_KEY = 'cc:syncrange:last';

function keyFor(email: string | null | undefined) {
  return email ? `cc:syncrange:${email.toLowerCase()}` : 'cc:syncrange:anon';
}

function parse(raw: string | null): SyncRangeDays {
  const n = raw == null ? NaN : Number(raw);
  return isSyncRangeDays(n) ? n : DEFAULT_SYNC_RANGE_DAYS;
}

/** The account's stored window, or 30. Never throws. */
export function readSyncRangeDays(email: string | null | undefined): SyncRangeDays {
  try {
    return parse(window.localStorage.getItem(keyFor(email)));
  } catch {
    return DEFAULT_SYNC_RANGE_DAYS;
  }
}

/**
 * The best guess available with no account in hand — used by usePhoneBridge,
 * which fires an auto-sync from a WebSocket frame and has no session prop. Reads
 * the account key when an email is known, else the `:last` key written by
 * whichever account last chose.
 */
export function readSyncRangeDaysLastKnown(
  email?: string | null
): SyncRangeDays {
  try {
    const own = window.localStorage.getItem(keyFor(email));
    if (own != null) return parse(own);
    return parse(window.localStorage.getItem(LAST_KEY));
  } catch {
    return DEFAULT_SYNC_RANGE_DAYS;
  }
}

export function writeSyncRangeDays(
  email: string | null | undefined,
  days: SyncRangeDays
) {
  try {
    window.localStorage.setItem(keyFor(email), String(days));
    window.localStorage.setItem(LAST_KEY, String(days));
  } catch {
    /* site data blocked — the choice still applies for this session */
  }
}
