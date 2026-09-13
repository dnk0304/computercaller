/**
 * lib/freeTierMode-core.js — the single reversible switch for the no-card free tier.
 *
 * Shaped after lib/waitlistMode.ts (the house flag pattern: ONE module owns the
 * env read, the code default is the SAFE/original behaviour, and flipping the
 * deployment env var is the whole change). It is plain CommonJS for the same
 * reason lib/entitlement-core.js is: the relay (`node server.js`) is not
 * transpiled by Next and must `require()` it, while the TS layer consumes it
 * through lib/freeTierMode.ts + the sibling .d.ts. ONE implementation ⇒ the
 * browser gate and the relay gate can never disagree about whether the free
 * tier exists.
 *
 * ── ENV SEMANTICS (read at CALL time, not module load) ────────────────────
 *   FREE_TIER unset            → ON   (today's behaviour; the code default)
 *   FREE_TIER = on|true|1|yes  → ON
 *   FREE_TIER = off|false|0|no → OFF  (card-first: no subscription ⇒ denied)
 *   FREE_TIER = anything else  → ON   (see FAIL-SAFE below)
 *   (case-insensitive, trimmed)
 *
 * WHY CALL-TIME, NOT BUILD-TIME: this is a money gate with a live paying
 * customer behind it. Reading process.env on every evaluation means a Coolify
 * env edit takes effect on the next request — the documented 60-second
 * rollback — with no rebuild. Same discipline as ENTITLEMENT_ALLOWLIST in
 * lib/entitlement-core.js. (Contrast waitlistMode, which is NEXT_PUBLIC_* and
 * therefore build-inlined; that is a marketing-copy flag, not an access gate,
 * and it must match between server and client render to avoid hydration skew.)
 *
 * FAIL-SAFE DIRECTION: an unrecognised value resolves to ON, i.e. the CURRENT
 * behaviour. A fat-fingered env var must never mass-deny a population that is
 * allowed today — the failure mode of guessing "off" is locking real users out
 * of an app they can use right now, which is a trust event; the failure mode of
 * guessing "on" is that the flip simply did not take, which is visible and
 * costs nothing. Reversibility is guaranteed by construction: delete the env
 * var and the pre-2026-09-13 behaviour returns byte-for-byte.
 *
 * NOTE: this flag governs ONLY entitlement rule (3) — "a logged-in user with NO
 * subscription row". Every privileged admit (admin, ENTITLEMENT_ALLOWLIST,
 * free-access grant) and every subscription state (active / trialing /
 * expired) is evaluated STRICTLY BEFORE it and is completely untouched. No
 * paying customer, trialist, comped row, or Play-reviewer account can reach the
 * branch this flag controls.
 */

'use strict';

const TRUTHY = ['true', '1', 'on', 'yes'];
const FALSY = ['false', '0', 'off', 'no'];

/**
 * Is the no-card free tier currently enabled?
 * @returns {boolean} true = free tier ON (default); false only for an explicit off-value.
 */
function isFreeTierEnabled() {
  const raw = (process.env.FREE_TIER ?? '').trim().toLowerCase();
  if (raw === '') return true; // unset → ON (code default = today's behaviour)
  if (FALSY.includes(raw)) return false;
  if (TRUTHY.includes(raw)) return true;
  return true; // unrecognised → ON (fail-safe; see header)
}

module.exports = { isFreeTierEnabled };
