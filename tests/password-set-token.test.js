// Unit tests for lib/passwordSetToken-core.js — the single-use, expiring
// set-password token primitive behind the admin invite flow and (eventually)
// forgot-password. Dispatch forge/admin-create-account, 2026-08-15.
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/password-set-token.test.js
//
// Exits non-zero on the first failing assertion.
//
// NO DATABASE. The core takes its Prisma client as an argument, so a mock that
// models the two behaviours we actually depend on — (a) findFirst matches on
// resetToken, (b) updateMany applies ONLY if every WHERE field still matches —
// is enough to prove the security properties, including the single-use race.

'use strict';

const assert = require('node:assert').strict;
const crypto = require('node:crypto');
const core = require('../lib/passwordSetToken-core.js');

let passed = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  ok  ${name}`); },
        (e) => { console.error(`FAIL  ${name}\n      ${e.message}`); process.exit(1); },
      );
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exit(1);
  }
}

// ── Mock Prisma ──────────────────────────────────────────────────────────────
// `rows` is the user table. updateMany implements the conditional-write
// semantics the single-use guarantee rests on: it matches id + resetToken +
// resetTokenExpiry>now, and returns the number of rows it actually changed.
function makeDb(rows) {
  return {
    _rows: rows,
    user: {
      async findFirst({ where }) {
        return rows.find((r) => r.resetToken === where.resetToken) ?? null;
      },
      async findUnique({ where }) {
        return rows.find((r) => r.id === where.id) ?? null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of rows) {
          if (r.id !== where.id) continue;
          if (r.resetToken !== where.resetToken) continue;
          const exp = r.resetTokenExpiry ? new Date(r.resetTokenExpiry).getTime() : 0;
          if (!(exp > new Date(where.resetTokenExpiry.gt).getTime())) continue;
          r.passwordHash = data.passwordHash;
          r.resetToken = data.resetToken;
          r.resetTokenExpiry = data.resetTokenExpiry;
          r.sessionVersion = (r.sessionVersion ?? 0) + data.sessionVersion.increment;
          count++;
        }
        return { count };
      },
    },
  };
}

const NOW = new Date('2026-08-15T12:00:00Z').getTime();

/** Seed one user holding a live invite token. Returns [db, rawToken]. */
function seed({ ttlMs = core.INVITE_TTL_MS, sessionVersion = 0 } = {}) {
  const minted = core.mintPasswordSetToken(ttlMs, NOW);
  const db = makeDb([
    {
      id: 'u1',
      email: 'invitee@example.com',
      passwordHash: null,
      sessionVersion,
      resetToken: minted.fields.resetToken,
      resetTokenExpiry: minted.fields.resetTokenExpiry,
    },
  ]);
  return [db, minted.rawToken, minted];
}

(async () => {
  console.log('lib/passwordSetToken-core.js');

  // ── Token generation & hashing ────────────────────────────────────────────
  ok('raw token is 32 bytes of entropy, base64url', () => {
    const t = core.generateRawToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only (URL-safe)');
    assert.equal(Buffer.from(t, 'base64url').length, 32);
  });

  ok('tokens are unique across mints', () => {
    const s = new Set();
    for (let i = 0; i < 500; i++) s.add(core.generateRawToken());
    assert.equal(s.size, 500);
  });

  ok('hashToken is sha256 hex and deterministic', () => {
    const raw = 'abc';
    const want = crypto.createHash('sha256').update('abc').digest('hex');
    assert.equal(core.hashToken(raw), want);
    assert.equal(core.hashToken(raw), core.hashToken(raw));
    assert.match(core.hashToken(raw), /^[0-9a-f]{64}$/);
  });

  // THE property the whole at-rest model rests on.
  ok('the RAW token is never what gets persisted', () => {
    const m = core.mintPasswordSetToken(core.INVITE_TTL_MS, NOW);
    assert.notEqual(m.fields.resetToken, m.rawToken);
    assert.equal(m.fields.resetToken, core.hashToken(m.rawToken));
    assert.ok(!m.fields.resetToken.includes(m.rawToken));
  });

  ok('invite TTL is 72h and reset TTL is 1h', () => {
    assert.equal(core.INVITE_TTL_MS, 72 * 3600 * 1000);
    assert.equal(core.RESET_TTL_MS, 3600 * 1000);
    const m = core.mintPasswordSetToken(core.INVITE_TTL_MS, NOW);
    assert.equal(m.expiresAt.getTime(), NOW + 72 * 3600 * 1000);
    assert.equal(m.fields.resetTokenExpiry.getTime(), m.expiresAt.getTime());
  });

  // ── Constant-time comparison ──────────────────────────────────────────────
  ok('tokensMatch is correct (and total) on equal/unequal/ragged/non-string', () => {
    const a = core.hashToken('x');
    assert.equal(core.tokensMatch(a, a), true);
    assert.equal(core.tokensMatch(a, core.hashToken('y')), false);
    // timingSafeEqual THROWS on length mismatch — a ragged input must return
    // false, not blow up into a 500.
    assert.equal(core.tokensMatch(a, 'short'), false);
    assert.equal(core.tokensMatch(a, null), false);
    assert.equal(core.tokensMatch(undefined, a), false);
    assert.equal(core.tokensMatch(a, a + 'x'), false);
  });

  ok('isPlausibleToken rejects junk before it reaches the DB', () => {
    assert.equal(core.isPlausibleToken(core.generateRawToken()), true);
    assert.equal(core.isPlausibleToken(''), false);
    assert.equal(core.isPlausibleToken('short'), false);
    assert.equal(core.isPlausibleToken('x'.repeat(513)), false);
    assert.equal(core.isPlausibleToken(null), false);
    assert.equal(core.isPlausibleToken(123), false);
    assert.equal(core.isPlausibleToken({}), false);
  });

  // ── Pure decision truth table ─────────────────────────────────────────────
  ok('evaluateTokenRow: no row → invalid', () => {
    assert.deepEqual(core.evaluateTokenRow(null, core.hashToken('a'), NOW), {
      ok: false, reason: 'invalid',
    });
  });

  ok('evaluateTokenRow: row with a NULL resetToken → invalid (not a match)', () => {
    // Guards the classic SQL/ORM null-bypass: a consumed row has resetToken
    // null, and must never be resurrected by a null-ish lookup.
    const row = { id: 'u1', email: 'e@x.com', resetToken: null, resetTokenExpiry: new Date(NOW + 1000) };
    assert.equal(core.evaluateTokenRow(row, core.hashToken('a'), NOW).reason, 'invalid');
  });

  ok('evaluateTokenRow: expired → expired, and exactly-at-expiry is EXPIRED', () => {
    const h = core.hashToken('a');
    const past = { id: 'u1', email: 'e@x.com', resetToken: h, resetTokenExpiry: new Date(NOW - 1) };
    assert.equal(core.evaluateTokenRow(past, h, NOW).reason, 'expired');
    // Boundary: expiry === now must NOT be usable (<=, not <).
    const exact = { id: 'u1', email: 'e@x.com', resetToken: h, resetTokenExpiry: new Date(NOW) };
    assert.equal(core.evaluateTokenRow(exact, h, NOW).reason, 'expired');
    const live = { id: 'u1', email: 'e@x.com', resetToken: h, resetTokenExpiry: new Date(NOW + 1) };
    assert.equal(core.evaluateTokenRow(live, h, NOW).ok, true);
  });

  ok('evaluateTokenRow: missing expiry → expired (never treated as forever)', () => {
    const h = core.hashToken('a');
    const row = { id: 'u1', email: 'e@x.com', resetToken: h, resetTokenExpiry: null };
    assert.equal(core.evaluateTokenRow(row, h, NOW).reason, 'expired');
  });

  // ── Lookup (non-consuming) ────────────────────────────────────────────────
  await ok('lookup: valid token resolves the user and does NOT consume it', async () => {
    const [db, raw] = seed();
    const r = await core.lookupPasswordSetToken(db, raw, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.userId, 'u1');
    assert.equal(r.email, 'invitee@example.com');
    // Still redeemable afterwards — the pre-flight must be side-effect free.
    assert.notEqual(db._rows[0].resetToken, null);
    assert.equal((await core.lookupPasswordSetToken(db, raw, NOW)).ok, true);
  });

  await ok('lookup: an unrelated valid-shaped token → invalid', async () => {
    const [db] = seed();
    const r = await core.lookupPasswordSetToken(db, core.generateRawToken(), NOW);
    assert.deepEqual(r, { ok: false, reason: 'invalid' });
  });

  await ok('lookup: expired token → expired', async () => {
    const [db, raw] = seed({ ttlMs: 1000 });
    const r = await core.lookupPasswordSetToken(db, raw, NOW + 5000);
    assert.deepEqual(r, { ok: false, reason: 'expired' });
  });

  // ── Consume ───────────────────────────────────────────────────────────────
  await ok('consume: sets the hash, DESTROYS the token, bumps sessionVersion', async () => {
    const [db, raw] = seed({ sessionVersion: 7 });
    const r = await core.consumePasswordSetToken(db, raw, '$2a$12$fakehash', NOW);
    assert.equal(r.ok, true);
    assert.equal(r.userId, 'u1');
    assert.equal(r.email, 'invitee@example.com');
    const row = db._rows[0];
    assert.equal(row.passwordHash, '$2a$12$fakehash');
    assert.equal(row.resetToken, null, 'token must not survive redemption');
    assert.equal(row.resetTokenExpiry, null);
    assert.equal(row.sessionVersion, 8, 'credential change must revoke prior sessions');
    // The signed JWT must carry the POST-bump version or the session it creates
    // is rejected on its very next request.
    assert.equal(r.sessionVersion, 8);
  });

  await ok('consume: a USED token is rejected (single use)', async () => {
    const [db, raw] = seed();
    assert.equal((await core.consumePasswordSetToken(db, raw, 'h1', NOW)).ok, true);
    const second = await core.consumePasswordSetToken(db, raw, 'h2', NOW);
    assert.deepEqual(second, { ok: false, reason: 'invalid' });
    assert.equal(db._rows[0].passwordHash, 'h1', 'replay must not overwrite the password');
    assert.equal(db._rows[0].sessionVersion, 1, 'replay must not bump again');
  });

  await ok('consume: an EXPIRED token is rejected and changes nothing', async () => {
    const [db, raw] = seed({ ttlMs: 1000 });
    const r = await core.consumePasswordSetToken(db, raw, 'h', NOW + 5000);
    assert.deepEqual(r, { ok: false, reason: 'expired' });
    assert.equal(db._rows[0].passwordHash, null);
    assert.equal(db._rows[0].sessionVersion, 0);
  });

  await ok('consume: an unknown token is rejected', async () => {
    const [db] = seed();
    const r = await core.consumePasswordSetToken(db, core.generateRawToken(), 'h', NOW);
    assert.deepEqual(r, { ok: false, reason: 'invalid' });
    assert.equal(db._rows[0].passwordHash, null);
  });

  // The race the DB-side WHERE exists to win. Both requests pass the read, then
  // contend on the conditional write; exactly one may succeed.
  await ok('consume: two CONCURRENT redemptions — exactly one wins', async () => {
    const [db, raw] = seed();
    const [a, b] = await Promise.all([
      core.consumePasswordSetToken(db, raw, 'winnerA', NOW),
      core.consumePasswordSetToken(db, raw, 'winnerB', NOW),
    ]);
    const wins = [a, b].filter((r) => r.ok).length;
    assert.equal(wins, 1, 'a read-then-write in app code would let BOTH through');
    assert.equal(db._rows[0].sessionVersion, 1, 'exactly one bump');
    assert.equal(db._rows[0].resetToken, null);
  });

  // Expiry re-asserted in the WHERE: token valid at read time, expired by write
  // time. The mock's updateMany enforces the same predicate Postgres would.
  await ok('consume: token expiring between read and write is rejected', async () => {
    const [db, raw, minted] = seed();
    const justBefore = minted.expiresAt.getTime() - 1;
    // Force the row to expire underneath us after the read succeeds.
    const realFindFirst = db.user.findFirst;
    db.user.findFirst = async (args) => {
      const row = await realFindFirst(args);
      db._rows[0].resetTokenExpiry = new Date(justBefore - 10_000);
      return row;
    };
    const r = await core.consumePasswordSetToken(db, raw, 'h', justBefore);
    assert.equal(r.ok, false, 'the WHERE clause must re-check expiry');
    assert.equal(db._rows[0].passwordHash, null);
  });

  // ── URL building ──────────────────────────────────────────────────────────
  ok('buildSetPasswordUrl points at the page, url-encodes, and strips slashes', () => {
    const u = core.buildSetPasswordUrl('a+b/c=', 'https://computercaller.com/');
    assert.equal(u, 'https://computercaller.com/auth/set-password?token=a%2Bb%2Fc%3D');
    assert.ok(!u.includes('//auth'), 'trailing slash on the base must not double up');
    // A real base64url token must survive the round trip byte-for-byte.
    const raw = core.generateRawToken();
    const url = new URL(core.buildSetPasswordUrl(raw, 'https://x.test'));
    assert.equal(url.searchParams.get('token'), raw);
  });

  // ── .d.ts / runtime export drift ──────────────────────────────────────────
  // A handwritten .d.ts will happily declare a symbol the runtime never exports;
  // tsc passes and the import is undefined at 3am. Assert both directions.
  ok('every symbol declared in the .d.ts actually exists at runtime', () => {
    const dts = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'lib', 'passwordSetToken-core.d.ts'),
      'utf8',
    );
    const declared = [...dts.matchAll(/^export (?:declare )?(?:function|const) (\w+)/gm)].map(
      (m) => m[1],
    );
    assert.ok(declared.length >= 11, `expected the full surface, found ${declared.length}`);
    for (const name of declared) {
      assert.ok(name in core, `.d.ts declares "${name}" but the runtime does not export it`);
    }
    for (const name of Object.keys(core)) {
      assert.ok(declared.includes(name), `runtime exports "${name}" with no .d.ts declaration`);
    }
  });

  console.log(`\n${passed} passed\n`);
})();
