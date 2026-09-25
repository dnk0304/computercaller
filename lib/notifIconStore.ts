/**
 * App-icon store for phone notifications (ALERT-ICONS, 2026-09-25).
 *
 * The phone attaches each app's launcher icon (base64 PNG, field `icon`) to a
 * PHONE_NOTIFICATION frame. This used to be a bare module-level Map, which had
 * two faults: nothing re-rendered when an icon arrived after the card or toast
 * that wanted it, and a reload emptied it, so every card flashed its fallback
 * until the same app notified again.
 *
 * Now it is a tiny external store:
 *   - React reads it through useSyncExternalStore (`useNotificationIcon`), so a
 *     card or toast re-renders the moment its icon lands.
 *   - It mirrors to localStorage under `cc_notif_icons_v1`, capped at 60 apps
 *     (least recently SET goes first) and skipping any single icon over 24 KB
 *     of base64, so the 96 px icons the phone lane is moving to cannot fill the
 *     origin's quota. Loaded once, lazily, on first read.
 *   - Sign-out clears both copies: the list of icons is a list of the apps the
 *     user has installed, and it is not the next account's business.
 *
 * Every storage access is wrapped. Storage can THROW in a partitioned or
 * blocked context; the in-memory copy keeps working either way, so the worst
 * case is the pre-persistence behaviour, never a broken alert.
 */

import { useSyncExternalStore } from 'react';

/** The one key. Do not write this string anywhere else. */
export const NOTIF_ICON_STORAGE_KEY = 'cc_notif_icons_v1';
/** Most apps kept. LRU by the time an icon was last received. */
export const NOTIF_ICON_MAX_ENTRIES = 60;
/** Largest single icon kept, in base64 characters (24 KB). */
export const NOTIF_ICON_MAX_BYTES = 24 * 1024;

type Listener = () => void;

// Map iteration order is insertion order, so "oldest first" is free: a set
// deletes and re-inserts, which moves the package to the newest end.
const icons = new Map<string, string>();
const listeners = new Set<Listener>();
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(NOTIF_ICON_STORAGE_KEY) ?? null;
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [pkg, b64] = entry as [unknown, unknown];
      if (typeof pkg !== 'string' || typeof b64 !== 'string') continue;
      if (!pkg || !b64 || b64.length > NOTIF_ICON_MAX_BYTES) continue;
      icons.delete(pkg);
      icons.set(pkg, b64);
    }
    while (icons.size > NOTIF_ICON_MAX_ENTRIES) evictOldest();
  } catch {
    /* Corrupt JSON: start empty rather than crash the Alerts tab. */
  }
}

function evictOldest(): void {
  const oldest = icons.keys().next();
  if (!oldest.done) icons.delete(oldest.value);
}

function persist(): void {
  try {
    storage()?.setItem(NOTIF_ICON_STORAGE_KEY, JSON.stringify([...icons]));
  } catch {
    /* Quota or blocked site data. The in-memory copy still serves this session. */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** Read an app icon (base64 PNG) by Android package name. Undefined if unknown. */
export function getNotificationIcon(packageName: string): string | undefined {
  load();
  return icons.get(packageName);
}

/**
 * Record the icon a PHONE_NOTIFICATION carried. Ignores empty input and icons
 * over the size cap (the previous icon for that app, if any, is kept).
 */
export function setNotificationIcon(packageName: string, iconB64: string): void {
  if (!packageName || !iconB64 || iconB64.length > NOTIF_ICON_MAX_BYTES) return;
  load();
  const current = icons.get(packageName);
  let newest: string | undefined;
  for (const k of icons.keys()) newest = k;
  // The common case: the same app notifies again with the same icon and is
  // already the most recent. Nothing changed, so no write and no re-render.
  if (current === iconB64 && newest === packageName) return;
  icons.delete(packageName);
  icons.set(packageName, iconB64);
  while (icons.size > NOTIF_ICON_MAX_ENTRIES) evictOldest();
  persist();
  if (current !== iconB64) emit();
}

/** Sign-out: forget every icon, in memory and on disk. Never throws. */
export function clearNotificationIcons(): void {
  loaded = true; // nothing on disk is worth loading after this
  const had = icons.size > 0;
  icons.clear();
  try {
    storage()?.removeItem(NOTIF_ICON_STORAGE_KEY);
  } catch {
    /* Blocked site data: nothing was persisted there to leak either. */
  }
  if (had) emit();
}

export function subscribeNotificationIcons(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverSnapshot = (): undefined => undefined;

/** The icon for one package, re-rendering when it arrives or is cleared. */
export function useNotificationIcon(packageName: string): string | undefined {
  return useSyncExternalStore(
    subscribeNotificationIcons,
    () => getNotificationIcon(packageName),
    serverSnapshot,
  );
}

/** Test seam: forget the in-memory copy so the next read reloads from storage. */
export function __resetNotificationIconsForTest(): void {
  icons.clear();
  listeners.clear();
  loaded = false;
}
