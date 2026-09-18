/**
 * FILE_FAILED reason enum (FROZEN by FT-1's brief) and the copy table FT-3b renders.
 * This module holds no policy: the relay decides, the client only renders.
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
] as const;

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
};

export function failureCopy(reason: string): FailureCopy {
  return isFileFailedReason(reason)
    ? COPY[reason]
    : { message: 'The transfer failed.', action: 'retry' };
}
