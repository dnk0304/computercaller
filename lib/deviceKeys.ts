/**
 * lib/deviceKeys.ts — the DeviceKey revocation ledger (E2E P1(e)).
 *
 * WHAT THIS TABLE IS. A record of which public key each of a user's devices
 * presented, and when a key stopped being valid. It is a LEDGER, not the trust
 * root. Trust comes from the SAS the user compares (B9) and from the sealing
 * itself. Nothing in the pairing path may treat a row here as permission —
 * if it did, anyone who could write a row could substitute a key, which is the
 * exact attack the SAS exists to catch.
 *
 * THE TWO RULES THAT ARE NOT NEGOTIABLE:
 *
 *   1. `publicKey` is IMMUTABLE. Rotation is a NEW ROW (N-4): the old row gains
 *      a `revokedAt` and keeps its key. An in-place UPDATE would erase the only
 *      evidence that a substitution ever happened — which is the single question
 *      this table exists to answer. Every write path here either inserts or sets
 *      `revokedAt`; none of them touches `publicKey`.
 *
 *   2. `userId` comes from the CALLER'S PROVEN IDENTITY ONLY (B8) — a session
 *      cookie or a verified phone token — never from a body, query or header
 *      the caller controls. This module does not accept a userId argument from
 *      anywhere but its callers' auth result, and the route layer never reads
 *      one out of the request payload. That is why every function here takes
 *      `userId` as its first, explicit parameter: so a reviewer can trace where
 *      it came from at each call site instead of hunting for it inside a body
 *      parser.
 *
 * The 65-byte/0x04 encoding pin is shared with the relay (lib/e2eBlock-core.js)
 * rather than re-implemented, so a key that the relay would refuse on the wire
 * can never be the key that got stored.
 */

import { db } from '@/lib/db';

// The relay's encoding pin, imported rather than re-implemented: a second copy
// of this rule would eventually disagree with the first, and the failure mode
// is a key that stores fine and is refused on the wire (or worse, the reverse).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS core module shared with the plain-Node relay; there is no ESM build of it.
const { isPinnedPublicKey } = require('./e2eBlock-core.js') as {
  isPinnedPublicKey: (value: unknown) => boolean;
};

export const DEVICE_KINDS = ['phone', 'web', 'extension'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Same bound the relay puts on a deviceId, for the same reason. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const LABEL_MAX = 60;

export type RegisterInput = {
  deviceId: string;
  kind: string;
  publicKey: string;
  label?: unknown;
};

export type RegisterResult =
  | { ok: true; rotated: boolean; key: PublicDeviceKey }
  | { ok: false; status: 400 | 409; error: string };

/** The shape returned to callers. Never includes anything the caller cannot already see. */
export type PublicDeviceKey = {
  id: string;
  deviceId: string;
  kind: string;
  publicKey: string;
  label: string | null;
  createdAt: Date;
  lastSeen: Date | null;
  revokedAt: Date | null;
};

const PUBLIC_SELECT = {
  id: true,
  deviceId: true,
  kind: true,
  publicKey: true,
  label: true,
  createdAt: true,
  lastSeen: true,
  revokedAt: true,
} as const;

/**
 * Validate the parts of a register request that the caller supplies.
 * Returns an error string, or null when the input is acceptable.
 *
 * Note what is NOT validated: whether the key is on the curve. The server
 * cannot meaningfully check that a stored point is the device's real key, and
 * pretending otherwise would invite someone to treat a stored row as proof of
 * identity. Shape only — the same shape the relay enforces on the wire.
 */
export function validateRegisterInput(input: RegisterInput): string | null {
  if (!DEVICE_ID_PATTERN.test(String(input.deviceId ?? ''))) {
    return 'deviceId must match [A-Za-z0-9_-]{1,128}';
  }
  if (!(DEVICE_KINDS as readonly string[]).includes(String(input.kind))) {
    return `kind must be one of ${DEVICE_KINDS.join(', ')}`;
  }
  if (!isPinnedPublicKey(input.publicKey)) {
    return 'publicKey must be an uncompressed SEC1 P-256 point: 65 bytes, 0x04-prefixed, base64url';
  }
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== 'string' || input.label.length > LABEL_MAX) {
      return `label must be a string of at most ${LABEL_MAX} characters`;
    }
  }
  return null;
}

function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const cleaned = label.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, LABEL_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Register (or rotate) a device key for `userId`.
 *
 * - No live row for (userId, deviceId)      → insert. `rotated: false`.
 * - A live row with the SAME publicKey      → idempotent. Bumps lastSeen only.
 *                                             A device that re-registers on every
 *                                             boot must not litter the ledger with
 *                                             rotations that did not happen.
 * - A live row with a DIFFERENT publicKey   → ROTATION (N-4): revoke the old row,
 *                                             insert a new one, in ONE transaction.
 *                                             `rotated: true`.
 *
 * The rotation is transactional because the partial unique index permits only
 * one live row per (userId, deviceId): revoking and inserting as two statements
 * would leave a window with zero live keys, and a crash between them would leave
 * a device with no key and no way to tell that was what happened.
 */
export async function registerDeviceKey(
  userId: string,
  input: RegisterInput,
): Promise<RegisterResult> {
  const invalid = validateRegisterInput(input);
  if (invalid) return { ok: false, status: 400, error: invalid };

  const deviceId = String(input.deviceId);
  const kind = String(input.kind);
  const publicKey = String(input.publicKey);
  const label = cleanLabel(input.label);

  const existing = await db.deviceKey.findFirst({
    where: { userId, deviceId, revokedAt: null },
    select: PUBLIC_SELECT,
  });

  if (existing && existing.publicKey === publicKey) {
    const key = await db.deviceKey.update({
      where: { id: existing.id },
      data: { lastSeen: new Date(), ...(label !== null ? { label } : {}) },
      select: PUBLIC_SELECT,
    });
    return { ok: true, rotated: false, key };
  }

  if (existing) {
    const key = await db.$transaction(async (tx) => {
      await tx.deviceKey.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      return tx.deviceKey.create({
        data: { userId, deviceId, kind, publicKey, label, lastSeen: new Date() },
        select: PUBLIC_SELECT,
      });
    });
    return { ok: true, rotated: true, key };
  }

  const key = await db.deviceKey.create({
    data: { userId, deviceId, kind, publicKey, label, lastSeen: new Date() },
    select: PUBLIC_SELECT,
  });
  return { ok: true, rotated: false, key };
}

/**
 * Every key belonging to `userId`, newest first. Callers see their own rows and
 * nothing else — the `userId` in the WHERE clause is the caller's proven id, so
 * there is no filter for an attacker to subvert and no id for them to guess.
 *
 * Revoked rows ARE included by default: the ledger's value is the history, and
 * a user asking "what keys have my devices used" is entitled to see a rotation.
 */
export async function listDeviceKeys(
  userId: string,
  { includeRevoked = true }: { includeRevoked?: boolean } = {},
): Promise<PublicDeviceKey[]> {
  return db.deviceKey.findMany({
    where: { userId, ...(includeRevoked ? {} : { revokedAt: null }) },
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_SELECT,
  });
}

export type RevokeResult =
  | { ok: true; key: PublicDeviceKey; alreadyRevoked: boolean }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Revoke one of `userId`'s keys, addressed by row id.
 *
 * A row belonging to ANOTHER user returns 404, not 403. 403 would confirm the
 * row exists — turning this endpoint into an oracle for enumerating other
 * accounts' key ids. The caller genuinely has no such row, so "not found" is
 * both the safe answer and the true one.
 *
 * Revoking an already-revoked key is a SUCCESS, not an error, and does not move
 * the original timestamp. Revocation is a postcondition ("this key is not
 * live"), and a client retrying after a dropped response must not be told it
 * failed — nor should the audit trail be rewritten by the retry.
 */
export async function revokeDeviceKey(userId: string, id: unknown): Promise<RevokeResult> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    return { ok: false, status: 400, error: 'id must be a non-empty string' };
  }
  const row = await db.deviceKey.findFirst({ where: { id, userId }, select: PUBLIC_SELECT });
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  if (row.revokedAt) return { ok: true, key: row, alreadyRevoked: true };
  const key = await db.deviceKey.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
    select: PUBLIC_SELECT,
  });
  return { ok: true, key, alreadyRevoked: false };
}
