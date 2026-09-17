#!/usr/bin/env node
/**
 * tests/devicekey-authz.test.js — B8: a DeviceKey route acts on the CALLER'S
 * rows and nobody else's.
 *
 * This is the test that matters most in P1(e), because the failure it guards
 * against is silent, total, and easy to write by accident. A route that reads
 * `userId` from the request body instead of the session looks almost identical
 * to a correct one, passes every happy-path test, and lets any caller read and
 * revoke every other account's device keys. So the assertions here are not
 * "does register work" — they are "does the wrong caller get nothing".
 *
 * THE DISCRIMINATING SETUP is two users, always. A single-user test passes just
 * as happily against an implementation with no authorization at all: with only
 * one user's rows in the table, "returns my rows" and "returns all rows" are
 * the same answer. Every check below therefore has a victim (user B) whose rows
 * must be invisible and untouchable to the attacker (user A).
 *
 * This runs against the real ccpix database, because the thing under test is a
 * WHERE clause and a unique index. Mocking the database here would mock away
 * the entire subject — a mocked `findFirst` returns whatever the mock says,
 * including another user's row, and the test would pass. (It would also repeat
 * the mistake the project already recorded: mocked tests passing while the real
 * migration was broken.)
 *
 * FILENAME NOTE: the brief named this `devicekey-authz.test.js`. It is `.mjs`
 * because the package is CommonJS, so a `.js` test would have to use CJS
 * imports — and the no-require-imports rule would then put four fresh errors on
 * a NEW file, which the LINT-BASELINE manifest rule forbids (new files must be
 * 0, and growing a cell to accommodate them would be refused). Every other test
 * in this phase is `.mjs` for the same reason.
 *
 * Run:
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc node tests/devicekey-authz.test.mjs
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireCjs = createRequire(import.meta.url);
const { PrismaClient } = requireCjs(join(ROOT, 'node_modules', '@prisma', 'client'));

if (!process.env.DATABASE_URL) {
  console.error('devicekey-authz: DATABASE_URL is required (ccpix harness DB).');
  process.exit(2);
}

// The service layer is TypeScript. Rather than pull a transpiler into a node
// test, the route logic is exercised through the same Prisma calls the service
// makes, and the SERVICE ITSELF is pinned by a source-level drift guard at the
// end of this file — the same pattern the relay tests use for server.js. What
// is under test here is the database contract: the WHERE clauses, the partial
// unique index, and the rotation transaction.

const db = new PrismaClient();

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MARK = randomBytes(6).toString('hex');
const pub = () => Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString('base64url');

// ── the service layer, re-expressed against Prisma exactly as lib/deviceKeys.ts
//    does it. Divergence is caught by the drift guard at the bottom.
async function registerDeviceKey(userId, { deviceId, kind, publicKey, label = null }) {
  const existing = await db.deviceKey.findFirst({ where: { userId, deviceId, revokedAt: null } });
  if (existing && existing.publicKey === publicKey) {
    const key = await db.deviceKey.update({ where: { id: existing.id }, data: { lastSeen: new Date() } });
    return { rotated: false, key };
  }
  if (existing) {
    const key = await db.$transaction(async (tx) => {
      await tx.deviceKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
      return tx.deviceKey.create({ data: { userId, deviceId, kind, publicKey, label, lastSeen: new Date() } });
    });
    return { rotated: true, key };
  }
  const key = await db.deviceKey.create({ data: { userId, deviceId, kind, publicKey, label, lastSeen: new Date() } });
  return { rotated: false, key };
}
const listDeviceKeys = (userId) =>
  db.deviceKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
async function revokeDeviceKey(userId, id) {
  const row = await db.deviceKey.findFirst({ where: { id, userId } });
  if (!row) return { ok: false, status: 404 };
  if (row.revokedAt) return { ok: true, alreadyRevoked: true, key: row };
  const key = await db.deviceKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return { ok: true, alreadyRevoked: false, key };
}

let attacker = null;
let victim = null;

async function main() {
  attacker = await db.user.create({
    data: { email: `dk-attacker-${MARK}@example.invalid`, phoneToken: randomBytes(32).toString('base64url') },
    select: { id: true },
  });
  victim = await db.user.create({
    data: { email: `dk-victim-${MARK}@example.invalid`, phoneToken: randomBytes(32).toString('base64url') },
    select: { id: true },
  });

  // ── 1. registration ─────────────────────────────────────────────────────
  const aKey = pub();
  const reg = await registerDeviceKey(attacker.id, { deviceId: 'dev-a', kind: 'web', publicKey: aKey });
  eq('register: not a rotation', reg.rotated, false);
  eq('register: stored under the caller', reg.key.userId, attacker.id);
  eq('register: the key is stored verbatim', reg.key.publicKey, aKey);
  eq('register: a new key is live', reg.key.revokedAt, null);

  // Idempotent re-register. A device that registers on every boot must not fill
  // the ledger with rotations that never happened — a ledger full of noise is a
  // ledger nobody reads when it matters.
  const again = await registerDeviceKey(attacker.id, { deviceId: 'dev-a', kind: 'web', publicKey: aKey });
  eq('re-register with the SAME key is not a rotation', again.rotated, false);
  eq('re-register does not create a row', again.key.id, reg.key.id);
  eq('…and the ledger still has one row for that device',
    (await db.deviceKey.count({ where: { userId: attacker.id, deviceId: 'dev-a' } })), 1);

  // ── 2. ROTATION (N-4): new row, old row revoked, key never mutated ───────
  const aKey2 = pub();
  const rot = await registerDeviceKey(attacker.id, { deviceId: 'dev-a', kind: 'web', publicKey: aKey2 });
  eq('a changed publicKey IS a rotation', rot.rotated, true);
  check('rotation created a NEW row', rot.key.id !== reg.key.id);
  eq('the new row holds the new key', rot.key.publicKey, aKey2);
  eq('the new row is live', rot.key.revokedAt, null);
  const oldRow = await db.deviceKey.findUnique({ where: { id: reg.key.id } });
  check('the OLD row still exists', Boolean(oldRow));
  check('the old row is revoked', oldRow.revokedAt instanceof Date);
  // THE point of N-4. If publicKey were updated in place, the evidence that a
  // substitution happened would be gone — which is the one question this table
  // exists to answer.
  eq('the old row KEPT its original key (publicKey is immutable)', oldRow.publicKey, aKey);
  eq('two rows now exist for that device',
    (await db.deviceKey.count({ where: { userId: attacker.id, deviceId: 'dev-a' } })), 2);
  eq('…but only ONE is live',
    (await db.deviceKey.count({ where: { userId: attacker.id, deviceId: 'dev-a', revokedAt: null } })), 1);

  // The partial unique index is what makes "only one live" a guarantee rather
  // than a convention. Asserted directly, because a convention held only by app
  // code is one concurrent request away from being false.
  let duplicateRefused = false;
  try {
    await db.deviceKey.create({ data: { userId: attacker.id, deviceId: 'dev-a', kind: 'web', publicKey: pub() } });
  } catch { duplicateRefused = true; }
  check('the DATABASE refuses a second live key for one (userId, deviceId)', duplicateRefused);
  // …and the same deviceId under a DIFFERENT user is fine — the index is scoped
  // per user, so one account cannot squat another's device ids.
  const vSame = await registerDeviceKey(victim.id, { deviceId: 'dev-a', kind: 'web', publicKey: pub() });
  eq('a different user may use the same deviceId', vSame.key.userId, victim.id);

  // ── 3. LIST is scoped to the caller ─────────────────────────────────────
  await registerDeviceKey(victim.id, { deviceId: 'dev-v1', kind: 'phone', publicKey: pub() });
  await registerDeviceKey(victim.id, { deviceId: 'dev-v2', kind: 'extension', publicKey: pub() });

  const attackerList = await listDeviceKeys(attacker.id);
  const victimList = await listDeviceKeys(victim.id);
  check('the attacker sees rows at all (the scan is not vacuous)', attackerList.length > 0);
  check('the victim sees rows at all', victimList.length >= 3);
  check('EVERY row the attacker sees is the attacker’s',
    attackerList.every((k) => k.userId === attacker.id));
  const victimIds = new Set(victimList.map((k) => k.id));
  check('the attacker sees NONE of the victim’s rows',
    attackerList.every((k) => !victimIds.has(k.id)));
  check('the two users’ lists are disjoint',
    attackerList.every((k) => !victimList.some((v) => v.id === k.id)));
  // Revoked rows are included: the ledger's value IS the history.
  check('the list includes revoked rows', attackerList.some((k) => k.revokedAt !== null));

  // ── 4. a body-supplied userId is IGNORED ────────────────────────────────
  // The route builds its input from the body but takes userId from the auth
  // result only. Passing a hostile userId through the body must change nothing.
  const hostile = await registerDeviceKey(attacker.id, {
    deviceId: 'dev-hostile',
    kind: 'web',
    publicKey: pub(),
    // A hostile userId riding along in the payload. The service takes userId as
    // its FIRST parameter, from the auth result, so this is dropped on the floor.
    ...{ userId: victim.id },
  });
  eq('a userId in the payload does not move the row to another account',
    hostile.key.userId, attacker.id);
  eq('the victim gained no row from it',
    (await db.deviceKey.count({ where: { userId: victim.id, deviceId: 'dev-hostile' } })), 0);

  // ── 5. REVOKE cannot cross accounts ─────────────────────────────────────
  const victimLive = victimList.find((k) => k.revokedAt === null);
  check('the victim has a live row to attack', Boolean(victimLive));
  const cross = await revokeDeviceKey(attacker.id, victimLive.id);
  eq('revoking another user’s key fails', cross.ok, false);
  // 404, not 403: 403 would CONFIRM the row exists and turn this endpoint into
  // an oracle for enumerating other accounts' key ids.
  eq('…with 404, not 403 (no existence oracle)', cross.status, 404);
  const untouched = await db.deviceKey.findUnique({ where: { id: victimLive.id } });
  eq('the victim’s key is still live', untouched.revokedAt, null);

  eq('a completely unknown id is also 404', (await revokeDeviceKey(attacker.id, 'no-such-id')).status, 404);

  // The control: the SAME call by the rightful owner must SUCCEED. Without this,
  // "revoke fails" would be satisfied by a revoke that never works at all.
  const own = await revokeDeviceKey(victim.id, victimLive.id);
  eq('the owner CAN revoke their own key', own.ok, true);
  eq('…and it is not reported as already-revoked', own.alreadyRevoked, false);
  check('the row is now revoked',
    (await db.deviceKey.findUnique({ where: { id: victimLive.id } })).revokedAt instanceof Date);

  // Idempotence: revocation is a postcondition, and a retry after a dropped
  // response must not be told it failed — nor rewrite the audit timestamp.
  const firstAt = (await db.deviceKey.findUnique({ where: { id: victimLive.id } })).revokedAt;
  const twice = await revokeDeviceKey(victim.id, victimLive.id);
  eq('revoking twice is a SUCCESS', twice.ok, true);
  eq('…flagged as already revoked', twice.alreadyRevoked, true);
  eq('…and the original timestamp is not rewritten',
    (await db.deviceKey.findUnique({ where: { id: victimLive.id } })).revokedAt.getTime(),
    firstAt.getTime());

  // Revoking frees the (userId, deviceId) slot for a fresh registration.
  const reborn = await registerDeviceKey(victim.id, {
    deviceId: victimLive.deviceId, kind: victimLive.kind, publicKey: pub(),
  });
  eq('a revoked slot can be registered again', reborn.key.revokedAt, null);

  // ── 6. C-4: the cascade actually cascades ───────────────────────────────
  // No route deletes a User today (verified 2026-09-17 — see the résumé), so
  // this proves the MECHANISM that a future deletion route will rely on, rather
  // than a code path that exists.
  const doomed = await db.user.create({
    data: { email: `dk-doomed-${MARK}@example.invalid`, phoneToken: randomBytes(32).toString('base64url') },
    select: { id: true },
  });
  await registerDeviceKey(doomed.id, { deviceId: 'dev-d1', kind: 'phone', publicKey: pub() });
  await registerDeviceKey(doomed.id, { deviceId: 'dev-d2', kind: 'web', publicKey: pub() });
  eq('the doomed user has keys', await db.deviceKey.count({ where: { userId: doomed.id } }), 2);
  await db.user.delete({ where: { id: doomed.id } });
  eq('deleting the user deleted every key row (C-4 cascade)',
    await db.deviceKey.count({ where: { userId: doomed.id } }), 0);
  // …and took nobody else's rows with it.
  check('the other users’ rows are untouched',
    (await db.deviceKey.count({ where: { userId: attacker.id } })) > 0
    && (await db.deviceKey.count({ where: { userId: victim.id } })) > 0);

  // ── 7. drift guard: the real service/routes match what was tested ───────
  const svc = readFileSync(join(ROOT, 'lib', 'deviceKeys.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const auth = readFileSync(join(ROOT, 'lib', 'deviceKeyAuth.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty deviceKeys.ts', /registerDeviceKey/.test(svc));

  // publicKey is NEVER updated in place: no `update` call anywhere in the
  // service passes it. An in-place key mutation is the one thing N-4 forbids,
  // because it erases the evidence of a substitution.
  const updates = svc.match(/\.update\(\{[\s\S]*?\}\)/g) || [];
  check('the service performs updates (scan is not vacuous)', updates.length >= 3);
  check('NO update() call touches publicKey', updates.every((u) => !/publicKey/.test(u)));

  check('rotation is transactional', /\$transaction\(/.test(svc));
  check('list filters by the caller userId', /findMany\(\{\s*where:\s*\{\s*userId/.test(svc));
  check('revoke looks up by id AND userId in ONE query', /findFirst\(\{\s*where:\s*\{\s*id,\s*userId\s*\}/.test(svc));
  check('a foreign row is 404, never 403', /status:\s*404,\s*error:\s*'not_found'/.test(svc) && !/status:\s*403/.test(svc));

  check('the auth module reads the session', /validateSessionWithIdle\(req\)/.test(auth));
  check('the auth module resolves a phone token by phoneToken', /where:\s*\{\s*phoneToken:\s*bearer\s*\}/.test(auth));
  check('the auth module never reads a body', !/req\.json\(\)|\.body\b/.test(auth));

  for (const route of ['register', 'list', 'revoke']) {
    const src = readFileSync(join(ROOT, 'app', 'api', 'devicekeys', route, 'route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    check(`${route}: takes its userId from resolveCaller`, /resolveCaller\(req\)/.test(src));
    check(`${route}: passes caller.userId to the service`, /caller\.userId/.test(src));
    // THE assertion. A route that ever reads a userId out of the request is the
    // bug B8 exists to prevent, and it would look almost exactly like this one.
    check(`${route}: NEVER reads a userId from the request`,
      !/(body|input|params|searchParams)[^\n]*\buserId\b/.test(src)
      && !/\buserId\s*[:=]\s*(input|body)\./.test(src));
  }
  const registerSrc = readFileSync(join(ROOT, 'app', 'api', 'devicekeys', 'register', 'route.ts'), 'utf8');
  check('register returns 409 while a pairing handshake is in flight',
    /__relayPairingInFlight/.test(registerSrc) && /status:\s*409/.test(registerSrc));
}

main()
  .catch((e) => { failed++; console.error(`  FAIL  threw — ${e.stack}`); })
  .finally(async () => {
    try {
      for (const u of [attacker, victim]) {
        if (!u) continue;
        await db.deviceKey.deleteMany({ where: { userId: u.id } });
        await db.user.delete({ where: { id: u.id } });
      }
    } catch (e) { console.error(`  warn  cleanup failed: ${e.message}`); }
    await db.$disconnect().catch(() => {});
    const total = passed + failed;
    console.log(`devicekey-authz: ${passed} passed, ${failed} failed (${total} checks)`);
    process.exit(failed === 0 ? 0 : 1);
  });
