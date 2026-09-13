/**
 * Type declarations for lib/freeTierMode-core.js (the shared plain-JS flag reader
 * consumed by both server.js/entitlement-core.js and the TS layer). Same
 * .js + .d.ts split as lib/entitlement-core — one runtime, zero drift.
 */

/**
 * Is the no-card free tier currently enabled? Reads `process.env.FREE_TIER` at
 * CALL time so a Coolify env edit takes effect on the next request (no rebuild).
 *
 *   unset / on / true / 1 / yes  → true  (today's behaviour; the code default)
 *   off / false / 0 / no         → false (card-first)
 *   anything unrecognised        → true  (fail-safe: never mass-deny on a typo)
 */
export function isFreeTierEnabled(): boolean;
