/**
 * lib/freeTierMode.ts — TS-facing entry point for the FREE_TIER flag.
 *
 * The implementation lives in lib/freeTierMode-core.js (plain CommonJS) so the relay
 * server (`node server.js`, not transpiled by Next) and the TS layer share ONE
 * runtime reader and can never drift — the same split as
 * lib/entitlement-core.js / lib/entitlement.ts and lib/tiers-core.js / lib/tiers.ts.
 *
 * See lib/freeTierMode-core.js for the full env semantics and the fail-safe
 * direction (an unrecognised value resolves to ON = today's behaviour).
 */

export { isFreeTierEnabled } from './freeTierMode-core';
