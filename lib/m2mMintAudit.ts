/**
 * lib/m2mMintAudit.ts — audit trail + anomaly trip-wire + per-IP rate limit for
 * the SERVER-TO-SERVER relay-ticket mint (POST /api/auth/relay-ticket/m2m).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (CC-CHANGE-1b, 2026-08-03)
 * ─────────────────────────────────────────────────────────────────────────
 * The M2M mint is a token-minting path authenticated by a single shared key
 * (CC_M2M_MINT_KEY). The Security pass on CC-CHANGE-1 (0a19975) found no code
 * bug — the entitlement gate is un-bypassable — but flagged two CONTAINMENT
 * gaps for a hypothetically-LEAKED key:
 *
 *   M2M-1  every mint attempt must be AUDITABLE (who/when/from-where/outcome)
 *          and a leaked-key abuse pattern must be DETECTABLE (a trip-wire).
 *   M2M-3  the endpoint needs a per-IP RATE LIMIT (DoS / enumeration backstop),
 *          evaluated BEFORE any DB work — mirrors the app's existing in-memory
 *          token bucket (app/api/waitlist/route.ts).
 *
 * DESIGN NOTES
 *   • DB-FREE on purpose. Writing every attempt (incl. unauthorized/rate-limited
 *     ones) to a table would hand an attacker a DoS amplifier and a way to grow
 *     our DB with junk. The app's audit surface for this class of event is a
 *     structured, tagged console line (same convention as every other route:
 *     `[Tag] ...`). `[M2M-AUDIT]` / `[M2M-ALERT]` are grep/alert targets.
 *   • Single-process deploy (custom server.js) → module-level Maps/arrays are
 *     the correct, simplest store, exactly like the waitlist limiter.
 *   • NEVER logs the key or the minted token — only ccUserId + outcome + IP.
 *
 * REVERSIBILITY: additive helper. Clean revert = delete this file and the three
 * call-sites in the route. No schema, no env, no other route touched.
 */

import { getClientIp } from '@/lib/ip';

/** Terminal outcome of an M2M mint attempt (the audited disposition). */
export type M2MOutcome =
  | 'minted' // key OK + entitled → 200, a real 30 s relay ticket was issued
  | 'denied_entitlement' // key OK but ccUserId not entitled → 403
  | 'insufficient_scope' // partner key OK but lacks the 'call' scope → 403
  | 'unauthorized' // missing/invalid/revoked key, or key not configured → 401
  | 'bad_request' // missing/non-string ccUserId or invalid JSON → 400
  | 'rate_limited'; // per-IP or per-partner throttle tripped → 429 (logged)

// ── Rate limit (M2M-3) — mirrors app/api/waitlist token bucket ──────────────
// Sliding window, per-IP. RL_MAX is generous for a trusted backend that may
// mint for many reps from one egress IP, but still caps a brute/enumeration
// flood. Brute-force is already infeasible (>=32-byte key); this is hygiene +
// a DoS/enumeration backstop.
const RL_WINDOW_MS = 60_000; // 1 minute
const RL_MAX = 60; // 60 attempts / IP / minute (~1/s sustained)
const rlHits = new Map<string, number[]>();

// ── Per-partner rate limit (SDK-PKG-2 P1) ───────────────────────────────────
// When a PARTNER key is used, the sliding window is keyed on partnerId instead
// of IP, so one partner's egress-IP sharing (many reps, one NAT) does not starve
// another partner, and each partner's abuse is contained to its own bucket. The
// per-partner limit is configurable per key (PartnerApiKey.rateLimitPerMin);
// legacy shared-key callers keep using the per-IP bucket above.
//
// SAME single-process, in-memory design as the per-IP limiter (custom server.js
// is single-process). MULTI-INSTANCE CAVEAT: if CC is ever scaled to >1 process,
// both limiters become per-process and the effective limit multiplies by the
// instance count — a shared store (Redis) is the eventual fix. Flagged for
// Security. Not a regression: the legacy path already had this exact property.
const partnerRlHits = new Map<string, number[]>();

/**
 * Per-partner sliding-window rate limit. Returns true when the partner has
 * EXCEEDED `limitPerMin` in the last minute. Records the hit as a side effect.
 * `nowMs` is injectable for deterministic tests.
 */
export function m2mPartnerRateLimited(
  partnerId: string,
  limitPerMin: number,
  nowMs: number = Date.now(),
): boolean {
  const cutoff = nowMs - RL_WINDOW_MS;
  const hits = (partnerRlHits.get(partnerId) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  partnerRlHits.set(partnerId, hits);
  if (partnerRlHits.size > 5_000) {
    for (const [k, v] of partnerRlHits) {
      if (v.every((t) => t <= cutoff)) partnerRlHits.delete(k);
    }
  }
  return hits.length > limitPerMin;
}

// ── Anomaly trip-wire (M2M-1) ───────────────────────────────────────────────
// A leaked key sprayed from one IP, or across many reps, should raise a WARN
// BEFORE it hits the hard 429 wall. Thresholds sit below RL_MAX so a ramp-up is
// visible in logs while a normal cadence stays silent. Successful mints only —
// each mint is a real relay ticket, which is what actually matters if abused.
const ALERT_WINDOW_MS = 60_000; // 1 minute
const ALERT_IP_MINT_THRESHOLD = 30; // > this many mints/min from ONE IP → alert
const ALERT_DISTINCT_USER_THRESHOLD = 40; // > this many distinct ccUserIds/min (any IP) → alert
const ALERT_COOLDOWN_MS = 60_000; // emit at most one alert per window (anti-log-spam)

type MintEvent = { ts: number; ip: string; ccUserId: string };
let mintEvents: MintEvent[] = [];
let lastAlertTs = 0;

/**
 * Resolve the trusted-hop client IP for the request. Falls back to a constant
 * so a missing header degrades to a shared bucket rather than throwing — the
 * same posture as the waitlist limiter.
 */
export function m2mSourceIp(req: { headers: Headers }): string {
  return getClientIp(req) ?? 'unknown';
}

/**
 * Per-IP sliding-window rate limit. Returns true when the caller has EXCEEDED
 * the window (→ the route should 429). Records the hit as a side effect.
 * `nowMs` is injectable so tests can simulate a burst deterministically.
 */
export function m2mRateLimited(ip: string, nowMs: number = Date.now()): boolean {
  const cutoff = nowMs - RL_WINDOW_MS;
  const hits = (rlHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(nowMs);
  rlHits.set(ip, hits);
  // Opportunistic cleanup so the Map can't grow unbounded over process life.
  if (rlHits.size > 5_000) {
    for (const [k, v] of rlHits) {
      if (v.every((t) => t <= cutoff)) rlHits.delete(k);
    }
  }
  return hits.length > RL_MAX;
}

/**
 * Record an M2M mint attempt: emit the structured audit line and, on a
 * successful mint, evaluate the anomaly trip-wire. NEVER receives (and so can
 * never log) the key or the minted token.
 *
 * @param sourceIp  trusted-hop client IP (from m2mSourceIp)
 * @param ccUserId  the target rep's CC user id, or null when unknown (401/400)
 * @param outcome   the audited disposition
 * @param nowMs     injectable clock for deterministic tests
 * @param partnerId the authenticated partner's id when a PARTNER key was used;
 *                  null/undefined for the legacy shared-key path. Recorded in
 *                  the audit line so per-partner abuse is attributable. NEVER the
 *                  key or secret — only the opaque partner id.
 */
export function auditM2MMint(
  sourceIp: string,
  ccUserId: string | null,
  outcome: M2MOutcome,
  nowMs: number = Date.now(),
  partnerId: string | null = null,
): void {
  // Structured, greppable, alert-taggable. No key, no token — ever.
  console.info(
    '[M2M-AUDIT]',
    JSON.stringify({ ts: new Date(nowMs).toISOString(), sourceIp, partnerId, ccUserId, outcome }),
  );

  if (outcome !== 'minted' || !ccUserId) return;

  // ── Trip-wire evaluation (successful mints only) ──────────────────────────
  const cutoff = nowMs - ALERT_WINDOW_MS;
  mintEvents.push({ ts: nowMs, ip: sourceIp, ccUserId });
  mintEvents = mintEvents.filter((e) => e.ts > cutoff);

  const ipMints = mintEvents.filter((e) => e.ip === sourceIp).length;
  const distinctUsers = new Set(mintEvents.map((e) => e.ccUserId)).size;

  const ipBurst = ipMints > ALERT_IP_MINT_THRESHOLD;
  const userSpray = distinctUsers > ALERT_DISTINCT_USER_THRESHOLD;
  if (!ipBurst && !userSpray) return;

  // Cooldown so a sustained burst doesn't flood the log every request.
  if (nowMs - lastAlertTs < ALERT_COOLDOWN_MS) return;
  lastAlertTs = nowMs;

  const reason = ipBurst && userSpray ? 'ip_burst+user_spray' : ipBurst ? 'ip_burst' : 'user_spray';
  console.warn(
    '[M2M-ALERT]',
    JSON.stringify({
      ts: new Date(nowMs).toISOString(),
      reason,
      sourceIp,
      mintsFromIpInWindow: ipMints,
      distinctUsersInWindow: distinctUsers,
      windowMs: ALERT_WINDOW_MS,
    }),
  );
}

/** Test-only: reset all module-level counters so tests don't leak state. */
export function __resetM2MMintAuditState(): void {
  rlHits.clear();
  partnerRlHits.clear();
  mintEvents = [];
  lastAlertTs = 0;
}

/** Exposed for tests/ops visibility — the tuned thresholds. */
export const M2M_LIMITS = {
  RL_WINDOW_MS,
  RL_MAX,
  ALERT_WINDOW_MS,
  ALERT_IP_MINT_THRESHOLD,
  ALERT_DISTINCT_USER_THRESHOLD,
} as const;
