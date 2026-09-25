/**
 * Type declarations for lib/e2ePref-core.js — the per-account Encrypted-mode
 * setting, shared by server.js (plain JS) and the Route Handlers (via
 * lib/e2ePref.ts). Same .js + .d.ts split as roomReset-core / entitlement-core.
 */

export type E2ePrefValue = 'on' | 'off';
export type E2ePrefSource = 'web' | 'ext' | 'phone' | 'seed' | 'admin';

export const E2E_PREF_SOURCES: readonly E2ePrefSource[];
export const E2E_PREF_VALUES: readonly E2ePrefValue[];
export const E2E_PREF_LIMIT_PER_MIN: number;
export const E2E_PREF_LIMIT_PER_HOUR: number;

/** The DB columns resolveE2ePref reads. null = no row / never chose. */
export interface E2ePrefRow {
  e2ePref: boolean | null;
  e2ePrefRev: number;
  e2ePrefUpdatedAt: Date | string | null;
  e2ePrefUpdatedBy: string | null;
}

/** DESIGN §3. The E2E_PREF frame body and every HTTP `resolved` field. */
export interface ResolvedE2ePref {
  preference: E2ePrefValue;
  effective: E2ePrefValue;
  pausedByServer: boolean;
  rev: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface E2ePrefResetResult {
  closed: number;
  phones: number;
  browsers: number;
  listeners: number;
}

export type E2ePrefErrorCode =
  | 'invalid_value'
  | 'invalid_source'
  | 'relay_unavailable'
  | 'rate_limited'
  | 'not_found'
  | 'reset_failed'
  | 'push_failed';

export class E2ePrefError extends Error {
  code: E2ePrefErrorCode;
  retryAfterMs?: number;
  resolved?: ResolvedE2ePref;
  changed?: boolean;
  applied?: boolean;
  constructor(code: E2ePrefErrorCode, message?: string, extra?: Record<string, unknown>);
}

export interface E2ePrefLimiter {
  take(userId: string, now?: number): { allowed: boolean; retryAfterMs: number };
  sweep(now?: number): void;
  size(): number;
}

type Env = Record<string, string | undefined>;

export function isE2ePairingEnabled(): boolean;
export function isMasterSwitchPublished(): boolean;
export function isE2ePrefDefaultOn(env?: Env): boolean;
export function e2ePrefEnv(env?: Env): { masterEnabled: boolean; defaultOn: boolean };
export function resolveE2ePref(
  row: E2ePrefRow | null,
  opts: { masterEnabled: boolean; defaultOn: boolean },
): ResolvedE2ePref;
export function decideSet(
  row: E2ePrefRow | null,
  value: E2ePrefValue,
  opts: { defaultOn: boolean },
): { changed: boolean };
export function decideSeed(row: E2ePrefRow | null, value: string): { refused: boolean; applied: boolean };
export function createE2ePrefLimiter(perMin?: number, perHour?: number): E2ePrefLimiter;
export function sharedE2ePrefLimiter(): E2ePrefLimiter;
export function redactUserId(id: string): string;

export interface E2ePrefWriteOpts {
  env?: Env;
  log?: (msg: string) => void;
  limiter?: E2ePrefLimiter;
  hooks?: {
    __applyE2ePrefChange?: (userId: string) => Promise<E2ePrefResetResult | null> | E2ePrefResetResult | null;
    __pushE2ePref?: (userId: string) => Promise<number> | number;
  };
}

// db is typed loosely (as entitlement-core does): server.js passes its own
// PrismaClient, the TS layer passes lib/db's.
export function getE2ePref(db: unknown, userId: string, env?: Env): Promise<ResolvedE2ePref | null>;
export function setE2ePref(
  db: unknown,
  userId: string,
  value: E2ePrefValue,
  source: E2ePrefSource,
  opts?: E2ePrefWriteOpts,
): Promise<{ changed: boolean; resolved: ResolvedE2ePref; reset: E2ePrefResetResult | null }>;
export function seedE2ePref(
  db: unknown,
  userId: string,
  value: string,
  source: E2ePrefSource,
  opts?: E2ePrefWriteOpts,
): Promise<{ applied: boolean; resolved: ResolvedE2ePref }>;
export function e2ePrefFrame(resolved: ResolvedE2ePref): string;

/**
 * Single-process handles server.js publishes (same pattern as __resetRelayRoom).
 *   __pushE2ePref(userId)        -> E2E_PREF to every socket of the account; returns sockets sent to.
 *   __applyE2ePrefChange(userId) -> push, THEN doResetRoom(phoneToken,'e2e-pref'); null when no room.
 */
declare global {
  var __pushE2ePref: ((userId: string) => Promise<number>) | undefined;
  var __applyE2ePrefChange: ((userId: string) => Promise<E2ePrefResetResult | null>) | undefined;
  var __e2ePrefLimiter: E2ePrefLimiter | undefined;
  /** server.js's boot-time E2E_PAIRING_ENABLED, published read-only. */
  var __e2ePairingEnabled: boolean | undefined;
}
