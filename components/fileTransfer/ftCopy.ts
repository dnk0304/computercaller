/**
 * FT-3b — the copy table the WEB and EXTENSION surfaces render.
 *
 * ── M10: FAILURE COPY IS A TRANSPORT OUTCOME, NOT AN ACCOUNT STATEMENT ──────
 * Security A1.1-M10, ruled binding by Ken (R-AN). The eight RELAY-OWNED reasons
 * arrive stamped `relay:true` and are abort-only: they say a transfer stopped
 * and why the relay stopped it. They do NOT carry authority to state a fact
 * about the user's account or their file.
 *
 * "Daily limit reached (2 GB)" asserts a quota fact as though the client had
 * audited it. "Send files is included with a subscription" asserts an
 * entitlement fact. Both read as findings; neither is something a FILE_FAILED
 * frame is entitled to declare. So every relay-owned reason is reframed as what
 * actually happened — "The transfer was stopped: <cause>." — which is true
 * regardless of what the account turns out to hold.
 *
 * This is why the table below OVERRIDES lib for those eight and DEFERS to lib
 * for the three PEER-owned reasons (hash_mismatch, cancelled, oom). Those are
 * authored by the peer about the transfer itself, are already phrased as
 * outcomes, and M10 leaves them alone.
 *
 * Note this deliberately inverts the precedence set in (b2), which made lib win
 * for every reason it knew. That was right when the only difference was two
 * missing enum members; it is wrong now that this lane owns a copy RULING lib
 * does not implement. Stated rather than quietly reversed.
 *
 * ── WHAT IS *NOT* FAILURE COPY, AND THEREFORE UNCHANGED ─────────────────────
 * M10 governs failure copy only. The PRE-FLIGHT strings are statements the
 * client makes on its own behalf before any frame is spent, and they stay
 * exactly as they were:
 *   - the locked control's tier sentence (FT_TIER_LOCK_COPY), which is an offer,
 *   - the picker hint "Files up to 1 GB", which is a constraint,
 *   - the remaining-today meter.
 * The tappable Upgrade lives on the LOCKED CONTROL and nowhere else. It is
 * explicitly NOT in the failure banner: `tier` below carries no action, so a
 * refusal cannot become a sales prompt.
 *
 * ── THE IMPORT IS RELATIVE ──────────────────────────────────────────────────
 * scripts/ft-ui-proof.mjs imports this module directly under plain `node` to
 * assert the copy table without a browser, and node resolves neither tsconfig
 * paths nor `@/`. Every verbatim user-facing string in this feature therefore
 * lives in THIS file, so the proof reads the product's own constants and can
 * never drift from them.
 */

import { failureCopy } from '../../lib/fileTransfer/reasons.ts';
import type { FailureCopy } from '../../lib/fileTransfer/reasons.ts';

/** The full wire enum (WIRE-TRUTH-v1). */
export const FT_WIRE_REASONS = [
  'hash_mismatch',
  'connection_lost',
  'relay_backpressure',
  'cancelled',
  'timeout',
  'too_large',
  'oom',
  'quota',
  'tier',
  'size_mismatch',
  'busy',
] as const;

export type FtWireReason = (typeof FT_WIRE_REASONS)[number];

/**
 * The eight reasons the relay is allowed to author. They arrive stamped
 * `relay:true` and are abort-only; the receiver never mints them.
 */
export const FT_RELAY_OWNED_REASONS: readonly FtWireReason[] = [
  'tier', 'quota', 'too_large', 'size_mismatch',
  'busy', 'relay_backpressure', 'timeout', 'connection_lost',
];

export function isRelayOwnedReason(reason: string): reason is FtWireReason {
  return (FT_RELAY_OWNED_REASONS as readonly string[]).includes(reason);
}

/** The M10 frame. One sentence shape for every relay-owned outcome. */
const STOPPED = 'The transfer was stopped:';

/**
 * M10 copy for the eight relay-owned reasons.
 *
 * Actions are assigned by whether retrying could plausibly succeed, not by how
 * the message feels. `relay_backpressure`, `timeout` and `connection_lost` are
 * transient, so they offer a retry. `size_mismatch` offers one because the
 * named fix IS to send it again. `busy` does not: the remedy is to wait, and a
 * retry button that will refuse again is a trap. `quota`, `tier` and
 * `too_large` do not, because nothing the user can do in this banner changes
 * the outcome — and for `tier` specifically, an Upgrade here is the steering
 * surface M10 and the Play ruling both keep off failure copy.
 */
const RELAY_OWNED_COPY: Record<string, FailureCopy> = {
  quota: {
    message: `${STOPPED} the daily transfer limit (2 GB) was reached. It resets at midnight UTC.`,
  },
  tier: {
    message: `${STOPPED} sending files is included with a subscription.`,
  },
  too_large: {
    message: `${STOPPED} files must be 1 GB or smaller.`,
  },
  size_mismatch: {
    message: `${STOPPED} the file changed size while sending.`,
    action: 'retry',
  },
  busy: {
    message: `${STOPPED} another transfer is already running.`,
  },
  relay_backpressure: {
    message: `${STOPPED} the connection could not keep up.`,
    action: 'retry',
  },
  timeout: {
    message: `${STOPPED} the other side did not respond in time.`,
    action: 'retry',
  },
  connection_lost: {
    message: `${STOPPED} the connection was lost.`,
    action: 'retry',
  },
};

/**
 * Render copy for any reason off the wire. Relay-owned reasons take the M10
 * table; peer-owned reasons defer to lib; anything unrecognised falls back to
 * lib's generic line rather than showing the user a raw enum token.
 */
export function ftFailureCopy(reason: string): FailureCopy {
  const m10 = RELAY_OWNED_COPY[reason];
  if (m10) return m10;
  return failureCopy(reason);
}

/* ===========================================================================
   Verbatim PRE-FLIGHT strings. Not failure copy — see the header. Single source
   of truth for the components AND the proof harness.
   =========================================================================== */

/**
 * The trial lock on the CONTROL, where the tappable Upgrade belongs. WEB +
 * EXTENSION ONLY: Android must render its locked state with no tappable upgrade
 * affordance (PLAY-TIER-COPY-RULING §1). These two tables are meant to disagree
 * and must not be unified.
 */
export const FT_TIER_LOCK_COPY = 'Send files is included with a subscription — Upgrade';
export const FT_SEND_LABEL = 'Send file';

/** The picker constraint, stated before a frame is spent. */
export const FT_PICKER_HINT = 'Files up to 1 GB';

/** The accept dialog's two warning lines. */
export const FT_OFFER_TRUST = 'Only accept files from people you trust.';
export const FT_OFFER_NO_SCAN = 'Files are not scanned for viruses.';
export const FT_OFFER_ACCEPT = 'Accept';
export const FT_OFFER_DECLINE = 'Decline';
