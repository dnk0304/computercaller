/**
 * FT-3b — the copy table the WEB and EXTENSION surfaces render.
 *
 * WHY THIS FILE EXISTS AND NOT JUST `lib/fileTransfer/reasons.ts`:
 *
 * 1. The wire enum is ELEVEN reasons (WIRE-TRUTH-v1). `reasons.ts` ships nine —
 *    `size_mismatch` and `busy` are missing, and because `coerceFileFrame`
 *    validates FILE_FAILED through `isFileFailedReason`, a refusal carrying
 *    either reason is DROPPED before any UI can see it. That is a lib/ fix and
 *    lib/ is not this lane; it is filed as a one-line request for Forge. Until
 *    it lands, `ftFailureCopy` still renders both, so the day the enum grows
 *    this table needs no edit.
 *
 * 2. The tier string is PLATFORM-SPECIFIC. Android must not carry a tappable
 *    upgrade affordance (Play Payments anti-steering — PLAY-TIER-COPY-RULING),
 *    but web and the extension are not under Play policy and deliberately keep
 *    the link. Web/ext copy therefore cannot be shared with the Android
 *    strings.xml table, and the two are meant to disagree.
 *
 * For the nine reasons `reasons.ts` already owns we DELEGATE to it rather than
 * restate the strings, so there is exactly one place a word can be changed.
 */

/*
 * RELATIVE, not the `@/` alias, and deliberately so: scripts/ft-ui-proof.mjs
 * imports this module directly under plain `node` to assert the copy table
 * without a browser, and node resolves neither tsconfig paths nor `@/`. Every
 * verbatim user-facing string in this feature therefore lives in THIS file, so
 * the proof needs exactly one import and can never drift from the product.
 */
import { failureCopy, isFileFailedReason } from '../../lib/fileTransfer/reasons.ts';
import type { FailureCopy } from '../../lib/fileTransfer/reasons.ts';

/** The full wire enum (WIRE-TRUTH-v1), independent of what `reasons.ts` types today. */
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
 * The eight reasons the relay is allowed to author (WIRE-TRUTH-v1). They arrive
 * stamped `relay:true` and are abort-only. The receiver NEVER mints these; a
 * peer frame carrying a top-level `relay` key is rejected by the relay itself.
 */
export const FT_RELAY_OWNED_REASONS: readonly FtWireReason[] = [
  'tier', 'quota', 'too_large', 'size_mismatch',
  'busy', 'relay_backpressure', 'timeout', 'connection_lost',
];

export function isRelayOwnedReason(reason: string): reason is FtWireReason {
  return (FT_RELAY_OWNED_REASONS as readonly string[]).includes(reason);
}

/**
 * Copy for the two reasons `reasons.ts` does not type yet. Kept byte-identical
 * to what the Forge one-liner should paste into that file, so folding them in
 * is a move, not a rewrite.
 */
const PENDING_COPY: Record<'size_mismatch' | 'busy', FailureCopy> = {
  size_mismatch: {
    message: 'The file details did not match and it was refused. Try sending it again.',
    action: 'retry',
  },
  busy: {
    message: 'Another transfer is already running. Wait for it to finish, then try again.',
  },
};

/**
 * Render copy for ANY reason string off the wire — the nine `reasons.ts` owns,
 * the two it does not yet, and an unknown twelfth, which falls back to the
 * generic line rather than showing the user a raw enum token.
 */
export function ftFailureCopy(reason: string): FailureCopy {
  // lib FIRST, always. `failureCopy` returns a generic fallback for a reason it
  // does not know, so "does lib know this?" is asked of the enum, not of the
  // returned string. The moment FT-3a.1 adds size_mismatch and busy to
  // FILE_FAILED_REASONS, lib wins here automatically and PENDING_COPY goes
  // unread — no edit, and no window in which the two tables disagree. Deleting
  // PENDING_COPY then is a tidy-up, not a fix.
  if (isFileFailedReason(reason)) return failureCopy(reason);
  if (reason === 'size_mismatch' || reason === 'busy') return PENDING_COPY[reason];
  return failureCopy(reason);
}

/* ===========================================================================
   Verbatim user-facing strings. Single source of truth for the components AND
   the proof harness — see the import note above.
   =========================================================================== */

/**
 * The trial lock, WEB + EXTENSION ONLY. Android must render its locked state
 * with no tappable upgrade affordance (PLAY-TIER-COPY-RULING §1); these two
 * tables are meant to disagree and must not be unified.
 */
export const FT_TIER_LOCK_COPY = 'Send files is included with a subscription — Upgrade';
export const FT_SEND_LABEL = 'Send file';

/** The accept dialog's two warning lines. */
export const FT_OFFER_TRUST = 'Only accept files from people you trust.';
export const FT_OFFER_NO_SCAN = 'Files are not scanned for viruses.';
export const FT_OFFER_ACCEPT = 'Accept';
export const FT_OFFER_DECLINE = 'Decline';
