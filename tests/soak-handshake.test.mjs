#!/usr/bin/env node
/**
 * tests/soak-handshake.test.mjs — SOAK-RIG-2.
 *
 * ── WHY THIS FILE EXISTS AND WHY IT IS NOT A MIRROR ────────────────────────
 * Every other relay suite in this repo mirrors server.js's state machine into
 * the test file ("server.js cannot be imported without booting Next.js — this
 * file MIRRORS the relay's pairing state machine"). That is a reasonable way to
 * reason about a state machine, and a worthless way to prove that a CLIENT
 * speaks the protocol the shipped relay implements: the mirror and the client
 * are written by the same hand in the same sitting, so they agree by
 * construction.
 *
 * That is exactly the failure this file was written after. The soak runner
 * opened four sockets, authed cleanly, logged zero 4401 — and soaked nothing
 * for the whole 2026-09-20T02:32Z window, because it never sent
 * BROWSER_REQUEST_PAIRING. Both rooms stayed in `room.lobby`, the relay dropped
 * every frame (`Dropping lobby-phone frame`), and the verifier graded traffic
 * on `framesSent` and would have called it VALID. No amount of mirroring would
 * have caught it: a mirror written by the same author would have paired
 * implicitly too.
 *
 * So this suite boots the REAL server.js (tests/lib/relay-boot.cjs stubs only
 * `next`), on an ephemeral port, against the scratch DATABASE_URL every other
 * DB-backed suite here uses, and runs the REAL soak/soak-runner.mjs against it.
 *
 * ── THE PLANT ──────────────────────────────────────────────────────────────
 * A green result is only evidence if it was capable of being red, so the same
 * relay is also driven by a client that does everything the runner does EXCEPT
 * the handshake — i.e. the defect, reproduced on purpose. It must show zero
 * forwarded frames, and verify-soak must grade the counters it produces
 * INVALID. The positive control and the plant differ by one boolean.
 *
 * Run:
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc node tests/soak-handshake.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';

import { verifySoak } from '../soak/verify-soak.mjs';
import { parseFrame } from '../soak/soak-runner.mjs';
import { seedEntitledUser, removeUser, mintSecret, relayUrls } from '../scripts/lib/relay-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATABASE_URL) {
  console.error('soak-handshake: DATABASE_URL is required (ccpix harness DB) — same contract as devicekey-authz.');
  process.exit(2);
}

// ── counted assertions, same contract as tests/soak-rig.test.mjs ───────────
// The gate parses the LAST `n/m` line out of stdout and judges by exit code.
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) passed += 1; else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
}
process.on('exit', () => {
  console.log(`\n${passed}/${passed + failed} checks passed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
});

// Rule 16: nothing this suite writes lands inside the tree it asserts on.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-handshake-'));
const SECRET = mintSecret();
/** Rule 14: every PID this file starts is recorded here and reaped in finally. */
const SPAWNED = [];

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/**
 * Boot the shipped relay and resolve once it is listening.
 *
 * E2E_PAIRING_ENABLED is left OFF on purpose: the soak runner deliberately
 * sends NO e2e block, so a plaintext Connect+Accept must work with the kill
 * switch in its production position. If this ever starts needing the switch on,
 * the runner has grown a dependency on it and the soak would be measuring the
 * switch rather than the forward path.
 */
async function bootRelay() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'lib', 'relay-boot.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: SECRET,
      E2E_PAIRING_ENABLED: '0',
      NODE_ENV: 'production',
      LEGACY_RELAY_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  SPAWNED.push(child.pid);
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`relay did not boot in 60s: ${log.join('')}`)), 60_000);
    const poll = setInterval(() => {
      if (log.join('').includes('RELAY_BOOTED')) { clearTimeout(t); clearInterval(poll); resolve(); }
    }, 100);
    child.once('exit', (code) => {
      clearTimeout(t); clearInterval(poll);
      reject(new Error(`relay exited ${code} before booting: ${log.join('')}`));
    });
  });
  return { port, child, log, ws: `ws://127.0.0.1:${port}` };
}

/** Kill one PID we started, and only that. Never by image name (rule 12). */
function reap(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * A minimal pair driver: phone + browser sockets against the real relay.
 *
 * `handshake: false` IS the plant — it reproduces the shipped-and-broken runner
 * exactly: open both roles, send data frames, never ask to pair. Everything
 * else about the two runs is identical, so a difference in forwarded frames is
 * attributable to the handshake and to nothing else.
 */
async function drivePair({ wsBase, user, handshake, ticks = 6, tickMs = 250, settleMs = 4000 }) {
  const urls = relayUrls({ wsBase, secret: SECRET, user });
  const state = { active: false, phoneActive: false, browserActive: false, recvBrowser: 0, sent: 0, dataRecv: 0 };
  const phone = new WebSocket(urls.phone());
  const browser = new WebSocket(urls.browser());
  let phoneLobby = false, browserLobby = false, requested = false;

  const maybeRequest = () => {
    if (!handshake || requested || !phoneLobby || !browserLobby) return;
    if (browser.readyState !== WebSocket.OPEN) return;
    requested = true;
    browser.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify({ ua: 'soak-test', ip: '127.0.0.1' })}`);
  };

  phone.on('message', (d) => {
    const { type, payload } = parseFrame(d.toString());
    if (type === 'LOBBY_STATUS') { phoneLobby = true; maybeRequest(); }
    if (type === 'PAIRING_REQUEST' && payload?.pairingId) {
      phone.send(`ACCEPT_PAIRING:${JSON.stringify({ pairingId: payload.pairingId })}`);
    }
    if (type === 'PAIRING_ACTIVE') { state.phoneActive = true; state.active = state.browserActive; }
  });
  browser.on('message', (d) => {
    state.recvBrowser += 1;
    const { type } = parseFrame(d.toString());
    if (type === 'LOBBY_STATUS') { browserLobby = true; maybeRequest(); }
    if (type === 'PHONE_PRESENT') { phoneLobby = true; maybeRequest(); }
    if (type === 'PAIRING_ACTIVE') { state.browserActive = true; state.active = state.phoneActive; }
    if (type === 'SMS_RECEIVED') state.dataRecv += 1;
  });

  try {
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (!handshake ? (phoneLobby && browserLobby) : state.active) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < ticks; i++) {
      if (phone.readyState === WebSocket.OPEN) {
        phone.send(`SMS_RECEIVED:${JSON.stringify({ text: `t${i}`, at: Date.now() })}`);
        state.sent += 1;
      }
      await new Promise((r) => setTimeout(r, tickMs));
    }
    // Let anything in flight land before the counters are read.
    await new Promise((r) => setTimeout(r, 1000));
    return state;
  } finally {
    try { phone.close(1000); } catch { /* closing */ }
    try { browser.close(1000); } catch { /* closing */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The shipped relay, the shipped runner, and the plant that differs by one
//    boolean.
// ═══════════════════════════════════════════════════════════════════════════
test('the REAL relay forwards only for a pair that completed Connect+Accept', async () => {
  const db = new PrismaClient();
  let relay = null;
  const seeded = [];
  try {
    relay = await bootRelay();
    check('server.js booted its relay on an ephemeral port', relay.port > 0, String(relay.port));

    const userOk = await seedEntitledUser(db, {}); seeded.push(userOk.id);
    const userPlant = await seedEntitledUser(db, {}); seeded.push(userPlant.id);

    // ── positive control ──────────────────────────────────────────────────
    const ok = await drivePair({ wsBase: relay.ws, user: userOk, handshake: true });
    check('both sockets reached PAIRING_ACTIVE', ok.phoneActive && ok.browserActive, JSON.stringify(ok));
    check('the relay forwarded the phone data frames to the browser',
      ok.dataRecv > 0 && ok.dataRecv >= ok.sent, JSON.stringify(ok));

    // ── THE PLANT: the shipped-and-broken behaviour, on the same relay ─────
    const plant = await drivePair({ wsBase: relay.ws, user: userPlant, handshake: false });
    check('a pair that skips the handshake never becomes active',
      !plant.phoneActive && !plant.browserActive, JSON.stringify(plant));
    check('PLANT IS RED: the relay forwarded NOTHING to a lobby pair',
      plant.sent > 0 && plant.dataRecv === 0, JSON.stringify(plant));
    // The two runs sent the same number of frames. Without this the plant could
    // "pass" by having sent nothing at all.
    check('the plant and the control sent the same number of frames',
      plant.sent === ok.sent, `plant=${plant.sent} ok=${ok.sent}`);

    // And the relay said so in its own words, which is what the 02:32Z log
    // showed and nobody's client was able to see.
    check('the relay logged the lobby drop for the un-paired frames',
      /Dropping lobby-phone frame/.test(relay.log.join('')),
      relay.log.join('').slice(-300));

    // ── the verifier's verdict on each shape ──────────────────────────────
    const grade = (counters) => {
      const hb = path.join(TMP, `hb-${crypto.randomBytes(4).toString('hex')}.jsonl`);
      const tr = path.join(TMP, `tr-${crypto.randomBytes(4).toString('hex')}.jsonl`);
      const t0 = Date.parse('2026-09-21T00:00:00.000Z');
      const beat = (m, kind, extra = {}) => JSON.stringify({
        utc: new Date(t0 + m * 60_000).toISOString(), kind, sha: 'abc1234', ...extra,
      });
      const lines = [beat(0, 'start', { hours: 1 })];
      for (let m = 5; m < 60; m += 5) {
        lines.push(beat(m, 'hb', {
          elapsedMin: m, rssMb: 120, unexpectedCloses: 0,
          onOpen: counters.framesRecvOn > 0, offOpen: counters.framesRecvOff > 0,
          onActive: counters.framesRecvOn > 0, offActive: counters.framesRecvOff > 0,
          fwdOn: counters.framesRecvOn, fwdOff: counters.framesRecvOff,
          pairingRejected: 0, pairingTerminated: 0,
        }));
      }
      lines.push(beat(60, 'end', { why: 'window-complete' }));
      fs.writeFileSync(hb, lines.join('\n') + '\n');
      const rec = (kind, m, extra = {}) => JSON.stringify({
        kind, utc: new Date(t0 + m * 60_000).toISOString(), sha: 'abc1234',
        elapsedMin: m, rssMb: 120, counters, ...extra,
      });
      fs.writeFileSync(tr, [rec('start', 0), rec('hourly', 30), rec('end', 60, { why: 'window-complete' })].join('\n') + '\n');
      return verifySoak({ files: [hb, tr], hours: 1 });
    };

    const good = grade({
      framesSentOn: ok.sent, framesSentOff: ok.sent,
      framesRecvOn: ok.dataRecv, framesRecvOff: ok.dataRecv, ticksSkippedNotActive: 0,
    });
    check('the verifier grades the forwarded window VALID', good.valid,
      good.checks.filter((c) => !c.ok).map((c) => c.name).join(' | '));

    const bad = grade({
      framesSentOn: plant.sent, framesSentOff: plant.sent,
      framesRecvOn: plant.dataRecv, framesRecvOff: plant.dataRecv, ticksSkippedNotActive: 0,
    });
    check('the verifier grades the lobby window INVALID', !bad.valid, JSON.stringify(bad.checks.filter((c) => !c.ok)));
    check('it is the traffic check that failed, by name',
      bad.checks.find((c) => c.name.includes('traffic actually flowed'))?.ok === false,
      JSON.stringify(bad.checks.find((c) => c.name.includes('traffic actually flowed'))));
  } finally {
    for (const id of seeded) await removeUser(db, id);
    await db.$disconnect();
    if (relay) reap(relay.child.pid);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The shipped runner, end to end, against the shipped relay.
//    Short cadence, real code path: a rehearsal of the 24 h window in 15 s.
// ═══════════════════════════════════════════════════════════════════════════
test('soak-runner.mjs pairs, forwards, and writes a heartbeat that says ACTIVE', async () => {
  const db = new PrismaClient();
  let relay = null;
  let runner = null;
  try {
    relay = await bootRelay();
    const evidence = path.join(TMP, 'evidence-runner');
    const before = new Set(await db.user.findMany({ select: { id: true } }).then((r) => r.map((x) => x.id)));

    runner = spawn(process.execPath, [path.join(ROOT, 'soak', 'soak-runner.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        SOAK_RELAY_WS: relay.ws,
        JWT_SECRET: SECRET,
        SOAK_EVIDENCE_DIR: evidence,
        SOAK_SHA: 'testsha',
        SOAK_HOURS: String(15 / 3600),
        SOAK_HEARTBEAT_MS: '2000',
        SOAK_TRACE_MS: '3000',
        SOAK_TRAFFIC_MS: '500',
        SOAK_DONE_CHECK_MS: '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    SPAWNED.push(runner.pid);
    const out = [];
    runner.stdout.on('data', (d) => out.push(String(d)));
    runner.stderr.on('data', (d) => out.push(String(d)));
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`runner did not finish in 90s: ${out.join('')}`)), 90_000);
      runner.once('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    check('the runner completed its window and exited 0', code === 0, `code=${code} ${out.join('').slice(-400)}`);

    const files = fs.readdirSync(evidence);
    const hbFile = path.join(evidence, files.find((f) => !f.startsWith('trace-')));
    const trFile = path.join(evidence, files.find((f) => f.startsWith('trace-')));
    const hb = fs.readFileSync(hbFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const tr = fs.readFileSync(trFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const beats = hb.filter((b) => b.kind === 'hb');

    check('the runner emitted heartbeats', beats.length >= 2, `${beats.length} beats`);
    check('every heartbeat reports BOTH pairs ACTIVE',
      beats.every((b) => b.onActive === true && b.offActive === true),
      JSON.stringify(beats.map((b) => [b.onActive, b.offActive])));
    check('onOpen/offOpen now mean ACTIVE, not merely connected',
      beats.every((b) => b.onOpen === true && b.offOpen === true), JSON.stringify(beats.slice(0, 2)));
    check('at least one heartbeat carries a non-zero fwdOn AND fwdOff delta',
      beats.some((b) => b.fwdOn > 0) && beats.some((b) => b.fwdOff > 0),
      JSON.stringify(beats.map((b) => [b.fwdOn, b.fwdOff])));

    const end = tr.find((x) => x.kind === 'end');
    check('the run ended because its window completed', end?.why === 'window-complete', JSON.stringify(end?.why));
    const c = end?.counters || {};
    check('both pairs formed exactly once (no re-pairing churn in a clean window)',
      c.pairingsOn === 1 && c.pairingsOff === 1, JSON.stringify(c));
    check('no pairing was rejected or terminated',
      (c.pairingRejected || 0) === 0 && (c.pairingTerminated || 0) === 0, JSON.stringify(c));
    check('the relay FORWARDED on both pairs (framesRecv, not framesSent)',
      c.framesRecvOn > 0 && c.framesRecvOff > 0, JSON.stringify(c));
    check('recv tracks sent at 90% or better',
      (c.framesRecvOn + c.framesRecvOff) / (c.framesSentOn + c.framesSentOff) >= 0.9,
      JSON.stringify(c));
    check('no tick was skipped for want of an active pair',
      (c.ticksSkippedNotActive || 0) === 0, JSON.stringify(c));
    check('zero unexpected closes', (c.closesUnexpected || 0) === 0, JSON.stringify(c));

    // Clean up the two users the runner seeded in the scratch DB. It has no
    // teardown of its own by design (a 24 h container is torn down with
    // `down -v`), so the suite that invoked it owns them.
    const after = await db.user.findMany({ select: { id: true } });
    for (const u of after) if (!before.has(u.id)) await removeUser(db, u.id);
  } finally {
    await db.$disconnect();
    if (runner?.pid) reap(runner.pid);
    if (relay) reap(relay.child.pid);
  }
});

test.after(() => {
  for (const pid of SPAWNED) reap(pid);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(`spawned PIDs reaped: ${SPAWNED.length}`);
});
