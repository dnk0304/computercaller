/**
 * tests/soak-rig.test.mjs — SOAK-RIG (c).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The 24 h soak has exactly one chance to be right. Its verdict comes from
 * `soak/verify-soak.mjs`, whose most important guard — "a heartbeat gap over
 * 10 min invalidates the run" (RESUME-PROTOCOL rule 8) — had, until this file,
 * never once been observed to go red. The only way to exercise it was to run a
 * real soak, which is the thing nobody gets to do twice. A guard that has never
 * fired is not a guard; it is a comment with a semicolon.
 *
 * So every assertion here is paired with its own positive control: the SAME
 * fixture generator produces the clean 24 h window that must PASS and the
 * damaged ones that must FAIL, and each failure is matched by NAME. Asserting
 * only `fail > 0` would let a short-window fixture "fail correctly" because of
 * an unrelated broken check, and the gap rule could rot away underneath a green
 * suite.
 *
 * The second property is smaller and just as load-bearing. `soak-runner.mjs`
 * used to seed two database users, open four sockets and snapshot a start time
 * AT MODULE SCOPE — so importing it began a soak, and `verify-soak.mjs` parsed
 * argv and called `process.exit(2)` on import. Nothing could be tested, and a
 * stray import anywhere would have started a clock. Both now carry an
 * entry-point guard, and the checks below run each one in a CHILD PROCESS and
 * assert the child (1) exits 0, (2) exits on its own — no lingering socket or
 * interval kept the loop alive — and (3) created no evidence directory. That
 * third one is the detector with teeth: the old module-scope `mkdirSync` would
 * have created it.
 *
 * ── WHY THE CHILD PROBES RUN BEFORE THIS FILE IMPORTS THE RIG ──────────────
 * Found by planting the defect. A first draft imported the three modules at the
 * top in the ordinary way, then checked them in a child process. Re-adding a
 * module-scope `setInterval` to soak-runner.mjs did not turn that suite red: it
 * HUNG it, because the timer it planted was now in this process too, and ESM
 * evaluates every static import before the first test runs. The gate would have
 * recorded a 15-minute timeout instead of a named failure — a detector that
 * cannot report is barely better than one that cannot fire.
 *
 * So the probes are `spawnSync` calls at module scope, and the rig is loaded
 * afterwards with `await import()` only once they come back clean. A rig that
 * starts a clock is now caught by a child that never comes home, this file
 * exits 1 with the reason, and the suite it would have hung never loads it.
 *
 * No browser, no Docker, no database. This is a node-only suite by design —
 * the soak itself is Ken's to start on Hetzner (R-AM).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import jwt from 'jsonwebtoken';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = ['soak/soak-runner.mjs', 'soak/verify-soak.mjs', 'scripts/lib/relay-auth.mjs'];

// ── a counted-assertion helper, so the gate gets a stable number ───────────
// The gate parses counts out of stdout (tools/e2e-gate.mjs passLine) and judges
// pass/fail by EXIT CODE. node:test's own TAP lines would be counted by
// passLine's last-resort `^ok` branch, where a failing subtest prints "not ok"
// and simply stops being counted — passed would still equal total and the
// count would silently shrink. An explicit tally cannot do that.
let passed = 0, failed = 0;
const failures = [];
/** Record a result. Does not throw — used where every probe must be reported. */
function tally(name, cond, detail = '') {
  if (cond) { passed += 1; } else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
/** Record a result AND fail the enclosing node:test. */
function check(name, cond, detail = '') {
  tally(name, cond, detail);
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
}
/**
 * A throwing assertion that still moves the COUNT.
 *
 * Found by planting the defect: a bare `assert.throws` turned the suite red by
 * exit code but left the summary reading "45/45 checks passed", so the gate's
 * parity reference would have seen a full house on a failing run. Every
 * assertion in this file goes through the tally for that reason.
 */
function checkThrows(name, fn, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  const ok = !!threw && re.test(String(threw.message || threw));
  tally(name, ok, threw ? String(threw.message).slice(0, 120) : 'did not throw');
  assert.ok(ok, `${name} — ${threw ? threw.message : 'did not throw'}`);
}
process.on('exit', () => {
  console.log(`\n${passed}/${passed + failed} checks passed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
});

// Rule 16: nothing this suite writes lands inside the tree it is asserting on.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-rig-'));

// ── the side-effect probes, run BEFORE the rig is imported ─────────────────
/**
 * Import one rig module in a child process and report what it did.
 *
 * The environment is deliberately hostile: a relay URL and a DATABASE_URL that
 * point at a closed port, so anything reaching for the network at module scope
 * fails loudly instead of hanging. `timeout` kills the child and leaves
 * `status` null — which is precisely the signature of a module that armed an
 * interval or held a socket open, so the timeout IS the no-lingering-handle
 * assertion rather than merely a safety net.
 */
function probeImport(rel) {
  const evidence = path.join(TMP, `evidence-${path.basename(rel)}`);
  const href = 'file://' + path.join(ROOT, rel).replace(/\\/g, '/');
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(href)}).then(()=>{})`], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env,
      SOAK_EVIDENCE_DIR: evidence,
      SOAK_RELAY_WS: 'ws://127.0.0.1:1',
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nothing',
      SOAK_HOURS: '24',
    },
  });
  return {
    rel,
    exitedCleanly: r.status === 0,
    madeEvidenceDir: fs.existsSync(evidence),
    detail: `status=${r.status} signal=${r.signal} stderr=${(r.stderr || '').slice(0, 300)}`,
  };
}

const PROBES = RIG.map(probeImport);
const dirty = PROBES.filter((p) => !p.exitedCleanly || p.madeEvidenceDir);
if (dirty.length) {
  // Refuse to go any further. Importing a rig module that starts a clock would
  // hang THIS process too, and a hung suite reports nothing.
  console.error('\nREFUSING to load the rig — importing it is not side-effect free:');
  for (const p of dirty) {
    console.error(`  FAIL ${p.rel} — exitedCleanly=${p.exitedCleanly} madeEvidenceDir=${p.madeEvidenceDir} ${p.detail}`);
  }
  // Tally through the same counters the tests use, so the summary the gate
  // parses is this file's ONLY summary line — passLine takes the LAST `n/m` in
  // stdout, and a second count printed here would be the one it read.
  for (const p of PROBES) {
    tally(`${p.rel} exits on its own when merely imported`, p.exitedCleanly, p.detail);
    tally(`${p.rel} creates no evidence directory on import`, !p.madeEvidenceDir, p.detail);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const { verifySoak, parseArgs, MAX_GAP_MS, EXPECT_EVERY_MS } = await import('../soak/verify-soak.mjs');
const { mintSecret, mintTicket, relayUrls } = await import('../scripts/lib/relay-auth.mjs');
const { readConfig, EXPECTED_CLOSE_CODES, parseFrame, UNEXPECTED_PAIRING_FRAMES } = await import('../soak/soak-runner.mjs');

// ── fixture generators ─────────────────────────────────────────────────────
const T0 = Date.parse('2026-09-21T00:00:00.000Z');
const SHA = 'abc1234';

/**
 * A heartbeat file for a window of `hours`, one beat every 5 min, with `holes`
 * given as [fromMin, toMin) ranges of beats to omit.
 *
 * ONE generator for every case on purpose. The clean window and the damaged
 * ones differ only in the argument, so a PASS on the clean window is a positive
 * control for the FAILs: the fixtures cannot be wrong in a way that makes a
 * guard look like it fired.
 */
function heartbeat({ hours = 24, holes = [], shas = null, beat = null } = {}) {
  const stepMin = EXPECT_EVERY_MS / 60_000;
  const lastMin = hours * 60;
  const lines = [];
  for (let m = 0; m <= lastMin; m += stepMin) {
    if (holes.some(([a, b]) => m >= a && m < b)) continue;
    const kind = m === 0 ? 'start' : (m === lastMin ? 'end' : 'hb');
    const rec = { utc: new Date(T0 + m * 60_000).toISOString(), kind, sha: shas ? shas(m) : SHA };
    if (kind === 'hb') {
      Object.assign(rec, {
        elapsedMin: m, onOpen: true, offOpen: true, rssMb: 120, unexpectedCloses: 0,
        // SOAK-RIG-2 — what a HEALTHY beat looks like now. `beat(m)` lets one
        // case damage exactly one field, so a FAIL is attributable to that
        // field and not to a fixture that fell apart somewhere else.
        onActive: true, offActive: true, fwdOn: 60, fwdOff: 60,
        pairingRejected: 0, pairingTerminated: 0,
      }, beat ? beat(m) : {});
    }
    if (kind === 'start') rec.hours = hours;
    if (kind === 'end') rec.why = 'window-complete';
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n') + '\n';
}

function trace({ hours = 24, counters = null } = {}) {
  const lines = [];
  const rec = (kind, m, extra = {}) => ({
    kind, utc: new Date(T0 + m * 60_000).toISOString(), startedAt: new Date(T0).toISOString(),
    sha: SHA, elapsedMin: m, rssMb: 120, heapUsedMb: 60, externalMb: 5, cpuPct: 1.2, loadAvg1: 0.1,
    // SOAK-RIG-2: a healthy run's recv tracks its sent. `counters` overrides
    // let one case break one number.
    counters: {
      framesSentOn: 100 * (m + 1), framesSentOff: 100 * (m + 1),
      framesRecvOn: 100 * (m + 1), framesRecvOff: 100 * (m + 1),
      ticksSkippedNotActive: 0,
      ...(counters || {}),
    },
    ...extra,
  });
  lines.push(JSON.stringify(rec('start', 0)));
  for (let h = 1; h <= hours; h++) lines.push(JSON.stringify(rec('hourly', h * 60)));
  lines.push(JSON.stringify(rec('end', hours * 60, { why: 'window-complete' })));
  return lines.join('\n') + '\n';
}

const write = (name, body) => { const p = path.join(TMP, name); fs.writeFileSync(p, body); return p; };

/** Find one named check in a verifySoak() result. */
const named = (r, needle) => r.checks.find((c) => c.name.includes(needle));

// ═══════════════════════════════════════════════════════════════════════════
// 1. The three modules load with NO side effects.
// ═══════════════════════════════════════════════════════════════════════════
test('importing the rig starts nothing: no clock, no socket, no evidence dir', () => {
  for (const p of PROBES) {
    check(`${p.rel} exits on its own when merely imported`, p.exitedCleanly, p.detail);
    check(`${p.rel} creates no evidence directory on import`, !p.madeEvidenceDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. verify-soak: PASS on a continuous 24 h window, FAIL on each defect.
// ═══════════════════════════════════════════════════════════════════════════
test('a continuous 24 h window with a matching trace is VALID', () => {
  const hb = write('clean.jsonl', heartbeat({ hours: 24 }));
  const tr = write('clean-trace.jsonl', trace({ hours: 24 }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('the clean window is graded VALID', r.valid,
    `fail=${r.fail}: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join(' | ')}`);
  check('the clean window was actually graded, not waved through', r.pass >= 10, `pass=${r.pass}`);
  check('no check was refused', !r.refused && !r.usage, String(r.refused));
});

test(`a gap over ${MAX_GAP_MS / 60_000} min invalidates the window (rule 8)`, () => {
  // 25 minutes missing from the tenth hour. Everything else is the clean file.
  const hb = write('gap.jsonl', heartbeat({ hours: 24, holes: [[600, 625]] }));
  const tr = write('gap-trace.jsonl', trace({ hours: 24 }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a >10 min gap is INVALID', !r.valid);
  const gapCheck = named(r, 'no heartbeat gap');
  check('it is the GAP check that failed, by name', gapCheck && gapCheck.ok === false,
    JSON.stringify(gapCheck));
  // Five omitted beats leave 595 -> 630, i.e. a 30 min hole. Asserting the
  // NUMBER, not just "a gap", is what stops the check from passing because the
  // fixture was damaged somewhere else.
  check('the failure detail names the gap length', /30\.0 min/.test(gapCheck?.detail || ''),
    gapCheck?.detail);
  // The control: the same defect at 10 min or less must NOT trip it, or the
  // threshold is decorative and any cadence hiccup would restart the clock.
  const ok = write('smallgap.jsonl', heartbeat({ hours: 24, holes: [[600, 605]] }));
  const r2 = verifySoak({ files: [ok, tr], hours: 24 });
  check('a 10 min gap (one missed beat) does NOT trip the rule', named(r2, 'no heartbeat gap')?.ok === true,
    JSON.stringify(named(r2, 'no heartbeat gap')));
});

test('a window under 24 h is INVALID however continuous it is', () => {
  const hb = write('short.jsonl', heartbeat({ hours: 12 }));
  const tr = write('short-trace.jsonl', trace({ hours: 12 }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a 12 h window is INVALID at --hours 24', !r.valid);
  const span = named(r, 'window spans at least');
  check('it is the SPAN check that failed, by name', span && span.ok === false, JSON.stringify(span));
  check('the gap rule did not fire on it (the window is continuous)',
    named(r, 'no heartbeat gap')?.ok === true);
  // Control: the identical file graded on its own terms is valid, which proves
  // the span check reads --hours rather than hardcoding a verdict.
  check('the same 12 h file is VALID at --hours 12', verifySoak({ files: [hb, tr], hours: 12 }).valid);
});

test('two heartbeat files are REFUSED, never stitched (NEW-MA-3)', () => {
  const a = write('half-a.jsonl', heartbeat({ hours: 12 }));
  const b = write('half-b.jsonl', heartbeat({ hours: 12 }));
  const tr = write('stitch-trace.jsonl', trace({ hours: 12 }));
  const r = verifySoak({ files: [a, tr, b], hours: 24 });
  check('three positionals are refused', !!r.refused, JSON.stringify(r));
  check('the refusal cites the never-stitch rule', /NEW-MA-3|two windows are not one soak/.test(r.refused || ''),
    r.refused);
  check('a refusal is not reported as a graded failure', r.pass === 0 && r.fail === 0,
    `pass=${r.pass} fail=${r.fail}`);
  check('two 12 h halves are not silently merged into a 24 h verdict', !r.valid);
});

test('a mid-window sha change is INVALID (a stitched window wearing one name)', () => {
  const hb = write('twosha.jsonl', heartbeat({ hours: 24, shas: (m) => (m < 720 ? 'aaa1111' : 'bbb2222') }));
  const r = verifySoak({ files: [hb], hours: 24 });
  check('two shas in one file is INVALID', !r.valid);
  check('it is the one-sha check that failed', named(r, 'one build sha')?.ok === false);
});

test('--hours 0.025 is a flag value, not a third filename', () => {
  // The bug this pins: positionals were once filtered with !/^\d+$/, so a
  // fractional --hours value looked like a second heartbeat file and the run
  // was rejected as stitched. A guard that fires on the wrong input teaches
  // people to bypass it.
  const { files, hours } = parseArgs(['hb.jsonl', 'trace.jsonl', '--hours', '0.025']);
  check('two positionals survive a fractional flag value', files.length === 2, JSON.stringify(files));
  check('the fractional hours value is read', hours === 0.025, String(hours));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. mintSecret() cannot conjure an entitled identity.
//    The README claims relay-auth.mjs is what a harness should use "rather than
//    rediscovering 4401". That claim is only safe if the helpers cannot
//    ACCIDENTALLY produce admission without the seeded database row.
// ═══════════════════════════════════════════════════════════════════════════
test('a minted secret alone buys no entitled identity — the seeded user is load-bearing', () => {
  const secret = mintSecret();
  check('mintSecret() clears the relay\'s 32-char floor', typeof secret === 'string' && secret.length >= 32,
    `len=${secret.length}`);
  check('mintSecret() returns a secret, not an identity',
    typeof secret === 'string' && !/userId|phoneToken|isAdmin/.test(secret));

  // A ticket for a user id that was never seeded is still a perfectly valid
  // signature. That is the point: admission is decided by the DB row, not by
  // possession of the secret.
  const t = mintTicket({ secret, userId: 'user-that-was-never-seeded' });
  const claims = jwt.verify(t, secret, { algorithms: ['HS256'] });
  check('the ticket carries only purpose + userId', claims.purpose === 'relay-ticket'
    && claims.userId === 'user-that-was-never-seeded', JSON.stringify(claims));
  check('the ticket asserts NO entitlement of its own',
    !('isAdmin' in claims) && !('entitled' in claims) && !('subscription' in claims), JSON.stringify(claims));

  // A short secret cannot be used at all, so a caller cannot quietly downgrade
  // to one the relay would refuse (and only complain about on its own stdout).
  checkThrows('a secret under 32 chars cannot mint a ticket at all',
    () => mintTicket({ secret: 'too-short', userId: 'u1' }), /at least 32 chars/);

  // The phone URL needs the row's phoneToken; there is nothing to mint it from,
  // and relayUrls refuses EAGERLY rather than handing back lazy builders that
  // produce `?token=undefined` — which the relay answers with 4401, i.e. the
  // exact symptom this module exists to stop people from misreading.
  checkThrows('relayUrls refuses with no seeded user row',
    () => relayUrls({ wsBase: 'ws://x', secret, user: undefined }), /needs a seeded user row/);
  checkThrows('relayUrls refuses a row loaded without its phoneToken',
    () => relayUrls({ wsBase: 'ws://x', secret, user: { id: 'u1' } }), /phoneToken is missing/);
  // A real seeded shape still works, so the guard is not simply refusing
  // everything — the control for the two throws above.
  const urls = relayUrls({ wsBase: 'ws://x', secret, user: { id: 'u1', phoneToken: 'tok-abc' } });
  check('a seeded row yields all three URLs', /ticket=/.test(urls.browser())
    && /role=listener/.test(urls.listener()) && /\/relay\/phone\?token=tok-abc$/.test(urls.phone()),
    urls.phone());
});

test('the relay resolves the ticket against the User table and then the paywall', () => {
  // The property above is only true because server.js enforces it, so it is
  // asserted against the SHIPPED relay rather than taken on trust. If any of
  // these move, a minted ticket could start meaning something on its own.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('validateTicket refuses a JWT_SECRET under 32 chars',
    /if \(!secret \|\| secret\.length < 32\)/.test(src));
  check('validateTicket accepts HS256 only', /algorithms: \['HS256'\]/.test(src));
  check('validateTicket requires purpose === relay-ticket',
    /claims\.purpose !== 'relay-ticket'/.test(src));
  check('validateTicket resolves userId against the User table and returns null if absent',
    /db\.user\.findUnique\(\{\s*where: \{ id: claims\.userId \}/.test(src)
    && /return user \? \{ userId: user\.id, phoneToken: user\.phoneToken \} : null;/.test(src));
  check('every admission path then passes the entitlement chokepoint',
    /const ent = await evaluateUserEntitlement\(db, userId\);/.test(src)
    && /ws\.close\(4403, 'subscription_required'\)/.test(src));
  // And the rule seedEntitledUser depends on, in the shared core.
  const core = fs.readFileSync(path.join(ROOT, 'lib', 'entitlement-core.js'), 'utf8');
  check('entitlement rule (1) still short-circuits on isAdmin', /\n\s*if \(isAdmin\) \{/.test(core));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The container env the soak needs, asserted against the compose file.
// ═══════════════════════════════════════════════════════════════════════════
test('the compose stack gives the runner what it needs and keeps the kill switch local', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'soak', 'docker-compose.soak.yml'), 'utf8');
  const runner = yml.slice(yml.indexOf('  soak-runner:'));
  check('the runner gets a DATABASE_URL (it seeds its users with Prisma)',
    /DATABASE_URL: postgresql:\/\/soak:soak@soak-db:5432\/ccsoak/.test(runner));
  check('the runner signs tickets with the relay\'s own secret',
    /JWT_SECRET: \$\{SOAK_JWT_SECRET/.test(runner));
  check('the kill switch is ON, spelled exactly "1" (server.js: === \'1\')',
    /E2E_PAIRING_ENABLED: "1"/.test(yml));
  check('nothing in the stack points at a prod database', !/DATABASE_URL:(?!.*soak-db)/.test(yml));
  check('the scratch schema is created before the relay starts',
    /soak-migrate:/.test(yml) && /prisma", "db", "push"/.test(yml)
    && /soak-migrate:\s*\n\s*condition: service_completed_successfully/.test(yml));
  check('the db network is internal (no egress, no prod reachability)',
    /soak:\s*\n\s*driver: bridge\s*\n(?:\s*#[^\n]*\n)*\s*internal: true/.test(yml));

  // The runner's own defaults must agree with the file, or the compose env is
  // configuring a variable nothing reads.
  const cfg = readConfig({ SOAK_RELAY_WS: 'ws://soak-relay:3000', SOAK_HOURS: '24', JWT_SECRET: 'x'.repeat(48) });
  check('the runner reads SOAK_RELAY_WS / SOAK_HOURS / JWT_SECRET',
    cfg.RELAY_WS === 'ws://soak-relay:3000' && cfg.HOURS === 24 && cfg.JWT_SECRET_FROM_ENV === true);
  check('a missing JWT_SECRET is flagged, not silently replaced',
    readConfig({}).JWT_SECRET_FROM_ENV === false);
  check('1000 / 1001 / 4010 are the only expected close codes',
    [...EXPECTED_CLOSE_CODES].sort((a, b) => a - b).join(',') === '1000,1001,4010');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SOAK-RIG-2 — the lobby defect, and the verdict that could not see it.
//
// The 2026-09-20T02:32Z window was 100% continuous, held four authed sockets
// for its whole life, logged zero unexpected closes — and forwarded not one
// frame, because the runner never performed the relay's Connect+Accept
// handshake. The verifier graded traffic on `framesSent`, a counter the runner
// increments about frames the relay was throwing away, and would have called
// that VALID. Each case below damages exactly ONE field of the clean fixture,
// so the FAIL is attributable to that field.
//
// The handshake itself is proven against the SHIPPED server.js in
// tests/soak-handshake.test.mjs — a client and a mirror written by the same
// hand agree by construction, so that proof cannot live here.
// ═══════════════════════════════════════════════════════════════════════════
test('PLANT: a window whose relay forwarded NOTHING is INVALID (recv, not sent)', () => {
  const hb = write('norecv.jsonl', heartbeat({ hours: 24 }));
  // Sent exactly as much as the clean run. Received nothing. This is the trace
  // the 02:32Z window would have produced, and the old check passed it.
  const tr = write('norecv-trace.jsonl', trace({ hours: 24, counters: { framesRecvOn: 0, framesRecvOff: 0 } }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a zero-recv window is INVALID', !r.valid);
  const traffic = named(r, 'traffic actually flowed');
  check('it is the TRAFFIC check that failed, by name', traffic && traffic.ok === false, JSON.stringify(traffic));
  check('the ratio check failed too', named(r, 'at least 90%')?.ok === false,
    JSON.stringify(named(r, 'at least 90%')));
  // The control: the SAME fixture with recv restored is VALID, which is what
  // makes the two FAILs above attributable to the zero.
  const ok = verifySoak({ files: [hb, write('recv-trace.jsonl', trace({ hours: 24 }))], hours: 24 });
  check('the same window with forwarded frames is VALID', ok.valid,
    ok.checks.filter((c) => !c.ok).map((c) => c.name).join(' | '));
});

test('PLANT: one pair receiving nothing is still INVALID (both sides are checked)', () => {
  const hb = write('halfrecv.jsonl', heartbeat({ hours: 24 }));
  // ON forwarded fine, OFF forwarded nothing. A one-sided check would pass
  // this, and the ON pair is the sealed path — the half nobody would notice.
  const tr = write('halfrecv-trace.jsonl', trace({ hours: 24, counters: { framesRecvOff: 0 } }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a one-sided window is INVALID', !r.valid);
  check('it is the traffic check that failed', named(r, 'traffic actually flowed')?.ok === false);
});

test('a recv/sent ratio under 0.9 is INVALID, at or over it is not', () => {
  const hb = write('ratio.jsonl', heartbeat({ hours: 24 }));
  const at = (pct) => ({ framesRecvOn: Math.round(100 * 1441 * pct), framesRecvOff: Math.round(100 * 1441 * pct) });
  // The `end` sample is at elapsedMin 1440, so its sent figure is 100*(1440+1).
  const low = verifySoak({ files: [hb, write('ratio-low.jsonl', trace({ hours: 24, counters: at(0.85) }))], hours: 24 });
  check('0.85 is INVALID', !low.valid);
  check('it is the RATIO check that failed, by name', named(low, 'at least 90%')?.ok === false,
    JSON.stringify(named(low, 'at least 90%')));
  check('the two-sided traffic check still passed at 0.85 — the ratio is doing the work',
    named(low, 'traffic actually flowed')?.ok === true);
  const high = verifySoak({ files: [hb, write('ratio-high.jsonl', trace({ hours: 24, counters: at(0.95) }))], hours: 24 });
  check('0.95 is VALID', high.valid, high.checks.filter((c) => !c.ok).map((c) => c.name).join(' | '));
});

test('a heartbeat that reports a pair NOT ACTIVE invalidates the window', () => {
  const tr = write('active-trace.jsonl', trace({ hours: 24 }));
  // Everything else healthy: sockets open, frames forwarded, no closes. Only
  // the ACTIVE flag is false — which is precisely the lobby state.
  const hb = write('notactive.jsonl', heartbeat({ hours: 24, beat: (m) => (m === 600 ? { offActive: false } : {}) }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('one non-active beat is INVALID', !r.valid);
  check('it is the ACTIVE check that failed, by name', named(r, 'not ACTIVE')?.ok === false,
    JSON.stringify(named(r, 'not ACTIVE')));
  check('the open check did not fire (the sockets were fine)', named(r, 'held open')?.ok === true);
});

test('a zero forward delta on any beat invalidates the window', () => {
  const tr = write('fwd-trace.jsonl', trace({ hours: 24 }));
  const hb = write('nofwd.jsonl', heartbeat({ hours: 24, beat: (m) => (m === 900 ? { fwdOn: 0 } : {}) }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a beat that forwarded nothing is INVALID', !r.valid);
  const fwd = named(r, 'forward frames on both pairs');
  check('it is the FORWARD check that failed, by name', fwd && fwd.ok === false, JSON.stringify(fwd));
  check('the failure detail names the beat', /first at 2026-09-21T15:00/.test(fwd?.detail || ''), fwd?.detail);
});

test('a heartbeat file from the OLD rig fails — it cannot report what it never measured', () => {
  // No onActive, no fwdOn/fwdOff: the exact shape the 02:32Z window wrote.
  // Passing it would mean the new guards can be bypassed by old evidence.
  const stepMin = EXPECT_EVERY_MS / 60_000;
  const lines = [];
  for (let m = 0; m <= 1440; m += stepMin) {
    const kind = m === 0 ? 'start' : (m === 1440 ? 'end' : 'hb');
    const rec = { utc: new Date(T0 + m * 60_000).toISOString(), kind, sha: SHA };
    if (kind === 'hb') Object.assign(rec, { elapsedMin: m, onOpen: true, offOpen: true, rssMb: 120, unexpectedCloses: 0 });
    if (kind === 'start') rec.hours = 24;
    if (kind === 'end') rec.why = 'window-complete';
    lines.push(JSON.stringify(rec));
  }
  const hb = write('oldrig.jsonl', lines.join('\n') + '\n');
  const r = verifySoak({ files: [hb], hours: 24 });
  check('an old-format heartbeat is INVALID', !r.valid);
  check('the ACTIVE check is what refuses it', named(r, 'not ACTIVE')?.ok === false);
  check('the FORWARD check refuses it too', named(r, 'forward frames on both pairs')?.ok === false);
});

test('a rejected or terminated pairing invalidates the window', () => {
  const tr = write('term-trace.jsonl', trace({ hours: 24 }));
  const hb = write('terminated.jsonl', heartbeat({ hours: 24, beat: (m) => (m >= 300 ? { pairingTerminated: 1 } : {}) }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('a terminated pairing is INVALID', !r.valid);
  check('it is the rejected/terminated check that failed, by name',
    named(r, 'rejected or terminated')?.ok === false, JSON.stringify(named(r, 'rejected or terminated')));
});

test('a window that skipped ticks for want of an active pair is INVALID', () => {
  const hb = write('skip.jsonl', heartbeat({ hours: 24 }));
  const tr = write('skip-trace.jsonl', trace({ hours: 24, counters: { ticksSkippedNotActive: 12 } }));
  const r = verifySoak({ files: [hb, tr], hours: 24 });
  check('skipped ticks are INVALID', !r.valid);
  check('it is the skipped-ticks check that failed, by name',
    named(r, 'want of an active pair')?.ok === false, JSON.stringify(named(r, 'want of an active pair')));
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The runner's frame parser, and the guarantee that the REAL-relay proof
//    of the handshake cannot be quietly dropped from the gate.
// ═══════════════════════════════════════════════════════════════════════════
test('parseFrame splits TYPE:{json} the way every server.js safeSend site writes it', () => {
  const a = parseFrame('PAIRING_REQUEST:{"pairingId":"abc","ua":"x"}');
  check('the type is everything before the first colon', a.type === 'PAIRING_REQUEST', a.type);
  check('the payload is parsed', a.parsed === true && a.payload.pairingId === 'abc', JSON.stringify(a));
  // A payload can legally contain colons; splitting on the LAST one, or on
  // every one, would lose the pairingId and the accept would be ignored by the
  // relay as an id mismatch — silently, forever.
  const b = parseFrame('SMS_RECEIVED:{"text":"12:30:00","at":1}');
  check('a colon inside the payload does not move the split', b.payload.text === '12:30:00', JSON.stringify(b));
  const c = parseFrame('PHONE_PRESENT');
  check('a bare type with no payload is still a type', c.type === 'PHONE_PRESENT' && c.payload === null);
  const d = parseFrame('PAIRING_ACTIVE:not-json');
  check('an unparseable payload is MARKED, not swallowed', d.type === 'PAIRING_ACTIVE' && d.parsed === false);
  check('PAIRING_REJECTED and PAIRING_TERMINATED are the unexpected ones',
    [...UNEXPECTED_PAIRING_FRAMES].sort().join(',') === 'PAIRING_REJECTED,PAIRING_TERMINATED',
    [...UNEXPECTED_PAIRING_FRAMES].join(','));
});

test('the real-relay handshake proof is registered in the gate', () => {
  // This suite is node-only and proves nothing about the shipped relay. The
  // proof that the runner speaks the relay's actual protocol lives in
  // tests/soak-handshake.test.mjs, which boots server.js. If that file or its
  // gate registration disappears, the handshake goes back to being asserted by
  // a mirror of itself — so the disappearance has to be loud.
  const proof = path.join(ROOT, 'tests', 'soak-handshake.test.mjs');
  check('tests/soak-handshake.test.mjs exists', fs.existsSync(proof));
  const src = fs.readFileSync(proof, 'utf8');
  check('it boots the SHIPPED server.js rather than mirroring it',
    /relay-boot\.cjs/.test(src) && /require\(path\.join\(ROOT, 'server\.js'\)\)/.test(
      fs.readFileSync(path.join(ROOT, 'tests', 'lib', 'relay-boot.cjs'), 'utf8')));
  check('it drives the REAL soak-runner.mjs, not a copy',
    /'soak', 'soak-runner\.mjs'/.test(src));
  check('it carries the no-handshake plant', /handshake: false/.test(src) && /PLANT IS RED/.test(src));
  const gate = fs.readFileSync(path.join(ROOT, 'tools', 'e2e-gate.mjs'), 'utf8');
  check('the gate runs it', /soak-handshake\.test\.mjs/.test(gate));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
