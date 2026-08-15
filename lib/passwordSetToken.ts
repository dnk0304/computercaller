/**
 * lib/passwordSetToken.ts — typed TS surface for the set-password token
 * primitive (dispatch forge/admin-create-account, 2026-08-15).
 *
 * All the logic and the full security rationale live in the shared plain-JS
 * runtime core, lib/passwordSetToken-core.js — which takes its Prisma client as
 * an argument so the runner-less tests can drive it against a mock with no
 * database. This file only binds the real `db` and re-exports, exactly as
 * lib/auth.ts does for lib/entitlement-core.js. Do NOT reimplement any of it
 * here: one implementation, two call sites, no drift.
 *
 * Read the core's header for the token model (256-bit raw token, SHA-256 at
 * rest, expiring, single-use enforced by the DB write).
 */

import { db } from '@/lib/db';
import type { TokenDb, TokenLookup, ConsumeResult, MintedToken } from './passwordSetToken-core';
import {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  generateRawToken,
  hashToken,
  tokensMatch,
  isPlausibleToken,
  mintPasswordSetToken,
  buildSetPasswordUrl,
  evaluateTokenRow,
  lookupPasswordSetToken as coreLookup,
  consumePasswordSetToken as coreConsume,
} from './passwordSetToken-core';

export type { TokenLookup, ConsumeResult, MintedToken };
export {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  generateRawToken,
  hashToken,
  tokensMatch,
  isPlausibleToken,
  mintPasswordSetToken,
  buildSetPasswordUrl,
  evaluateTokenRow,
};

/** Resolve a raw token to its user WITHOUT consuming it (GET pre-flight). */
export function lookupPasswordSetToken(rawToken: unknown): Promise<TokenLookup> {
  return coreLookup(db as unknown as TokenDb, rawToken);
}

/** Consume the token, set the password, and bump sessionVersion — atomically. */
export function consumePasswordSetToken(
  rawToken: unknown,
  passwordHash: string,
): Promise<ConsumeResult> {
  return coreConsume(db as unknown as TokenDb, rawToken, passwordHash);
}

/**
 * Attach a freshly-minted token to an EXISTING user row (resend-invite, and the
 * future forgot-password route). Any previously-issued token for this user is
 * overwritten and thereby revoked — re-inviting kills the older link, which is
 * what an admin clicking "resend" expects.
 */
export async function issuePasswordSetToken(
  userId: string,
  ttlMs: number = INVITE_TTL_MS,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const { rawToken, expiresAt, fields } = mintPasswordSetToken(ttlMs);
  await db.user.update({ where: { id: userId }, data: fields });
  return { rawToken, expiresAt };
}
