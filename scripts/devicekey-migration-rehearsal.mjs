#!/usr/bin/env node
/**
 * scripts/devicekey-migration-rehearsal.mjs — E2E-P1.3 (c).
 *
 * Proves, against a THROWAWAY database, that D1 step 4 (`prisma migrate
 * deploy`) does what the runbook says it does:
 *
 *   1. the 15 pre-DeviceKey tables are STRUCTURALLY IDENTICAL before and after
 *      — every column, type, nullability, default, index and constraint
 *      compared, not merely the table count;
 *   2. `DeviceKey` arrives, EMPTY;
 *   3. the PARTIAL unique index arrives and actually ENFORCES — a second live
 *      row for one (userId, deviceId) is rejected, and a REVOKED duplicate is
 *      still accepted (the half a plain unique index would break);
 *   4. rollback (`DROP INDEX`) restores the pre-index state, loses no rows, and
 *      genuinely removes the invariant; re-applying over a duplicate REFUSES
 *      loudly, and succeeds once the duplicate is settled;
 *   5. `prisma db push` does NOT produce that index — the claim this whole
 *      letter rests on, DEMONSTRATED rather than asserted.
 *
 * SAFETY. Everything destructive runs against databases this script creates and
 * drops itself, whose names are fixed constants. It refuses to start if the
 * resolved target is not one of them, or if the source URL looks like
 * production. It never touches the harness database `cc`.
 *
 * Run:
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc \
 *     node scripts/devicekey-migration-rehearsal.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireCjs = createRequire(import.meta.url);
// PrismaClient rather than `pg`: `pg` is not a dependency of this project, and
// a rehearsal script is not a reason to grow the lockfile. The generated client
// accepts a per-instance datasource URL, which is all this needs.
const { PrismaClient } = requireCjs(join(ROOT, 'node_modules', '@prisma', 'client'));

const SCRATCH_DB = 'cc_p13_migration_rehearsal';
const PUSH_DB = 'cc_p13_pushcontrol';
/** The migration that introduces DeviceKey. Everything before it is "the 15". */
const DEVICEKEY_MIGRATION = '20260917120000_add_device_keys';
const LIVE_INDEX = 'DeviceKey_userId_deviceId_live_key';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, a, b) => check(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const base = process.env.DATABASE_URL;
if (!base) {
  console.error('rehearsal: DATABASE_URL is required (the ccpix harness URL; scratch DBs are derived from it).');
  process.exit(2);
}
const urlFor = (dbName) => { const u = new URL(base); u.pathname = `/${dbName}`; return u.toString(); };

// ── the guard. Nothing below may run against a database we did not name. ────
{
  if (/prod|production/i.test(base)) {
    console.error('rehearsal: REFUSING — the source URL looks like production.');
    process.exit(2);
  }
  for (const name of [SCRATCH_DB, PUSH_DB]) {
    if (new URL(urlFor(name)).pathname.slice(1) !== name) {
      console.error(`rehearsal: REFUSING — could not pin the target database name for "${name}".`);
      process.exit(2);
    }
  }
  const sourceDb = new URL(base).pathname.slice(1);
  if (sourceDb === SCRATCH_DB || sourceDb === PUSH_DB) {
    console.error('rehearsal: REFUSING — DATABASE_URL already points at a scratch database.');
    process.exit(2);
  }
}

/**
 * Run SQL against an arbitrary database URL. `params` are passed positionally
 * to `$queryRawUnsafe`, so `$1`-style placeholders stay parameterised — the
 * only strings interpolated into SQL anywhere in this file are the two database
 * names and the index name, all module-level constants.
 */
const q = async (url, sql, params = []) => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  try { return await db.$queryRawUnsafe(sql, ...params); } finally { await db.$disconnect(); }
};
/** For statements that return no rows (CREATE/DROP DATABASE, DDL, DELETE). */
const exec = async (url, sql, params = []) => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  try { return await db.$executeRawUnsafe(sql, ...params); } finally { await db.$disconnect(); }
};

/**
 * A full structural fingerprint of the public schema: columns with types,
 * nullability and defaults, plus every index definition and every constraint.
 * A table-NAME count would pass while a column silently changed type, which is
 * the failure a migration rehearsal exists to catch.
 */
async function fingerprint(url) {
  const cols = await q(url, `
    SELECT table_name, column_name, data_type, is_nullable, column_default,
           character_maximum_length, numeric_precision, datetime_precision
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, column_name`);
  const idx = await q(url, `
    SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' ORDER BY tablename, indexname`);
  const cons = await q(url, `
    SELECT rel.relname AS tablename, con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' ORDER BY rel.relname, con.conname`);
  const byTable = new Map();
  const put = (t, kind, row) => {
    if (!byTable.has(t)) byTable.set(t, { columns: [], indexes: [], constraints: [] });
    byTable.get(t)[kind].push(row);
  };
  for (const r of cols) put(r.table_name, 'columns', r);
  for (const r of idx) put(r.tablename, 'indexes', { indexname: r.indexname, indexdef: r.indexdef });
  for (const r of cons) put(r.tablename, 'constraints', { conname: r.conname, def: r.def });
  return byTable;
}
const tableJson = (fp, t) => JSON.stringify(fp.get(t) ?? null);

/**
 * A prisma/ directory whose schema.prisma has the DeviceKey model (and the
 * relation field pointing at it) REMOVED — the shape the database had before
 * E2E-P1 landed. Used with `db push` to build the prod-shaped baseline.
 */
function stagedPreDeviceKeyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'p13-prisma-'));
  cpSync(join(ROOT, 'prisma'), join(dir, 'prisma'), { recursive: true });
  const schemaPath = join(dir, 'prisma', 'schema.prisma');
  // LF-normalised FIRST. core.autocrlf=true checks this file out with CRLF, and
  // every `\n`-anchored pattern below then matches nothing — the strip silently
  // does nothing and the baseline quietly includes DeviceKey. Prisma is happy
  // with LF either way.
  let schema = readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');
  const before = schema;
  schema = schema.replace(/\n?model DeviceKey \{[\s\S]*?\n\}\n/, '\n');
  schema = schema.replace(/^\s*deviceKeys\s+DeviceKey\[\].*$\n/m, '');
  // Tested against CODE only. schema.prisma carries a long comment block ABOUT
  // DeviceKey that must survive — a bare /DeviceKey/ test matches that prose and
  // reports failure on a correct strip, which is a guard people learn to delete.
  const code = schema.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (schema === before || /DeviceKey/.test(code)) {
    throw new Error('rehearsal: could not strip the DeviceKey model from schema.prisma — '
      + 'the baseline would silently INCLUDE DeviceKey and the whole comparison would be vacuous');
  }
  writeFileSync(schemaPath, schema);
  return { dir, schemaPath };
}

/**
 * The Prisma CLI, invoked as a JS entrypoint rather than through `npx`.
 * `execFileSync('npx.cmd', …)` fails with EINVAL on modern Node for Windows
 * (a .cmd needs a shell), and `shell: true` would mean quoting a path that
 * contains spaces — so this spawns node on the CLI's own `bin` target instead.
 * No shell, no quoting, same binary.
 */
const PRISMA_CLI = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const prisma = (args, env) => execFileSync(
  process.execPath, [PRISMA_CLI, ...args],
  { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' },
);

const ALL = readdirSync(join(ROOT, 'prisma', 'migrations'))
  .filter((e) => e !== 'migration_lock.toml').sort();
const BEFORE_SET = ALL.filter((m) => m < DEVICEKEY_MIGRATION);

const staged = [];
async function cleanup() {
  for (const d of staged) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  for (const name of [SCRATCH_DB, PUSH_DB]) {
    try { await exec(urlFor('postgres'), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
    catch (e) { console.error(`  (cleanup) could not drop ${name}: ${e.message}`); }
  }
}

try {
  console.log('\nE2E-P1.3 (c) — DeviceKey partial-unique migration rehearsal');
  console.log(`  scratch databases: ${SCRATCH_DB}, ${PUSH_DB}  (created and dropped by this script)`);
  console.log(`  migrations before DeviceKey: ${BEFORE_SET.length}\n`);

  await exec(urlFor('postgres'), `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await exec(urlFor('postgres'), `CREATE DATABASE "${SCRATCH_DB}"`);
  const SCRATCH_URL = urlFor(SCRATCH_DB);

  // ── 1. the prod-shaped baseline ──────────────────────────────────────────
  /**
   * NOT `migrate deploy` from empty — and finding out WHY is the first result
   * of this rehearsal.
   *
   * The repo's migration history is NOT self-contained. Its earliest entry,
   * 20260524120000_add_session_version, ALTERs "User", and NO migration in the
   * folder ever creates "User". The original schema was built with `db push`
   * and migrations only start from 2026-05-24. So `prisma migrate deploy`
   * against an EMPTY database fails immediately with
   * `relation "User" does not exist` (P3018) — it cannot bootstrap this
   * project at all, and never could.
   *
   * That makes the faithful baseline the one prod actually has: a pushed
   * schema, plus a `_prisma_migrations` ledger that has been BASELINED with
   * `migrate resolve --applied`. Building it that way here means this script
   * rehearses the real D1 step 4 rather than a greenfield one that will never
   * be run.
   */
  console.log('-- baseline: `db push` of the PRE-DeviceKey schema, then baselined --');
  const { dir: dirBefore, schemaPath: schemaBefore } = stagedPreDeviceKeyDir();
  staged.push(dirBefore);
  prisma(['db', 'push', '--schema', schemaBefore, '--skip-generate', '--accept-data-loss'],
    { DATABASE_URL: SCRATCH_URL });
  // Baseline: mark the 13 historical migrations applied WITHOUT running them.
  for (const m of BEFORE_SET) {
    prisma(['migrate', 'resolve', '--applied', m], { DATABASE_URL: SCRATCH_URL });
  }
  const ledger = await q(SCRATCH_URL,
    'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
  eq('baselining recorded every historical migration as applied', ledger.length, BEFORE_SET.length);
  const fpBefore = await fingerprint(SCRATCH_URL);
  const tablesBefore = [...fpBefore.keys()].filter((t) => t !== '_prisma_migrations').sort();
  eq('baseline has the 15 pre-DeviceKey tables', tablesBefore.length, 15);
  check('baseline has NO DeviceKey table', !tablesBefore.includes('DeviceKey'));

  // ── 2. deploy the rest — DeviceKey + this letter's migration ─────────────
  console.log('\n-- deploy: DeviceKey + the partial-unique migration --');
  const out = prisma(['migrate', 'deploy'], { DATABASE_URL: SCRATCH_URL });
  check('migrate deploy succeeded', /applied|in sync|No pending/i.test(out), out.slice(-300));

  const fpAfter = await fingerprint(SCRATCH_URL);
  const tablesAfter = [...fpAfter.keys()].filter((t) => t !== '_prisma_migrations').sort();

  // ── 3. THE CLAIM: the 15 are untouched, structurally ─────────────────────
  let drifted = 0;
  for (const t of tablesBefore) {
    if (tableJson(fpBefore, t) !== tableJson(fpAfter, t)) {
      drifted += 1;
      console.error(`  FAIL  "${t}" changed across the deploy`);
    }
  }
  eq('all 15 pre-existing tables are structurally IDENTICAL before and after', drifted, 0);
  // A comparison that inspected nothing would also report zero drift.
  check('…and the comparison is not vacuous (columns, indexes and constraints were read)',
    tablesBefore.length === 15
    && (fpBefore.get('User')?.columns.length ?? 0) > 5
    && (fpBefore.get('User')?.indexes.length ?? 0) >= 1
    && (fpBefore.get('Subscription')?.constraints.length ?? 0) >= 1);
  check('DeviceKey is now present', tablesAfter.includes('DeviceKey'));
  eq('…and nothing else appeared', tablesAfter.length, 16);
  const [{ count }] = await q(SCRATCH_URL, 'SELECT COUNT(*)::int AS count FROM "DeviceKey"');
  eq('DeviceKey is EMPTY', count, 0);

  // ── 4. the index, and whether it ENFORCES ────────────────────────────────
  console.log('\n-- the invariant --');
  const idxRows = await q(SCRATCH_URL,
    'SELECT indexdef FROM pg_indexes WHERE indexname = $1', [LIVE_INDEX]);
  eq('the partial unique index exists', idxRows.length, 1);
  const def = idxRows[0]?.indexdef ?? '';
  check('…and it is genuinely PARTIAL (a WHERE clause), not a plain unique',
    /WHERE \("revokedAt" IS NULL\)/.test(def), def);
  check('…and UNIQUE', /CREATE UNIQUE INDEX/.test(def), def);

  const uid = `p13-rehearsal-${Date.now()}`;
  // `updatedAt` is @updatedAt — Prisma fills it, raw SQL does not, and the
  // column is NOT NULL. Named explicitly rather than letting a 23502 teach it.
  await exec(SCRATCH_URL,
    'INSERT INTO "User" (id, email, "phoneToken", "updatedAt") VALUES ($1, $2, $3, NOW())',
    [uid, `${uid}@example.invalid`, uid]);
  const ins = (id, revoked) => exec(SCRATCH_URL,
    `INSERT INTO "DeviceKey" (id,"userId","deviceId",kind,"publicKey","revokedAt")
     VALUES ($1,$2,'dev-1','web','k',${revoked ? 'NOW()' : 'NULL'})`, [id, uid]);

  await ins('rehearse-live-1', false);
  // 23505 = unique_violation. Matched on the SQLSTATE, not on the word
  // "unique": Prisma wraps a raw failure as "Raw query failed. Code: `23505`"
  // and the word never appears, so a /unique/i test reports NOT-REJECTED on a
  // correctly-enforcing index — which is exactly what the first run of this
  // script did. Widened, and the two other outcomes are distinguished so a
  // future failure says which one happened.
  let rejection = 'not rejected at all';
  try { await ins('rehearse-live-2', false); }
  catch (e) {
    rejection = /23505|unique/i.test(e.message) ? 'unique_violation' : `other error: ${e.message.slice(0, 120)}`;
  }
  eq('ENFORCES: a SECOND live row for the same (userId, deviceId) is REJECTED',
    rejection, 'unique_violation');
  let revokedOk = true;
  try { await ins('rehearse-revoked-1', true); await ins('rehearse-revoked-2', true); }
  catch (e) { revokedOk = false; console.error(`        ${e.message}`); }
  check('…and REVOKED duplicates are still ACCEPTED (rotation history accumulates)', revokedOk);

  // ── 5. rollback, and re-apply ────────────────────────────────────────────
  console.log('\n-- rollback --');
  const [{ c: rowsBefore }] = await q(SCRATCH_URL, 'SELECT COUNT(*)::int AS c FROM "DeviceKey"');
  await exec(SCRATCH_URL, `DROP INDEX IF EXISTS "${LIVE_INDEX}"`);
  const gone = await q(SCRATCH_URL, 'SELECT 1 FROM pg_indexes WHERE indexname = $1', [LIVE_INDEX]);
  eq('rollback removes the index', gone.length, 0);
  const [{ c: rowsAfter }] = await q(SCRATCH_URL, 'SELECT COUNT(*)::int AS c FROM "DeviceKey"');
  eq('rollback loses NO rows (an index holds none)', rowsAfter, rowsBefore);
  // The NEGATIVE CONTROL for step 4: if a second live row is still rejected
  // after the drop, then step 4's rejection was never the index's doing.
  let nowAllowed = true;
  try { await ins('rehearse-live-3', false); } catch { nowAllowed = false; }
  check('…and the invariant is genuinely GONE (negative control for the ENFORCES check)', nowAllowed);

  const reapply = () => exec(SCRATCH_URL, `CREATE UNIQUE INDEX IF NOT EXISTS "${LIVE_INDEX}"
    ON "DeviceKey"("userId","deviceId") WHERE "revokedAt" IS NULL`);
  let reapplyRefused = false;
  try { await reapply(); } catch (e) { reapplyRefused = /could not create unique index|duplicate/i.test(e.message); }
  check('re-applying over a duplicate REFUSES loudly (README case 2)', reapplyRefused);

  await exec(SCRATCH_URL, 'DELETE FROM "DeviceKey" WHERE id = $1', ['rehearse-live-3']);
  await reapply();
  const back = await q(SCRATCH_URL, 'SELECT 1 FROM pg_indexes WHERE indexname = $1', [LIVE_INDEX]);
  eq('…and re-applies cleanly once the duplicate is settled', back.length, 1);
  let idempotent = true;
  try { await reapply(); } catch { idempotent = false; }
  check('the migration statement is IDEMPOTENT (runs twice, no error)', idempotent);

  // ── 6. db push does NOT produce it — the claim this letter rests on ──────
  console.log('\n-- negative control: `prisma db push` on a clean database --');
  await exec(urlFor('postgres'), `DROP DATABASE IF EXISTS "${PUSH_DB}" WITH (FORCE)`);
  await exec(urlFor('postgres'), `CREATE DATABASE "${PUSH_DB}"`);
  prisma(['db', 'push', '--skip-generate', '--accept-data-loss'], { DATABASE_URL: urlFor(PUSH_DB) });
  const pushed = await q(urlFor(PUSH_DB),
    'SELECT indexname FROM pg_indexes WHERE tablename = $1', ['DeviceKey']);
  const names = pushed.map((r) => r.indexname);
  check('db push DID create the DeviceKey table and its plain indexes',
    names.length > 0, JSON.stringify(names));
  check('…and did NOT create the partial unique index (the whole reason this migration exists)',
    !names.includes(LIVE_INDEX), JSON.stringify(names));
  const mig = await q(urlFor(PUSH_DB),
    "SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations'");
  eq('…and left no _prisma_migrations ledger (how you recognise a pushed database)', mig.length, 0);

  // ── 7. devicekey-authz, on BOTH databases ───────────────────────────────
  /**
   * This is the check that closes D1-PREP's (d) hold with evidence instead of
   * an assertion. That lane reported "61/61 ONLY because the scratch DB carries
   * a hand-added partial unique index; on Ken's step-4 prod table it is 60/61".
   *
   * So the suite is run TWICE: once against the MIGRATED database (index
   * present) and once against the PUSHED one (index absent). The migrated run
   * must be clean and the pushed run must NOT be — a pushed run that also came
   * back green would mean the suite never tested the invariant at all, and the
   * whole letter would be unnecessary.
   */
  console.log('\n-- devicekey-authz on both databases --');
  const runAuthz = (url) => {
    const r = execFileSync(process.execPath, [join(ROOT, 'tests', 'devicekey-authz.test.mjs')],
      { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe' });
    return r;
  };
  let migratedOut = '';
  let migratedOk = false;
  try { migratedOut = runAuthz(SCRATCH_URL); migratedOk = true; }
  catch (e) { migratedOut = `${e.stdout || ''}${e.stderr || ''}`; }
  console.log(`     migrated: ${migratedOut.trim().split('\n').pop()}`);
  check('devicekey-authz is CLEAN against the migrated database (exit 0)', migratedOk,
    migratedOut.slice(-400));
  check('…and it reported a count (the run is not vacuous)', /devicekey-authz:/.test(migratedOut),
    migratedOut.slice(-200));

  let pushedOut = '';
  let pushedOk = false;
  try { pushedOut = runAuthz(urlFor(PUSH_DB)); pushedOk = true; }
  catch (e) { pushedOut = `${e.stdout || ''}${e.stderr || ''}`; }
  console.log(`     pushed:   ${pushedOut.trim().split('\n').pop()}`);
  // THE NEGATIVE CONTROL. If this also passes, the suite is not testing the
  // index, and D1-PREP's hold was about nothing.
  check('devicekey-authz FAILS against the pushed database (no partial index) — '
    + 'the negative control that proves the suite tests the invariant', !pushedOk,
    pushedOut.slice(-400));

  console.log(`\ndevicekey-migration-rehearsal: ${passed} passed, ${failed} failed (${passed + failed} checks)`);
} finally {
  await cleanup();
}
process.exit(failed === 0 ? 0 : 1);
