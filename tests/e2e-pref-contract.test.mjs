#!/usr/bin/env node
/**
 * tests/e2e-pref-contract.test.mjs — T-E2E-ACCOUNT-PREF step 1, RULE 30 (node).
 *
 * Drives the REAL lib/e2ePref-core.js (not a mirror) over the language-neutral
 * tests/e2e-pref-vectors.json — the same file the android lane's Kotlin twin
 * will read in step 2 — plus the ordering/guard properties the design and the
 * Security design read (M2, M3, m1, m3) put on the write path.
 *
 * Pure: no database, no network. The SAME change/seed rows are replayed against
 * the real conditional UPDATE in Postgres by scripts/e2e-pref-relay-proof.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const core = requireCjs(join(ROOT, 'lib', 'e2ePref-core.js'));
const V = JSON.parse(readFileSync(join(HERE, 'e2e-pref-vectors.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const j = (x) => JSON.stringify(x);

const toRow = (r) => ({ e2ePref: r.e2ePref, e2ePrefRev: r.rev, e2ePrefUpdatedAt: null, e2ePrefUpdatedBy: null });

// ── 1. vector file shape ────────────────────────────────────────────────────
check('vectors: 12 resolve rows (3 rows x 2 master x 2 default)', V.resolve.length === 12, V.resolve.length);
check('vectors: 5 seed rows', V.seed.length === 5, V.seed.length);
check('vectors: 24 change rows', V.change.length === 24, V.change.length);
check("vectors: the brief's 6 named CHANGE rows are present", V.change.filter((r) => r.named).length === 6);
check('vectors: ids are unique',
  new Set([...V.resolve, ...V.seed, ...V.change].map((r) => r.id)).size === 41);

// ── 2. resolution (§3) ──────────────────────────────────────────────────────
for (const r of V.resolve) {
  const got = core.resolveE2ePref(toRow(r.row), { masterEnabled: r.masterEnabled, defaultOn: r.defaultOn });
  for (const k of ['preference', 'effective', 'pausedByServer', 'rev']) {
    check(`${r.id}: ${k}`, got[k] === r.expect[k], `expected ${j(r.expect[k])}, got ${j(got[k])}`);
  }
}
{
  // A row-less account (findUnique -> null) resolves exactly like a null pref.
  const got = core.resolveE2ePref(null, { masterEnabled: true, defaultOn: false });
  check('null row: preference off, rev 0, no updatedAt/By',
    got.preference === 'off' && got.rev === 0 && got.updatedAt === null && got.updatedBy === null, j(got));
  const iso = core.resolveE2ePref(
    { e2ePref: true, e2ePrefRev: 3, e2ePrefUpdatedAt: new Date('2026-09-25T09:00:00Z'), e2ePrefUpdatedBy: 'web' },
    { masterEnabled: true, defaultOn: false });
  check('updatedAt is ISO-8601 UTC, updatedBy passes through',
    iso.updatedAt === '2026-09-25T09:00:00.000Z' && iso.updatedBy === 'web', j(iso));
  // The frame body is EXACTLY the six resolved fields — nothing a client could
  // mistake for authority beyond them (no userId, no token).
  const frame = core.e2ePrefFrame(iso);
  check('E2E_PREF frame = "E2E_PREF:" + the six resolved fields',
    frame.startsWith('E2E_PREF:')
    && j(Object.keys(JSON.parse(frame.slice('E2E_PREF:'.length))).sort())
      === j(['effective', 'pausedByServer', 'preference', 'rev', 'updatedAt', 'updatedBy']), frame);
}

// ── 3. change decision (§4) ─────────────────────────────────────────────────
for (const r of V.change) {
  const { changed } = core.decideSet(toRow(r.row), r.value, { defaultOn: r.defaultOn });
  check(`${r.id}: changed`, changed === r.expect.changed, `expected ${r.expect.changed}, got ${changed}`);
  check(`${r.id}: reset iff changed (master irrelevant)`, r.expect.reset === changed);
  const afterRow = toRow({ e2ePref: r.expect.after.storedAfter, rev: r.row.rev + r.expect.revBump });
  const after = core.resolveE2ePref(afterRow, { masterEnabled: r.masterEnabled, defaultOn: r.defaultOn });
  check(`${r.id}: after.preference/effective`,
    after.preference === r.expect.after.preference && after.effective === r.expect.after.effective, j(after));
}

// ── 4. seed decision (§7) ───────────────────────────────────────────────────
for (const r of V.seed) {
  const got = core.decideSeed(toRow(r.row), r.value);
  check(`${r.id}: refused/applied`, got.refused === r.expect.refused && got.applied === r.expect.applied, j(got));
  check(`${r.id}: seed never resets`, r.expect.reset === false);
}

// ── 5. master switch: the relay's published boot value, never re-derived ───
{
  const saved = globalThis.__e2ePairingEnabled;
  delete globalThis.__e2ePairingEnabled;
  check('unpublished master switch reads OFF', core.isE2ePairingEnabled() === false);
  check('unpublished master switch is reported as unpublished', core.isMasterSwitchPublished() === false);
  globalThis.__e2ePairingEnabled = 'true';
  check('a non-boolean publication reads OFF (only the boolean true is on)', core.isE2ePairingEnabled() === false);
  globalThis.__e2ePairingEnabled = true;
  check('published true reads ON', core.isE2ePairingEnabled() === true);
  process.env.E2E_PAIRING_ENABLED = '0';
  check('the env var is NOT re-read here (the published boot value wins)', core.isE2ePairingEnabled() === true);
  globalThis.__e2ePairingEnabled = false;
  process.env.E2E_PAIRING_ENABLED = '1';
  check('…in both directions', core.isE2ePairingEnabled() === false);
  delete process.env.E2E_PAIRING_ENABLED;
  if (saved === undefined) delete globalThis.__e2ePairingEnabled; else globalThis.__e2ePairingEnabled = saved;
  check("default: only E2E_PREF_DEFAULT === 'on' is on",
    core.isE2ePrefDefaultOn({ E2E_PREF_DEFAULT: 'on' }) === true
    && ['', 'off', 'ON', 'true', '1', ' on', undefined].every((v) => core.isE2ePrefDefaultOn({ E2E_PREF_DEFAULT: v }) === false));
}

// ── 6. limiter (Security m1): one budget, 10/min AND 30/hour, per userId ────
{
  const L = core.createE2ePrefLimiter();
  let t = 1_000_000;
  let ok = 0;
  for (let i = 0; i < 12; i++) if (L.take('u1', t + i).allowed) ok++;
  check('10 writes in a minute pass, the 11th and 12th are refused', ok === 10, ok);
  check('another user has its own budget', L.take('u2', t).allowed === true);
  const r = L.take('u1', t + 20);
  check('a refusal carries retryAfterMs > 0', !r.allowed && r.retryAfterMs > 0, j(r));
  // Hourly cap: 10 per minute for 3 minutes = 30, then the 4th minute is refused.
  const H = core.createE2ePrefLimiter();
  let hourOk = 0;
  for (let m = 0; m < 4; m++) for (let i = 0; i < 10; i++) if (H.take('u', t + m * 61_000 + i).allowed) hourOk++;
  check('the hourly cap binds at 30', hourOk === 30, hourOk);
  check('…and releases after an hour', H.take('u', t + 3_600_000 + 10).allowed === true);
  check('limits are the design numbers', core.E2E_PREF_LIMIT_PER_MIN === 10 && core.E2E_PREF_LIMIT_PER_HOUR === 30);
  check('the shared limiter lives on globalThis (one budget for Next AND server.js)',
    core.sharedE2ePrefLimiter() === globalThis.__e2ePrefLimiter && core.sharedE2ePrefLimiter() === core.sharedE2ePrefLimiter());
}

// ── 7. refusals save NOTHING: they fire before the database is touched ─────
{
  let dbCalls = 0;
  const trapDb = new Proxy({}, { get() { dbCalls++; throw new Error('db touched'); } });
  const hooks = { __applyE2ePrefChange: async () => null, __pushE2ePref: async () => 0 };
  const quiet = () => {};
  const codeOf = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.code || e.message; } };

  check('bad value -> invalid_value, db untouched',
    (await codeOf(core.setE2ePref(trapDb, 'u', 'maybe', 'web', { hooks, log: quiet }))) === 'invalid_value' && dbCalls === 0);
  check("unlisted source ('attacker') -> invalid_source, db untouched",
    (await codeOf(core.setE2ePref(trapDb, 'u', 'on', 'attacker', { hooks, log: quiet }))) === 'invalid_source' && dbCalls === 0);
  check('M2: reset hook missing -> relay_unavailable BEFORE the write',
    (await codeOf(core.setE2ePref(trapDb, 'u', 'on', 'web', { hooks: {}, log: quiet }))) === 'relay_unavailable' && dbCalls === 0);
  check('M2: push hook missing -> seed refused BEFORE the write',
    (await codeOf(core.seedE2ePref(trapDb, 'u', 'on', 'web', { hooks: {}, log: quiet }))) === 'relay_unavailable' && dbCalls === 0);
  check("seed 'off' -> invalid_value, db untouched",
    (await codeOf(core.seedE2ePref(trapDb, 'u', 'off', 'web', { hooks, log: quiet }))) === 'invalid_value' && dbCalls === 0);
  const spent = core.createE2ePrefLimiter(0, 30);
  check('rate limited -> rate_limited, db untouched (never "saved but not reset")',
    (await codeOf(core.setE2ePref(trapDb, 'u', 'on', 'web', { hooks, limiter: spent, log: quiet }))) === 'rate_limited' && dbCalls === 0);
  check('sources allowlist is exactly web|ext|phone|seed|admin',
    j([...core.E2E_PREF_SOURCES].sort()) === j(['admin', 'ext', 'phone', 'seed', 'web']));
}

// ── 8. write path over a stand-in transaction: hook order + failure shapes ──
{
  // The SQL itself is exercised against real Postgres by the relay proof; here
  // a scripted tx returns the UPDATE's RETURNING rows so the post-write logic
  // (who gets called, what is returned, what is thrown) is pinned in isolation.
  const mkDb = (updatedRows, current) => ({
    $transaction: async (fn) => fn({
      $queryRawUnsafe: async () => updatedRows,
      user: { findUnique: async () => current },
    }),
  });
  const row = { e2ePref: true, e2ePrefRev: 8, e2ePrefUpdatedAt: new Date(), e2ePrefUpdatedBy: 'web' };
  const quiet = () => {};
  const L = () => core.createE2ePrefLimiter();
  let applied = 0;
  const hooks = { __applyE2ePrefChange: async () => { applied++; return { closed: 2, phones: 1, browsers: 1, listeners: 0 }; } };
  const changed = await core.setE2ePref(mkDb([row], null), 'u', 'on', 'web', { hooks, limiter: L(), log: quiet });
  check('a change calls __applyE2ePrefChange once and returns its reset',
    changed.changed === true && applied === 1 && changed.reset && changed.reset.closed === 2, j(changed));
  const noop = await core.setE2ePref(mkDb([], row), 'u', 'on', 'web', { hooks, limiter: L(), log: quiet });
  check('a no-op does NOT call the reset hook and returns reset:null',
    noop.changed === false && applied === 1 && noop.reset === null, j(noop));
  let err = null;
  try {
    await core.setE2ePref(mkDb([row], null), 'u', 'on', 'web',
      { hooks: { __applyE2ePrefChange: async () => { throw new Error('boom'); } }, limiter: L(), log: quiet });
  } catch (e) { err = e; }
  check('M2: a reset that throws surfaces as reset_failed (route -> 500), with the saved value attached',
    err && err.code === 'reset_failed' && err.resolved && err.resolved.rev === 8 && err.changed === true, err && err.message);
  const lines = [];
  await core.setE2ePref(mkDb([row], null), 'user-abcdef-123', 'on', 'phone', { hooks, limiter: L(), log: (m) => lines.push(m) });
  check('one log line per accepted write, in the brief format, user redacted',
    lines.length === 1 && /^\[e2e-pref\] user=\S+ rev=8 value=on by=phone changed=true$/.test(lines[0])
    && !lines[0].includes('user-abcdef-123'), j(lines));
  let pushed = 0;
  const seedOut = await core.seedE2ePref(mkDb([{ ...row, e2ePrefUpdatedBy: 'seed', e2ePrefRev: 1 }], null), 'u', 'on', 'phone',
    { hooks: { __pushE2ePref: async () => { pushed++; return 2; }, __applyE2ePrefChange: async () => { throw new Error('seed must never reset'); } }, limiter: L(), log: quiet });
  check('seed applied: pushes once, never resets, stores updatedBy seed, rev bumped (M3)',
    seedOut.applied === true && pushed === 1 && seedOut.resolved.updatedBy === 'seed' && seedOut.resolved.rev === 1, j(seedOut));
  const seedNo = await core.seedE2ePref(mkDb([], row), 'u', 'on', 'phone',
    { hooks: { __pushE2ePref: async () => { pushed++; return 2; } }, limiter: L(), log: quiet });
  check('seed not applied: no push', seedNo.applied === false && pushed === 1);
}

// ── 9. the SQL carries the no-op predicate and the CAS (source pins) ────────
{
  const src = readFileSync(join(ROOT, 'lib', 'e2ePref-core.js'), 'utf8').replace(/\r\n/g, '\n');
  check('SET: rev is bumped inside the UPDATE (no read-modify-write)', /"e2ePrefRev" = "e2ePrefRev" \+ 1/.test(src));
  check('SET: the no-op predicate is the UPDATE\'s own WHERE on the RESOLVED value',
    /AND COALESCE\("e2ePref", \$4\) IS DISTINCT FROM \$1/.test(src));
  check('SEED: compare-and-set on e2ePref IS NULL', /WHERE "id" = \$1\s+AND "e2ePref" IS NULL/.test(src));
  check('server clock, never the client\'s', (src.match(/"e2ePrefUpdatedAt" = NOW\(\)/g) || []).length === 2);
  check('no SQL is built by string concatenation of caller data',
    !/\$queryRawUnsafe\([^)]*\+\s*(userId|value|source)/.test(src));
}

// ── 10. relay wiring (server.js source pins; the wire itself: relay proof) ──
{
  const raw = readFileSync(join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('comment stripper kept the relay', /function startRelay/.test(src));
  const apply = /async function applyE2ePrefChangeForUser\(userId\) \{([\s\S]*?)\n {2}\}/.exec(src);
  check('applyE2ePrefChangeForUser exists', !!apply);
  if (apply) {
    const body = apply[1];
    const iPush = body.indexOf('sendE2ePrefToRoom(');
    const iReset = body.indexOf("doResetRoom(target.phoneToken, 'e2e-pref')");
    check('REV 2 ORDER: E2E_PREF is sent BEFORE doResetRoom', iPush > -1 && iReset > iPush, `${iPush} ${iReset}`);
    check('the pref reset does NOT pass through resetRateLimiter', !/resetRateLimiter/.test(body));
  }
  check('both hooks are published on globalThis',
    /globalThis\.__pushE2ePref = pushE2ePrefForUser;/.test(src)
    && /globalThis\.__applyE2ePrefChange = applyE2ePrefChangeForUser;/.test(src));
  check('m3: recipients are filtered to sockets authenticated as the room owner',
    /ws && ws\.userId === userId && ws\.readyState === WebSocket\.OPEN/.test(src));
  check('on-connect push on BOTH paths', (src.match(/sendE2ePrefOnConnect\(ws\);/g) || []).length === 2);
  const phoneSet = src.indexOf("if (msg.startsWith('SET_E2E_PREF:') || msg.startsWith('SEED_E2E_PREF:')) {\n          handlePhoneE2ePrefFrame");
  const phoneFile = src.indexOf("if (handleFileFrame(room, ws, msg, 'phone', token)) return;");
  const phoneMirror = src.indexOf('broadcastToListeners(room, msg);');
  check('phone SET/SEED is handled before the FILE handler, the listener mirror and the data plane',
    phoneSet > -1 && phoneSet < phoneFile && phoneSet < phoneMirror, `${phoneSet} ${phoneFile} ${phoneMirror}`);
  const browserDrop = src.indexOf('E2E_PREF write from a browser socket');
  const browserFile = src.indexOf("if (handleFileFrame(room, ws, msg, 'browser', token)) return;");
  check('browser SET/SEED is dropped before it can reach the data plane',
    browserDrop > -1 && (browserFile === -1 || browserDrop < browserFile), `${browserDrop} ${browserFile}`);
  check('phone writes go through the ONE lib write path with source phone',
    /setE2ePrefCore\(db, ws\.userId, value, 'phone'\)/.test(src) && /seedE2ePrefCore\(db, ws\.userId, value, 'phone'\)/.test(src));
  check('kill-switch refusal untouched', /if \(!E2E_PAIRING_ENABLED && e2eBlock && e2eBlock\.mode === 1\)/.test(src));
}

// ── 11. CONTROLS: the detectors above can go red ────────────────────────────
{
  // A planted wrong expectation must be caught by the same comparison.
  const r = V.resolve.find((x) => x.row.e2ePref === true && x.masterEnabled === false);
  const got = core.resolveE2ePref(toRow(r.row), { masterEnabled: r.masterEnabled, defaultOn: r.defaultOn });
  check('CONTROL: a planted "effective on while master off" is NOT what the function returns', got.effective !== 'on');
  const flipped = V.change.find((x) => x.id === 'C-null-defaultOff-write-off-NOOP');
  check('CONTROL: the null+default-off+write-off row really is a no-op, not a change',
    core.decideSet(toRow(flipped.row), 'off', { defaultOn: false }).changed === false
    && core.decideSet(toRow(flipped.row), 'on', { defaultOn: false }).changed === true);
  const planted = "async function applyE2ePrefChangeForUser(userId) {\n    doResetRoom(target.phoneToken, 'e2e-pref');\n    sendE2ePrefToRoom(target, userId);\n  }";
  const m = /async function applyE2ePrefChangeForUser\(userId\) \{([\s\S]*?)\n {2}\}/.exec(planted);
  check('CONTROL: a reset-before-push body is caught by the order pin',
    !!m && !(m[1].indexOf('sendE2ePrefToRoom(') > -1 && m[1].indexOf("doResetRoom(target.phoneToken, 'e2e-pref')") > m[1].indexOf('sendE2ePrefToRoom(')));
}

const total = passed + failed;
console.log(`e2e-pref-contract: ${passed} passed, ${failed} failed (${total} checks; vectors ${V.resolve.length}+${V.seed.length}+${V.change.length})`);
process.exitCode = failed === 0 ? 0 : 1;
