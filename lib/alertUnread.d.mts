/**
 * lib/alertUnread.d.mts — TypeScript sidecar for alertUnread.mjs. Named
 * `.d.mts` because TypeScript resolves `./alertUnread.mjs` types here.
 */

/** One alert (entry) or one read receipt (mark): key, content hash, time. */
export interface AlertRecord {
  k: string;
  h: string;
  t: number;
}

export interface AlertLike {
  notificationKey?: string;
  id?: string;
  packageName?: string;
  title?: string;
  body?: string;
  timestamp?: number;
}

export declare const ALERT_COMPOSITE_WINDOW_MS: number;
export declare const READ_MARK_CAP: number;
export declare const UNREAD_SET_CAP: number;
export declare function alertSig(n: AlertLike): string;
export declare function hashSig(str: string): string;
export declare function alertEntryOf(n: AlertLike): AlertRecord;
export declare function cleanRecord(x: unknown): AlertRecord | null;
export declare function cleanRecords(list: unknown, cap?: number): AlertRecord[];
export declare function sameCard(a: AlertRecord, b: AlertRecord): boolean;
export declare function markCovers(m: AlertRecord, e: AlertRecord): boolean;
export declare function isMarkedRead(e: AlertRecord, marks: readonly AlertRecord[]): boolean;
export declare function addMarks(marks: readonly AlertRecord[], add: readonly AlertRecord[], cap?: number): AlertRecord[];
export declare function foldAlert(
  entries: readonly AlertRecord[],
  e: AlertRecord,
  backfill: boolean,
  marks: readonly AlertRecord[],
): AlertRecord[];
export declare function dropAlertKey(entries: readonly AlertRecord[], key: string): AlertRecord[];
