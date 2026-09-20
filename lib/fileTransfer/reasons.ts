/**
 * FILE_FAILED reason enum (FROZEN by WIRE-TRUTH v1) and the copy table FT-3b
 * renders. This module holds no policy: the relay decides, the client renders.
 *
 * FT-3a.1: the enum is the WIRE-TRUTH ELEVEN. `size_mismatch` (FT-A1 A-7 /
 * FT-A1.1 §3 — the metered-overrun and tampered-hint word) and `busy`
 * (FT-A1.1 MUST A1.1-M5 — moved off FILE_REJECT, which is sealed-by-exclusion
 * and so invisible under mode ON) were missing here, which meant
 * `coerceFileFrame` returned null for a refusal the relay really does mint and
 * the UI never saw it. `bad_hint` is deliberately ABSENT: MUST A1.1-M1 makes it
 * a relay COUNTER only, never a wire reason.
 */

export const FILE_FAILED_REASONS = [
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

/**
 * FT-A1.1 §2.2, frozen and exhaustive: the reasons the RELAY may mint itself.
 * A plaintext `FILE_FAILED` under mode ON is admissible ONLY for one of these
 * (see lib/fileTransfer/relayAbort.ts). The peer-owned three — `hash_mismatch`,
 * `cancelled`, `oom` — must stay sealed; a plaintext one is dropped + counted
 * whether or not it carries `relay:true`.
 */
export const RELAY_OWNED_FAIL_REASONS = [
  'tier',
  'quota',
  'too_large',
  'size_mismatch',
  'busy',
  'relay_backpressure',
  'timeout',
  'connection_lost',
] as const;

export type RelayOwnedFailReason = (typeof RELAY_OWNED_FAIL_REASONS)[number];

export function isRelayOwnedFailReason(v: unknown): v is RelayOwnedFailReason {
  return typeof v === 'string' && (RELAY_OWNED_FAIL_REASONS as readonly string[]).includes(v);
}

export type FileFailedReason = (typeof FILE_FAILED_REASONS)[number];

export function isFileFailedReason(v: unknown): v is FileFailedReason {
  return typeof v === 'string' && (FILE_FAILED_REASONS as readonly string[]).includes(v);
}

export interface FailureCopy {
  /** Short line for a banner. */
  readonly message: string;
  /** Optional call to action FT-3b wires to the existing pricing modal. */
  readonly action?: 'upgrade' | 'retry';
}

const COPY: Record<FileFailedReason, FailureCopy> = {
  hash_mismatch: {
    message: 'The file did not arrive intact and was discarded. Try sending it again.',
    action: 'retry',
  },
  connection_lost: {
    message: 'The connection dropped before the transfer finished.',
    action: 'retry',
  },
  relay_backpressure: {
    message: 'The connection could not keep up and the transfer was stopped.',
    action: 'retry',
  },
  cancelled: { message: 'Transfer cancelled.' },
  timeout: { message: 'The transfer stalled and timed out.', action: 'retry' },
  too_large: { message: 'Files up to 1 GB.' },
  oom: { message: 'Not enough memory to finish the transfer.' },
  quota: { message: 'Daily limit reached (2 GB) — resets at midnight UTC.' },
  tier: {
    message: 'Send files is included with a subscription — Upgrade',
    action: 'upgrade',
  },
  // MUST A1.1-M10: a relay-owned reason is a TRANSPORT outcome, not an
  // authoritative account statement — the relay is trusted to name why it
  // stopped, not to be the source of truth about the account. The existing
  // `quota`/`tier` lines predate M10 and are pinned verbatim by FT-3b's
  // ft-ui-proof, so they are FT-3b's to re-word; these two are new here.
  size_mismatch: {
    message: 'The transfer was stopped: the file did not match what was offered.',
    action: 'retry',
  },
  busy: {
    message: 'The transfer was stopped: another transfer is already in progress.',
    action: 'retry',
  },
};

export function failureCopy(reason: string): FailureCopy {
  return isFileFailedReason(reason)
    ? COPY[reason]
    : { message: 'The transfer failed.', action: 'retry' };
}
