/**
 * Type declarations for lib/passwordSetToken-core.js (the shared plain-JS
 * runtime implementation). Keeping the runtime in .js lets the runner-less
 * tests require it against a mock Prisma client with no transpiler; this .d.ts
 * gives the TS callers full types with zero drift.
 *
 * Every symbol declared here MUST appear in the core's `module.exports` — a
 * handwritten .d.ts will happily type a symbol that does not exist at runtime,
 * and `tsc` will pass while the import is undefined. tests/password-set-token
 * .test.js asserts the export list against this file's declarations.
 */

/** Minimal structural view of the Prisma client this core needs. */
export interface TokenDb {
  user: {
    findFirst(args: unknown): Promise<TokenRow | null>;
    findUnique(args: unknown): Promise<{ sessionVersion: number } | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface TokenRow {
  id: string;
  email: string;
  resetToken: string | null;
  resetTokenExpiry: Date | string | null;
}

export type TokenFailure = { ok: false; reason: 'invalid' | 'expired' };
export type TokenLookup = { ok: true; userId: string; email: string } | TokenFailure;
export type ConsumeResult =
  | { ok: true; userId: string; email: string; sessionVersion: number }
  | TokenFailure;

export interface MintedToken {
  /** The raw token. Goes in the email/URL, then is dropped. Never persisted. */
  rawToken: string;
  expiresAt: Date;
  /** Exactly the columns to persist — fold into a `user.create`/`update` data. */
  fields: { resetToken: string; resetTokenExpiry: Date };
}

/** 72h — invite TTL. Long enough to survive a weekend and a spam folder. */
export const INVITE_TTL_MS: number;
/** 1h — self-serve password-reset TTL, for the future forgot-password route. */
export const RESET_TTL_MS: number;

export function generateRawToken(): string;
export function hashToken(raw: string): string;
export function tokensMatch(aHex: string, bHex: string): boolean;
export function isPlausibleToken(raw: unknown): boolean;
export function mintPasswordSetToken(ttlMs?: number, nowMs?: number): MintedToken;
export function buildSetPasswordUrl(rawToken: string, appUrl?: string): string;
export function evaluateTokenRow(
  row: TokenRow | null,
  hash: string,
  nowMs?: number,
): TokenLookup;
export function lookupPasswordSetToken(
  db: TokenDb,
  rawToken: unknown,
  nowMs?: number,
): Promise<TokenLookup>;
export function consumePasswordSetToken(
  db: TokenDb,
  rawToken: unknown,
  passwordHash: string,
  nowMs?: number,
): Promise<ConsumeResult>;
