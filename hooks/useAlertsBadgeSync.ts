'use client';

/**
 * useAlertsBadgeSync — keep the extension's toolbar badge equal to the dotted
 * cards (item 8, Dennis 2026-09-26).
 *
 * While a surface is open the PAGE is the authority on which alerts are
 * unread: it holds the list, the dedup (lib/notificationMerge.ts) and the
 * user's opens and dismissals (persisted per account, lib/alertReadStore.ts).
 * So it reports the unread SET and its read marks to the worker, which makes
 * the badge the size of that set and applies the marks to anything that
 * arrives after the panel closes. One definition, one number (trap 3).
 *
 * Two guards:
 *   - an EMPTY list in the first seconds after the phone connects means "the
 *     shade has not been replayed yet", not "nothing is unread". Reporting it
 *     would blank the badge and then relight it. The report waits out the
 *     grace instead (and still goes out if the list really stays empty).
 *   - no account id, no report: the marks are per account and the worker
 *     stores them under ITS account id; an anonymous report would wipe them.
 */

import { useEffect, useRef } from 'react';
import type { PhoneNotification } from '@/hooks/usePhoneBridge';
import { unreadAlertEntries } from '@/lib/notificationMerge';
import { loadReadMarks } from '@/lib/alertReadStore';
import { reportAlertsState } from '@/lib/extensionBridge';

/** Coalesces the 200 ms notification flushes of one sync burst into one report. */
const REPORT_DEBOUNCE_MS = 300;
/** How long an empty list right after connecting is treated as "not synced yet". */
const SYNC_GRACE_MS = 4_000;

export interface UseAlertsBadgeSyncOptions {
  /** True only on surface="extension"; /app has no extension to report to. */
  enabled: boolean;
  notifications: readonly PhoneNotification[];
  userId: string | null;
  /** Phone paired and live. */
  connected: boolean;
}

export function useAlertsBadgeSync({ enabled, notifications, userId, connected }: UseAlertsBadgeSyncOptions): void {
  const connectedAtRef = useRef(0);
  const lastSentRef = useRef('');

  useEffect(() => {
    connectedAtRef.current = connected ? Date.now() : 0;
  }, [connected]);

  useEffect(() => {
    if (!enabled || !userId) return;
    // Not connected and nothing on screen: the page knows nothing the worker
    // does not, so it must not overwrite the worker's set with an empty one.
    if (!connected && notifications.length === 0) return;
    const unread = unreadAlertEntries(notifications);
    let delay = REPORT_DEBOUNCE_MS;
    if (unread.length === 0 && connected) {
      const sinceConnect = Date.now() - connectedAtRef.current;
      if (sinceConnect < SYNC_GRACE_MS) delay = Math.max(delay, SYNC_GRACE_MS - sinceConnect);
    }
    const id = window.setTimeout(() => {
      const state = { unread, read: loadReadMarks(userId) };
      const sig = JSON.stringify(state);
      if (sig === lastSentRef.current) return;
      lastSentRef.current = sig;
      reportAlertsState(state);
    }, delay);
    return () => window.clearTimeout(id);
  }, [enabled, notifications, userId, connected]);
}
