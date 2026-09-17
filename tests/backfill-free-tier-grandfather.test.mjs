// Proof for scripts/backfill-free-tier-grandfather.mjs (2026-09-13, dispatch
// forge/cardfirst-revert).
//
// WHY A MOCK AND NOT A REAL DATABASE
//   This script writes to the production User table once, immediately before a
//   money gate flips, and the cost of it selecting the wrong population is ~13
//   people either locked out of an app they were told was free, or handed a
//   free tier that was supposed to end. That predicate deserves a proof, and it
//   must be runnable anywhere — no Postgres, no seeded fixture, no shared test
//   DB another agent can contaminate. So the REAL runBackfill (imported, not
//   re-implemented) is driven against an in-memory store shaped exactly like
//   prod as audited on 2026-09-13: 22 users, 9 with a Subscription row
//   (1 payer + 6 trialists + 2 comped), 13 without.
//
//   Run: node tests/backfill-free-tier-grandfather.test.mjs

// Identity fixtures are SYNTHETIC and the allowlist/admin identities come from
// the environment (2026-09-17, dispatch forge/w-strip-email-literals). The
// hardcoded email fallbacks were removed from lib/entitlement-core.js after they
// shipped to every visitor in a public client chunk, so these suites must now
// supply the env they exercise. Real personal addresses never appear in tests.
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
process.env.ENTITLEMENT_ALLOWLIST =
  process.env.ENTITLEMENT_ALLOWLIST || 'admin@example.test,reviewer@example.test';

import assert from 'node:assert/strict';
import { runBackfill, targetWhere } from '../scripts/backfill-free-tier-grandfather.mjs';

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

const FLIP = new Date('2026-09-13T14:00:00Z');
const d = (iso) => new Date(iso);

/** Prod shape, 2026-09-13: 22 users, 9 with a subscription, 13 without. */
function prodUsers() {
  const users = [];
  // 1 real payer + 6 trialists + 2 comped internal = 9 rows WITH a subscription.
  users.push({ id: 'u-sendy', email: 'sendyfeldheim@gmail.com', createdAt: d('2026-08-10T00:00:00Z'), hasSub: true, freeTierGrandfathered: false });
  for (let i = 1; i <= 6; i += 1) {
    users.push({ id: `u-trial-${i}`, email: `trialist${i}@x.com`, createdAt: d(`2026-09-0${i}T00:00:00Z`), hasSub: true, freeTierGrandfathered: false });
  }
  users.push({ id: 'u-comped-1', email: 'admin@example.test', createdAt: d('2026-05-20T00:00:00Z'), hasSub: true, freeTierGrandfathered: false });
  users.push({ id: 'u-comped-2', email: 'reviewer@example.test', createdAt: d('2026-06-01T00:00:00Z'), hasSub: true, freeTierGrandfathered: false });
  // 13 free-tier users, no subscription row, all created before the flip.
  for (let i = 1; i <= 13; i += 1) {
    users.push({ id: `u-free-${i}`, email: `free${i}@x.com`, createdAt: d(`2026-08-${String(15 + (i % 14)).padStart(2, '0')}T00:00:00Z`), hasSub: false, freeTierGrandfathered: false });
  }
  return users;
}

/**
 * Minimal Prisma-shaped mock. It interprets the exact where-clause vocabulary
 * the script uses; anything unrecognised THROWS rather than silently matching
 * everything, so a future edit to the predicate cannot quietly pass this test.
 */
function mockDb(users, { failWrite = false } = {}) {
  const writes = [];
  const match = (u, where = {}) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'subscription') {
        if ('is' in v && v.is === null) { if (u.hasSub) return false; }
        else if ('isNot' in v && v.isNot === null) { if (!u.hasSub) return false; }
        else throw new Error(`unsupported subscription filter: ${JSON.stringify(v)}`);
      } else if (k === 'createdAt') {
        if ('lt' in v) { if (!(u.createdAt < v.lt)) return false; }
        else if ('gte' in v) { if (!(u.createdAt >= v.gte)) return false; }
        else throw new Error(`unsupported createdAt filter: ${JSON.stringify(v)}`);
      } else if (k === 'freeTierGrandfathered') {
        if (u.freeTierGrandfathered !== v) return false;
      } else {
        throw new Error(`unsupported filter key: ${k}`);
      }
    }
    return true;
  };
  const user = {
    async count({ where } = {}) { return users.filter((u) => match(u, where)).length; },
    async findMany({ where, orderBy }) {
      const rows = users.filter((u) => match(u, where))
        .map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt }));
      if (orderBy && orderBy.createdAt === 'asc') rows.sort((a, b) => a.createdAt - b.createdAt);
      return rows;
    },
    async updateMany({ where, data }) {
      const hits = users.filter((u) => match(u, where));
      // Injected fault: report a short count WITHOUT writing, to prove the
      // post-write assertion catches a partial write and rolls back.
      if (failWrite) return { count: Math.max(0, hits.length - 1) };
      for (const u of hits) Object.assign(u, data);
      writes.push({ where, data, count: hits.length });
      return { count: hits.length };
    },
  };
  return {
    users,
    writes,
    // Snapshot/restore = transaction rollback semantics, so a throwing callback
    // really does leave the store untouched, exactly as Postgres would.
    async $transaction(fn) {
      const snapshot = users.map((u) => ({ ...u }));
      try {
        return await fn({ user });
      } catch (err) {
        users.length = 0;
        users.push(...snapshot);
        throw err;
      }
    },
  };
}

const grandfatheredIds = (db) => db.users.filter((u) => u.freeTierGrandfathered).map((u) => u.id).sort();

// ── The predicate itself, asserted literally. If someone loosens it (drops the
//    subscription exclusion, say) this fails before any behaviour test does. ──
console.log('\n── the target predicate ──');
eq('targetWhere is exactly the three-clause AND', targetWhere(FLIP), {
  subscription: { is: null },
  createdAt: { lt: FLIP },
  freeTierGrandfathered: false,
});

// ── Dry run: reports the right number, writes NOTHING. ──────────────────────
console.log('\n── dry run ──');
{
  const db = mockDb(prodUsers());
  const r = await runBackfill(db, { cutoff: FLIP, apply: false });
  eq('total users', r.totalUsers, 22);
  eq('users WITH a subscription', r.withSubscription, 9);
  eq('already grandfathered', r.alreadyGrandfathered, 0);
  eq('no-sub users after the cutoff', r.afterCutoff, 0);
  eq('ELIGIBLE count is 13', r.candidates.length, 13);
  eq('dry run wrote nothing', r.updated, 0);
  eq('no row was mutated', grandfatheredIds(db), []);
  eq('no updateMany was issued at all', db.writes.length, 0);
  ok('candidates are all free-tier users', r.candidates.every((c) => c.id.startsWith('u-free-')));
  ok('candidates are listed oldest-first',
    r.candidates.every((c, i, a) => i === 0 || a[i - 1].createdAt <= c.createdAt));
}

// ── Apply: writes exactly the 13, and nobody else. ──────────────────────────
console.log('\n── apply ──');
{
  const db = mockDb(prodUsers());
  const r = await runBackfill(db, { cutoff: FLIP, apply: true });
  eq('wrote 13 rows', r.updated, 13);
  eq('exactly the 13 free-tier users are grandfathered',
    grandfatheredIds(db), Array.from({ length: 13 }, (_, i) => `u-free-${i + 1}`).sort());

  // RISK 1 + 2 from the brief, asserted as data, not as prose.
  ok('the live payer (Sendy) was NOT touched',
    db.users.find((u) => u.id === 'u-sendy').freeTierGrandfathered === false);
  ok('no trialist was touched',
    db.users.filter((u) => u.id.startsWith('u-trial-')).every((u) => u.freeTierGrandfathered === false));
  ok('no comped internal row was touched',
    db.users.filter((u) => u.id.startsWith('u-comped-')).every((u) => u.freeTierGrandfathered === false));

  // ── Re-runnable: a second (and third) run converges, writing nothing more. ──
  const again = await runBackfill(db, { cutoff: FLIP, apply: true });
  eq('re-run finds 0 eligible', again.candidates.length, 0);
  eq('re-run writes 0 rows', again.updated, 0);
  eq('re-run reports the 13 as already grandfathered', again.alreadyGrandfathered, 13);
  eq('re-run did not change the set', grandfatheredIds(db),
    Array.from({ length: 13 }, (_, i) => `u-free-${i + 1}`).sort());
  const third = await runBackfill(db, { cutoff: FLIP, apply: true });
  eq('third run still 0', third.updated, 0);
}

// ── The cutoff excludes post-flip signups: running the backfill LATE must not
//    hand the free tier to users who signed up under card-first. ─────────────
console.log('\n── cutoff boundary ──');
{
  const users = prodUsers();
  users.push({ id: 'u-after-1', email: 'cardfirst1@x.com', createdAt: d('2026-09-14T00:00:00Z'), hasSub: false, freeTierGrandfathered: false });
  users.push({ id: 'u-after-2', email: 'cardfirst2@x.com', createdAt: d('2026-09-20T00:00:00Z'), hasSub: false, freeTierGrandfathered: false });
  // Exactly AT the cutoff: `lt` means this one is post-flip, not pre-flip.
  users.push({ id: 'u-at-cutoff', email: 'exactly@x.com', createdAt: FLIP, hasSub: false, freeTierGrandfathered: false });
  const db = mockDb(users);
  const r = await runBackfill(db, { cutoff: FLIP, apply: true });
  eq('still exactly 13 eligible', r.updated, 13);
  eq('post-cutoff no-sub users are reported, not written', r.afterCutoff, 3);
  ok('a user created AT the cutoff instant is NOT grandfathered (strict <)',
    db.users.find((u) => u.id === 'u-at-cutoff').freeTierGrandfathered === false);
  ok('card-first signups after the flip are NOT grandfathered',
    db.users.filter((u) => u.id.startsWith('u-after-')).every((u) => u.freeTierGrandfathered === false));
}

// ── A partial write must roll the whole thing back, never leave half the
//    population grandfathered and the other half silently locked out. ────────
console.log('\n── partial-write rollback ──');
{
  const db = mockDb(prodUsers(), { failWrite: true });
  await assert.rejects(
    () => runBackfill(db, { cutoff: FLIP, apply: true }),
    /count mismatch/,
    'a short write must throw',
  );
  console.log('  PASS  a short write throws'); passed += 1;
  eq('nothing was left grandfathered after the rollback', grandfatheredIds(db), []);
}

console.log(`\n  ${passed} assertions passed.\n`);
