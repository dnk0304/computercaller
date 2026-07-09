/**
 * Permission-ping (web side) — pure helpers for the PERMISSIONS_STATUS /
 * GET_PERMISSIONS_STATUS / REQUEST_PERMISSION protocol (locked names, v49
 * brief, 2026-07-09).
 *
 * Nullability contract: every key is `boolean | null` where `null` = UNKNOWN.
 * APKs ≤ v48 never send PERMISSIONS_STATUS, so the web must treat null as
 * "maybe missing, maybe just old APK" and render a softer hint — never a hard
 * "permission denied" claim.
 *
 * Kept out of usePhoneBridge.ts so the merge/command logic is unit-testable
 * with the repo's runner-less node test style (see tests/*.test.ts).
 */

export type PermissionKey = 'sms' | 'callLog' | 'contacts' | 'notifications';

export type PermissionsStatus = Record<PermissionKey, boolean | null>;

export const UNKNOWN_PERMISSIONS_STATUS: PermissionsStatus = {
  sms: null,
  callLog: null,
  contacts: null,
  notifications: null,
};

/** Human label used in hint copy: "Your phone hasn't granted [label] permission". */
export const PERMISSION_LABEL: Record<PermissionKey, string> = {
  sms: 'SMS',
  callLog: 'call log',
  contacts: 'contacts',
  notifications: 'notification access',
};

/**
 * Merge a PERMISSIONS_STATUS payload into previous state. Only keys present
 * as real booleans overwrite; anything else (missing key, wrong type, junk
 * payload) preserves the previous value. A partial frame must never reset a
 * known permission back to unknown.
 */
export function mergePermissionsStatus(
  prev: PermissionsStatus,
  payload: unknown
): PermissionsStatus {
  const p = (payload ?? {}) as Record<string, unknown>;
  const pick = (key: PermissionKey): boolean | null =>
    typeof p[key] === 'boolean' ? (p[key] as boolean) : prev[key];
  return {
    sms: pick('sms'),
    callLog: pick('callLog'),
    contacts: pick('contacts'),
    notifications: pick('notifications'),
  };
}

/**
 * The exact WS frame to send when the user taps "Fix on phone".
 *
 * notifications → the EXISTING `REQUEST_NOTIFICATION_ACCESS` command, which
 * every APK since the v40 lineage understands (opens the NotificationListener
 * settings screen). The generic `REQUEST_PERMISSION:{permission}` is the v49
 * protocol; older APKs hit their `else -> log` branch and safely no-op.
 */
export function fixPermissionFrame(permission: PermissionKey): string {
  if (permission === 'notifications') {
    return 'REQUEST_NOTIFICATION_ACCESS:{}';
  }
  return `REQUEST_PERMISSION:${JSON.stringify({ permission })}`;
}

/** Frame asking a v49+ phone to (re-)broadcast PERMISSIONS_STATUS. */
export const GET_PERMISSIONS_STATUS_FRAME = 'GET_PERMISSIONS_STATUS:{}';

/**
 * Post-"Fix on phone" refresh schedule (ms). Short backoff so the hint clears
 * soon after the user grants the permission on a v49 phone; harmless on older
 * APKs (they ignore GET_PERMISSIONS_STATUS).
 */
export const PERMISSION_REFRESH_BACKOFF_MS: readonly number[] = [5000, 15000, 30000];
