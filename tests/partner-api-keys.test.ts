// Behavioural tests for the per-partner API-key primitives (lib/partnerKeys.ts)
// — SDK-PKG-2 Phase 1 (dispatch forge/partner-api-keys, 2026-08-25).
//
// Runner-less by design (repo convention — no Jest/Vitest). lib/partnerKeys.ts
// imports ONLY node:crypto, so it type-strips + imports cleanly here. Run with:
//
//   node tests/partner-api-keys.test.ts
//
// Exits non-zero on the first failing assertion.

import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import {
  generatePartnerKey,
  hashSecret,
  constantTimeHexEqual,
  parsePartnerKey,
  looksLikePartnerKey,
  resolvePartnerKey,
  hasScope,
  PARTNER_KEY_PREFIX,
  PARTNER_DEFAULT_RATE_LIMIT_PER_MIN,
  type PartnerKeyDbClient,
} from '../lib/partnerKeys.ts';

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

// ── Key generation + format ──────────────────────────────────────────────────
const gen = generatePartnerKey();
ok('token carries the ccp_live_ prefix', gen.token.startsWith(PARTNER_KEY_PREFIX));
ok('token = prefix + keyId + . + secret', gen.token === `${PARTNER_KEY_PREFIX}${gen.keyId}.${gen.secret}`);
ok('keyId is 12 hex chars', /^[0-9a-f]{12}$/.test(gen.keyId));
ok('secret has >=43 base64url chars (256-bit)', gen.secret.length >= 43 && /^[A-Za-z0-9_-]+$/.test(gen.secret));
ok('hashedSecret is SHA-256 hex (64 chars), NOT the plaintext', /^[0-9a-f]{64}$/.test(gen.hashedSecret) && !gen.hashedSecret.includes(gen.secret));
ok('stored hash matches hashSecret(secret)', gen.hashedSecret === hashSecret(gen.secret));
ok('two keys never collide', generatePartnerKey().keyId !== generatePartnerKey().keyId);

// ── parse / looksLike ────────────────────────────────────────────────────────
ok('parse round-trips generated token', JSON.stringify(parsePartnerKey(gen.token)) === JSON.stringify({ keyId: gen.keyId, secret: gen.secret }));
ok('parse rejects wrong prefix', parsePartnerKey('sk_live_ab.cd') === null);
ok('parse rejects missing separator', parsePartnerKey(`${PARTNER_KEY_PREFIX}abcdef`) === null);
ok('parse rejects empty secret', parsePartnerKey(`${PARTNER_KEY_PREFIX}abcdef.`) === null);
ok('parse rejects null/empty', parsePartnerKey(null) === null && parsePartnerKey('') === null);
ok('looksLikePartnerKey true only for prefix', looksLikePartnerKey(gen.token) && !looksLikePartnerKey('legacy-shared-key-value'));

// ── constant-time compare ────────────────────────────────────────────────────
ok('constantTimeHexEqual true for equal', constantTimeHexEqual(gen.hashedSecret, gen.hashedSecret));
ok('constantTimeHexEqual false for different', !constantTimeHexEqual(gen.hashedSecret, hashSecret('nope')));
ok('constantTimeHexEqual false for null', !constantTimeHexEqual(null, gen.hashedSecret) && !constantTimeHexEqual(gen.hashedSecret, undefined));

// ── hasScope: deny by default ────────────────────────────────────────────────
ok("hasScope true when present", hasScope(['call', 'presence'], 'call'));
ok("hasScope false when absent", !hasScope(['presence'], 'call'));
ok('hasScope false for empty/null', !hasScope([], 'call') && !hasScope(null, 'call') && !hasScope(undefined, 'call'));

// ── resolvePartnerKey against a mock DB ──────────────────────────────────────
// A tiny in-memory PartnerApiKey table keyed by keyId.
function mockDb(rows: Record<string, any>): PartnerKeyDbClient {
  return {
    partnerApiKey: {
      async findUnique({ where }) {
        return rows[where.keyId] ?? null;
      },
      async update() {
        return {};
      },
    },
  };
}

const activeRow = {
  id: 'ak_1',
  partnerId: 'p_1',
  keyId: gen.keyId,
  hashedSecret: gen.hashedSecret,
  scopes: ['call'],
  status: 'active',
  rateLimitPerMin: null,
  partner: { id: 'p_1', slug: 'acme', status: 'active' },
};

async function run() {
  // valid key → ok, default rate applied when row is null
  const good = await resolvePartnerKey(mockDb({ [gen.keyId]: activeRow }), gen.token);
  ok('valid key resolves ok', good.ok === true);
  ok('resolves partnerId + apiKeyId', good.ok && good.partnerId === 'p_1' && good.apiKeyId === 'ak_1');
  ok('null rateLimit → default', good.ok && good.rateLimitPerMin === PARTNER_DEFAULT_RATE_LIMIT_PER_MIN);

  // wrong secret → invalid (same keyId, bad secret)
  const wrong = await resolvePartnerKey(mockDb({ [gen.keyId]: activeRow }), `${PARTNER_KEY_PREFIX}${gen.keyId}.${crypto.randomBytes(32).toString('base64url')}`);
  ok('wrong secret → invalid', !wrong.ok && wrong.reason === 'invalid');

  // unknown keyId → invalid (NOT a distinct not-found — timing-flat)
  const missing = await resolvePartnerKey(mockDb({}), gen.token);
  ok('unknown keyId → invalid (no existence oracle)', !missing.ok && missing.reason === 'invalid');

  // revoked key → revoked (only visible to a holder of the real secret)
  const revoked = await resolvePartnerKey(mockDb({ [gen.keyId]: { ...activeRow, status: 'revoked' } }), gen.token);
  ok('revoked key → revoked', !revoked.ok && revoked.reason === 'revoked');

  // suspended partner → suspended
  const suspended = await resolvePartnerKey(mockDb({ [gen.keyId]: { ...activeRow, partner: { ...activeRow.partner, status: 'suspended' } } }), gen.token);
  ok('suspended partner → suspended', !suspended.ok && suspended.reason === 'suspended');

  // non-partner-shaped token short-circuits without DB
  const legacy = await resolvePartnerKey(mockDb({}), 'legacy-shared-secret');
  ok('legacy-shaped token → not_partner_key', !legacy.ok && legacy.reason === 'not_partner_key');

  // configured per-key rate limit is honoured
  const limited = await resolvePartnerKey(mockDb({ [gen.keyId]: { ...activeRow, rateLimitPerMin: 5 } }), gen.token);
  ok('per-key rateLimit honoured', limited.ok && limited.rateLimitPerMin === 5);

  // DB throw → fail closed (invalid), still runs a compare
  const throwingDb: PartnerKeyDbClient = {
    partnerApiKey: {
      async findUnique() {
        throw new Error('db down');
      },
      async update() {
        return {};
      },
    },
  };
  const dbErr = await resolvePartnerKey(throwingDb, gen.token);
  ok('DB error → fail closed (invalid)', !dbErr.ok && dbErr.reason === 'invalid');

  console.log(`\n${passed} passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
