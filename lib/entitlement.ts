/**
 * lib/entitlement.ts — the TS-facing entry point for the entitlement decision.
 *
 * The actual rules now live in lib/entitlement-core.js (plain CommonJS) so the
 * relay server (server.js, run by plain `node`, not transpiled by Next) and the
 * whole TS layer share ONE runtime implementation and can never drift. Before
 * this split, server.js had NO entitlement check on the raw-phoneToken relay
 * doors — a logged-in-but-unentitled user could open the WS and drive the phone
 * for free indefinitely (broken-access-control revenue leak, closed 2026-07-27).
 *
 * This module simply re-exports the shared core (typed via entitlement-core.d.ts)
 * so every existing `@/lib/entitlement` import site keeps working unchanged.
 *
 * See lib/entitlement-core.js for the rule order and the NO-LOCKOUT /
 * FAIL-CLOSED guarantees.
 */

export type {
  EntitlementState,
  EntitlementResult,
  EntitlementSubscriptionInput,
  EntitlementInput,
} from './entitlement-core';

// Tier types are re-exported here too so existing `@/lib/entitlement` import
// sites can pull the tier shape without a second import path.
export type { Tier, TierLimits } from './tiers-core';

export {
  evaluateEntitlement,
  evaluateUserEntitlement,
  isEntitlementAllowed,
  isAdminUser,
  isFreeAccessEmail,
  isEntitlementIndeterminate,
} from './entitlement-core';
