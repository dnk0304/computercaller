/**
 * Type declarations for lib/roomReset-core.js — the shared plain-JS "Reset
 * lobby" primitive consumed by server.js (WS frame path) and by
 * app/api/relay/reset/route.ts (HTTP path, via globalThis). Same .js + .d.ts
 * split as lib/entitlement-core — one runtime, zero drift.
 */

/** Close code sent to the PHONE socket. 1000 keeps the APK out of RelayPhase.FAILED. */
export const RESET_CLOSE_CODE_PHONE: 1000;
/** Close code sent to BROWSER + LISTENER sockets. Non-terminal, no backoff penalty. */
export const RESET_CLOSE_CODE_BROWSER: 4010;
export const RESET_CLOSE_REASON: 'room_reset';
export const RESET_RATE_LIMIT_MS: number;

export interface ResetRateLimiter {
  check(userId: string, now?: number): { allowed: boolean; retryAfterMs: number };
  sweep(now?: number): void;
  size(): number;
}

export function createResetRateLimiter(limitMs?: number): ResetRateLimiter;

export interface ResetRoomDeps {
  safeSend: (ws: unknown, msg: string) => boolean;
  closeSocket: (ws: unknown, code: number, reason: string) => void;
  rooms: Map<string, unknown>;
  log?: (msg: string) => void;
}

export interface ResetRoomResult {
  closed: number;
  phones: number;
  browsers: number;
  listeners: number;
}

export function resetRoom(
  room: unknown,
  deps: ResetRoomDeps,
  origin?: string,
): ResetRoomResult;

/**
 * Single-process handle server.js publishes so the Next.js Route Handler (same
 * Node process) can reset a room without a socket. Mirrors the documented
 * __supersedeWebSessions pattern. Returns null when the user has no live room.
 */
declare global {
  // eslint-disable-next-line no-var
  var __resetRelayRoom: ((userId: string) => Promise<ResetRoomResult | null>) | undefined;
}
