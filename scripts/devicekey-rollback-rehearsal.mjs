#!/usr/bin/env node
/**
 * scripts/devicekey-rollback-rehearsal.mjs — P1(e) / mi-7.
 *
 * THE QUESTION THIS ANSWERS. We are about to add a table to a production
 * database. If the deploy has to be rolled back afterwards, the table and its
 * rows STAY — you do not drop a table to undo an app deploy. So the real
 * question is not "can we drop it" but:
 *
 *     with "DeviceKey" present and populated, does the OLD relay still work?
 *
 * "Obviously yes, it never reads that table" is a plausible answer and not an
 * acceptable one. Prisma clients are generated artefacts with opinions about
 * the schema they were built from, `prisma db push` has been known to notice
 * drift, and the whole point of a rehearsal is to find out BEFORE prod that the
 * obvious answer was wrong. So this script actually runs the old relay.
 *
 * WHAT IT DOES:
 *   1. Asserts the migration is applied (the table exists).
 *   2. Seeds a user and inserts ORPHAN DeviceKey rows — including a revoked one,
 *      so the partial unique index is populated too, not just the table.
 *   3. Materialises BASE_SHA's server.js and its core libs into a scratch dir
 *      under node_modules/ (invisible to git, and node resolution still finds
 *      `ws` / `@prisma/client` by walking up).
 *   4. Boots that OLD relay for real, against the MIGRATED database. Next.js is
 *      stubbed — the relay is what is under test, and building a whole Next app
 *      for a rollback rehearsal would test the bundler, not the rollback.
 *   5. Drives a complete v55-style PLAINTEXT pairing over WebSocket: phone joins
 *      /relay/phone, browser joins /relay, BROWSER_REQUEST_PAIRING,
 *      ACCEPT_PAIRING, and both sides must receive PAIRING_ACTIVE.
 *   6. Asserts the PAIRING_ACTIVE payloads carry NO `e2e` field — the old code
 *      must produce the old shape, which is what "rolled back" means.
 *   7. Asserts the orphan rows are still there, byte-identical, untouched.
 *
 * It cleans up after itself: the scratch dir is removed, the seeded rows are
 * deleted, and the child process is killed, in a finally block, so a failure
 * mid-run does not leave a dirty worktree or a bound port.
 *
 * Run:
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc \
 *   JWT_SECRET=<anything> node scripts/devicekey-rollback-rehearsal.mjs
 *
 * PROD pg_dump + scratch-restore with row counts is KEN'S step, not this one.
 * This proves the code half locally; it does not touch production.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);

/** The commit whose relay we are rolling back TO (e2e/BASE.md). */
const BASE_SHA = '445138a6c58c12b2848cb4c24371b0d443e51c27';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!process.env.DATABASE_URL) {
  console.error('devicekey-rollback-rehearsal: DATABASE_URL is required (use the ccpix harness DB, never prod).');
  process.exit(2);
}
if (/computercaller\.com|prod/i.test(process.env.DATABASE_URL)) {
  console.error('devicekey-rollback-rehearsal: refusing to run against what looks like production.');
  process.exit(2);
}
const JWT_SECRET = process.env.JWT_SECRET || 'rollback-rehearsal-secret';

const { PrismaClient } = requireCjs(join(ROOT, 'node_modules', '@prisma', 'client'));
const { WebSocket } = requireCjs(join(ROOT, 'node_modules', 'ws'));
const db = new PrismaClient();

const SCRATCH = join(ROOT, 'node_modules', '.cache', 'devicekey-rollback');
const MARK = randomBytes(6).toString('hex');
const EMAIL = `rollback-rehearsal-${MARK}@example.invalid`;
const PHONE_TOKEN = randomBytes(32).toString('base64url');

let child = null;
let userId = null;

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a relay socket and collect every frame it receives. */
function connect(port, path) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.frames = [];
  ws.on('message', (d) => ws.frames.push(d.toString()));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout opening ${path}`)), 10_000);
    ws.once('open', () => { clearTimeout(t); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Wait until `ws` has received a frame with this prefix, or time out. */
async function waitFrame(ws, prefix, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ws.frames.find((f) => f.startsWith(prefix));
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

try {
  // ── 1. the migration is applied ─────────────────────────────────────────
  const tables = await db.$queryRawUnsafe(
    `SELECT to_regclass('public."DeviceKey"') IS NOT NULL AS present`,
  );
  check('the DeviceKey table exists (migration applied)', tables[0]?.present === true);
  const idx = await db.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'DeviceKey' AND indexname = 'DeviceKey_userId_deviceId_live_key'`,
  );
  check('the PARTIAL unique index exists', idx.length === 1);
  check('…and it really is partial (WHERE revokedAt IS NULL)',
    /WHERE .*revokedAt.* IS NULL/i.test(idx[0]?.indexdef ?? ''), idx[0]?.indexdef);

  // ── 2. seed a user and ORPHAN key rows ──────────────────────────────────
  const user = await db.user.create({
    data: { email: EMAIL, phoneToken: PHONE_TOKEN, emailVerified: true },
    select: { id: true },
  });
  userId = user.id;

  const pub = () => {
    const b = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]);
    return b.toString('base64url');
  };
  const live = await db.deviceKey.create({
    data: { userId, deviceId: `dev-live-${MARK}`, kind: 'phone', publicKey: pub(), label: 'orphan live' },
  });
  const revoked = await db.deviceKey.create({
    data: {
      userId, deviceId: `dev-rot-${MARK}`, kind: 'web', publicKey: pub(),
      label: 'orphan revoked', revokedAt: new Date(),
    },
  });
  // A second LIVE row for the same deviceId as the revoked one — this is the
  // rotation shape, and it must be permitted. If the unique index were not
  // partial, this insert would fail and the migration would be wrong.
  const rotatedIn = await db.deviceKey.create({
    data: { userId, deviceId: `dev-rot-${MARK}`, kind: 'web', publicKey: pub(), label: 'orphan rotated-in' },
  });
  check('a rotation (revoked + live for one deviceId) is permitted', Boolean(rotatedIn.id));

  // …and a SECOND live row for the same deviceId must be REFUSED.
  let duplicateRefused = false;
  try {
    await db.deviceKey.create({
      data: { userId, deviceId: `dev-rot-${MARK}`, kind: 'web', publicKey: pub() },
    });
  } catch { duplicateRefused = true; }
  check('a second LIVE key for one deviceId is refused by the partial index', duplicateRefused);

  const before = await db.deviceKey.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  check('three orphan rows are in place', before.length === 3, `got ${before.length}`);

  // ── 3. materialise BASE_SHA's relay ─────────────────────────────────────
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, 'lib'), { recursive: true });
  mkdirSync(join(SCRATCH, 'node_modules', 'next'), { recursive: true });

  const show = (p) => execFileSync('git', ['show', `${BASE_SHA}:${p}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(SCRATCH, 'server.js'), show('server.js'));
  // Every plain-JS core module at BASE_SHA, not just the three server.js names
  // directly: they require each other, and a partial copy fails at boot with a
  // MODULE_NOT_FOUND that looks like a rollback problem and is not one.
  const libFiles = execFileSync('git', ['ls-tree', '--name-only', BASE_SHA, 'lib/'], { cwd: ROOT })
    .toString('utf8').split(/\r?\n/).filter((f) => f.endsWith('.js'));
  check('BASE_SHA core libs found', libFiles.length >= 3, `got ${libFiles.length}`);
  for (const f of libFiles) {
    writeFileSync(join(SCRATCH, 'lib', f.slice('lib/'.length)), show(f));
  }
  check('BASE_SHA server.js materialised', existsSync(join(SCRATCH, 'server.js')));
  // Sanity: the OLD relay must not already know about e2e. If it did, this
  // whole rehearsal would be testing the new code with extra steps.
  const oldSrc = show('server.js').toString('utf8');
  check('the BASE_SHA relay has no e2e block handling', !/validateE2eBlock|room\.active\.e2e/.test(oldSrc));
  check('the BASE_SHA relay still has logNotifLifecycle (proves we got the OLD file)',
    /function logNotifLifecycle\(/.test(oldSrc));

  // Next.js stub. The relay is what is under test; building a Next app to prove
  // a database rollback would be testing the bundler.
  writeFileSync(join(SCRATCH, 'node_modules', 'next', 'package.json'),
    JSON.stringify({ name: 'next', version: '0.0.0-rehearsal-stub', main: 'index.js' }));
  writeFileSync(join(SCRATCH, 'node_modules', 'next', 'index.js'), `
module.exports = function next() {
  return {
    prepare: async () => {},
    getRequestHandler: () => (req, res) => { res.statusCode = 404; res.end('next stubbed for rollback rehearsal'); },
  };
};
`);

  // ── 4. boot the OLD relay against the MIGRATED database ─────────────────
  const port = await freePort();
  child = spawn(process.execPath, [join(SCRATCH, 'server.js')], {
    cwd: SCRATCH,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d.toString(); });
  child.stderr.on('data', (d) => { bootLog += d.toString(); });

  const bootDeadline = Date.now() + 40_000;
  let up = false;
  while (Date.now() < bootDeadline && !up) {
    if (child.exitCode !== null) break;
    try {
      const probe = await connect(port, `/relay?token=${PHONE_TOKEN}`);
      probe.close();
      up = true;
    } catch { await sleep(300); }
  }
  check('the BASE_SHA relay booted against the migrated DB', up,
    up ? '' : `exit=${child.exitCode} log=${bootLog.slice(-600)}`);
  if (!up) throw new Error('old relay did not come up');

  // ── 5. a v55-style PLAINTEXT pairing, end to end ────────────────────────
  const phone = await connect(port, `/relay/phone?token=${PHONE_TOKEN}`);
  await sleep(300);
  const browser = await connect(port, `/relay?token=${PHONE_TOKEN}`);
  await sleep(300);

  browser.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify({ ua: 'rehearsal', deviceLabel: 'Rehearsal' })}`);
  const request = await waitFrame(phone, 'PAIRING_REQUEST:');
  check('the phone received PAIRING_REQUEST', Boolean(request), bootLog.slice(-400));
  if (!request) throw new Error('no PAIRING_REQUEST');

  const { pairingId } = JSON.parse(request.slice('PAIRING_REQUEST:'.length));
  phone.send(`ACCEPT_PAIRING:${JSON.stringify({ pairingId })}`);

  const browserActive = await waitFrame(browser, 'PAIRING_ACTIVE:');
  const phoneActive = await waitFrame(phone, 'PAIRING_ACTIVE:');
  check('the browser went ACTIVE', Boolean(browserActive));
  check('the phone went ACTIVE', Boolean(phoneActive));

  // 6. the OLD shape — this is what "rolled back" has to mean.
  if (browserActive && phoneActive) {
    const bp = JSON.parse(browserActive.slice('PAIRING_ACTIVE:'.length));
    const pp = JSON.parse(phoneActive.slice('PAIRING_ACTIVE:'.length));
    check('browser PAIRING_ACTIVE carries NO e2e field', !('e2e' in bp), JSON.stringify(bp));
    check('phone PAIRING_ACTIVE carries NO e2e field', !('e2e' in pp), JSON.stringify(pp));
    check('browser PAIRING_ACTIVE still carries deviceName', 'deviceName' in bp);
    check('phone PAIRING_ACTIVE still carries ua/ip', 'ua' in pp && 'ip' in pp);
  }

  phone.close();
  browser.close();
  await sleep(200);

  // ── 7. the orphan rows are untouched ────────────────────────────────────
  const after = await db.deviceKey.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  check('the orphan rows survived the old relay run', after.length === before.length,
    `${before.length} -> ${after.length}`);
  check('every orphan row is byte-identical',
    JSON.stringify(after) === JSON.stringify(before));
  check('the revoked row kept its revokedAt',
    after.find((r) => r.id === revoked.id)?.revokedAt?.getTime() === revoked.revokedAt.getTime());
  check('the live row is still live', after.find((r) => r.id === live.id)?.revokedAt === null);
  check('the old relay logged no DeviceKey error', !/DeviceKey/i.test(bootLog), bootLog.slice(-300));
} catch (e) {
  failed++;
  console.error(`  FAIL  rehearsal threw — ${e.message}`);
} finally {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
  try {
    if (userId) {
      await db.deviceKey.deleteMany({ where: { userId } });
      await db.user.delete({ where: { id: userId } });
    }
  } catch (e) { console.error(`  warn  cleanup of seeded rows failed: ${e.message}`); }
  await db.$disconnect().catch(() => {});
  // The scratch dir lives under node_modules/ so git never sees it, but leaving
  // it would still be litter — and a stale copy of an old server.js is exactly
  // the kind of thing someone later runs by accident.
  rmSync(SCRATCH, { recursive: true, force: true });
}

const total = passed + failed;
console.log(`devicekey-rollback-rehearsal: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
