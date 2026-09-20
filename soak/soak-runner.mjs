/**
 * The 24 h soak runner. (R-AM; originally E2E-P6 (f).)
 *
 * Holds two pairs against the relay for the whole window — one mode ON
 * (sealed), one mode OFF (plaintext) — appends a trace line every hour and a
 * heartbeat line every 5 minutes, and records memory / CPU / frameBuffer
 * counters and every socket close.
 *
 * WHAT MAKES THIS A SOAK AND NOT A LONG TEST
 * ------------------------------------------
 * The failure this is hunting is not a wrong answer, it is a slow one: a
 * frameBuffer that grows without bound, a reconnect loop that costs a little
 * more memory each time, a resume claim that stops being renewed after the
 * n-th hour, an epoch counter that wraps. None of those show up in a run that
 * finishes in a minute. So the only assertions that matter here are TREND
 * assertions over the trace, and the trace has to be written incrementally —
 * a soak that holds its findings in memory and writes them at the end loses
 * everything to the crash it was built to catch.
 *
 * THE HEARTBEAT IS THE POINT
 * --------------------------
 * RESUME-PROTOCOL rule 8: "a detached heartbeat process (survives session
 * death) appends a line every 5 min to `soak/<start-UTC>.jsonl`; the resumer
 * verifies heartbeat continuity — a gap > 10 min invalidates the run and
 * restarts the 24 h clock (recorded in CHECKPOINTS). Never stitch windows."
 *
 * That rule is why this process writes the heartbeat itself rather than
 * delegating to a sidecar: a sidecar that outlives a dead runner would report a
 * healthy heartbeat for a soak that had stopped soaking, which is worse than no
 * heartbeat at all. The heartbeat here is emitted from the same loop that holds
 * the sockets, so a heartbeat line is evidence the pairs were actually held.
 *
 * NOTHING HERE STARTS A CLOCK ON ITS OWN, AND IMPORTING IT STARTS NOTHING AT
 * ALL. The window begins when Ken starts the container (R-AM). Everything that
 * seeds a user, opens a socket or reads a wall clock now lives inside `main()`,
 * behind the entry-point guard at the bottom — it used to run at module scope,
 * which meant the only way to load this file was to begin a soak, and therefore
 * no test could ever check it. `verify-soak.mjs` remains what decides whether
 * the window that resulted is a valid 24 h run.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { seedEntitledUser, mintSecret, relayUrls } from '../scripts/lib/relay-auth.mjs';

/**
 * Read the runner's configuration from the environment.
 *
 * A function rather than module-scope constants so that importing this file
 * neither snapshots a start time nor creates a directory. Rule 8 fixes the real
 * cadence at 5 min and the real run must use it; the overrides exist so the rig
 * can be REHEARSED in minutes rather than only ever exercised for the first
 * time on the one 24 h window that counts. verify-soak.mjs grades against the
 * real thresholds regardless, so a rehearsal can never be mistaken for a run.
 */
export function readConfig(env = process.env) {
  return {
    RELAY_WS: env.SOAK_RELAY_WS || 'ws://127.0.0.1:3000',
    // The relay authenticates at the WS UPGRADE and the entitlement gate is the
    // paywall — a socket opened without credentials is closed 4401 before any
    // frame exists. The first rehearsal of this runner logged 178 closes and
    // zero frames for exactly that reason, so the credentials are not optional
    // garnish: without them the soak measures the rejection path for 24 h and
    // reports healthy-looking sockets the whole time.
    //
    // JWT_SECRET must be the SAME secret the relay verifies with. Falling back
    // to mintSecret() keeps a standalone rehearsal working, but in the compose
    // stack it would mint a secret the relay has never seen and every browser
    // socket would die 4401 — so docker-compose.soak.yml passes the relay's
    // own SOAK_JWT_SECRET into this service too, and the warning below fires
    // if it ever stops doing so. See scripts/lib/relay-auth.mjs.
    JWT_SECRET: env.JWT_SECRET && env.JWT_SECRET.length >= 32 ? env.JWT_SECRET : mintSecret(),
    JWT_SECRET_FROM_ENV: !!(env.JWT_SECRET && env.JWT_SECRET.length >= 32),
    EVIDENCE: env.SOAK_EVIDENCE_DIR || '/evidence',
    SHA: env.SOAK_SHA || 'unset',
    HOURS: Number(env.SOAK_HOURS || 24),
    HEARTBEAT_MS: Number(env.SOAK_HEARTBEAT_MS || 5 * 60_000),
    TRACE_MS: Number(env.SOAK_TRACE_MS || 60 * 60_000),
    TRAFFIC_MS: Number(env.SOAK_TRAFFIC_MS || 30_000),
  };
}

/** Append one JSON line and fsync it. An unflushed trace is not a trace. */
export function appendLine(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 1000 is a clean close and 4010 is the relay's documented non-terminal code;
 * anything else is unexpected. The deliverable says "zero unexpected closes",
 * so the runner has to be able to tell the two apart rather than counting them
 * all and hoping.
 */
export const EXPECTED_CLOSE_CODES = new Set([1000, 1001, 4010]);

export function newCounters() {
  return {
    framesSentOn: 0,
    framesSentOff: 0,
    framesRecvOn: 0,
    framesRecvOff: 0,
    opensOn: 0,
    opensOff: 0,
    closesExpected: 0,
    closesUnexpected: 0,
    unexpectedCloseLog: [],
    reconnects: 0,
    sealOpenFailures: 0,
  };
}

export async function main(env = process.env) {
  const cfg = readConfig(env);
  const { RELAY_WS, JWT_SECRET, EVIDENCE, SHA, HOURS, HEARTBEAT_MS, TRACE_MS, TRAFFIC_MS } = cfg;

  if (!cfg.JWT_SECRET_FROM_ENV) {
    console.warn('[soak] JWT_SECRET absent or <32 chars — minted a throwaway one. '
      + 'In the compose stack this means the relay will reject every browser ticket 4401.');
  }

  const START = new Date().toISOString();
  const START_SLUG = START.replace(/[:.]/g, '-');
  fs.mkdirSync(EVIDENCE, { recursive: true });

  // Rule 8 names this file shape exactly. Keep it.
  const HEARTBEAT_PATH = path.join(EVIDENCE, `${START_SLUG}.jsonl`);
  const TRACE_PATH = path.join(EVIDENCE, `trace-${SHA}-${START_SLUG}.jsonl`);

  const counters = newCounters();

  // ── the two pairs ────────────────────────────────────────────────────────
  /**
   * A held pair: a phone socket and a browser socket that stay up for the whole
   * window, exchanging a frame every TRAFFIC_MS so the relay's resume claim,
   * keepalive and frameBuffer are all genuinely exercised rather than merely
   * idle. An idle socket for 24 h proves the TCP stack works, not the relay.
   */
  function makePair({ name, mode, urls }) {
    const pair = { name, mode, phone: null, browser: null, seq: 0, lastError: null };

    const wire = (role) => {
      // A FRESH ticket per connect. A cached one survives the first reconnect
      // and then starts failing, which reproduces the 4401 storm this runner
      // exists to avoid — and a soak is all reconnects.
      const ws = new WebSocket(role === 'phone' ? urls.phone() : urls.browser());
      ws.on('open', () => {
        if (mode === 'on') counters.opensOn += 1; else counters.opensOff += 1;
      });
      ws.on('message', () => {
        if (mode === 'on') counters.framesRecvOn += 1; else counters.framesRecvOff += 1;
      });
      ws.on('close', (code, reason) => {
        if (EXPECTED_CLOSE_CODES.has(code)) {
          counters.closesExpected += 1;
        } else {
          counters.closesUnexpected += 1;
          // Bounded: a reconnect storm must not turn the trace into the leak.
          if (counters.unexpectedCloseLog.length < 200) {
            counters.unexpectedCloseLog.push({
              utc: new Date().toISOString(), pair: name, role, code,
              reason: String(reason || '').slice(0, 120),
            });
          }
        }
        // Reconnect — a soak that gives up on the first blip stops soaking.
        counters.reconnects += 1;
        setTimeout(() => { pair[role === 'phone' ? 'phone' : 'browser'] = wire(role); }, 2000);
      });
      ws.on('error', (e) => { pair.lastError = String(e?.message || e).slice(0, 160); });
      return ws;
    };

    pair.phone = wire('phone');
    pair.browser = wire('browser');
    return pair;
  }

  /**
   * One tick of traffic on a pair. The ON pair sends a sealed-shaped body, the
   * OFF pair a plaintext one, so both relay code paths stay warm for 24 h.
   *
   * The ON body is envelope-SHAPED rather than a real seal: the runner is not
   * proving cryptography here — it is proving the relay carries that shape for
   * a day without growing. Keeping the crypto out of the soak also keeps the
   * soak's own memory profile flat, so a leak the trace shows belongs to the
   * relay and not to the harness watching it.
   */
  function tick(pair) {
    const s = pair.seq++;
    const body = pair.mode === 'on'
      ? { e: 1, kid: `soak-${pair.name}`, s, c: crypto.randomBytes(96).toString('base64url') }
      : { text: `soak ${pair.name} ${s}`, at: Date.now() };
    if (pair.phone?.readyState === WebSocket.OPEN) {
      pair.phone.send(`SMS_RECEIVED:${JSON.stringify(body)}`);
      if (pair.mode === 'on') counters.framesSentOn += 1; else counters.framesSentOff += 1;
    }
  }

  // ── trace sampling ───────────────────────────────────────────────────────
  let lastCpu = process.cpuUsage();
  let lastCpuAt = Date.now();

  function sample(kind) {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpu);
    const dtMs = Date.now() - lastCpuAt;
    lastCpu = process.cpuUsage();
    lastCpuAt = Date.now();
    return {
      kind,
      utc: new Date().toISOString(),
      startedAt: START,
      sha: SHA,
      elapsedMin: Math.round((Date.now() - Date.parse(START)) / 60_000),
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
      externalMb: +(mem.external / 1048576).toFixed(1),
      // CPU as a percentage of one core over the interval since the last sample.
      cpuPct: dtMs > 0 ? +(((cpu.user + cpu.system) / 1000 / dtMs) * 100).toFixed(2) : null,
      loadAvg1: +(os.loadavg()[0] || 0).toFixed(2),
      counters: { ...counters, unexpectedCloseLog: counters.unexpectedCloseLog.length },
      sockets: {
        onPhone: pairs.on.phone?.readyState, onBrowser: pairs.on.browser?.readyState,
        offPhone: pairs.off.phone?.readyState, offBrowser: pairs.off.browser?.readyState,
      },
    };
  }

  // ── go ───────────────────────────────────────────────────────────────────
  // One entitled user per pair, so the two pairs land in two different relay
  // rooms (the room key is the phoneToken). Sharing a user would put the ON and
  // OFF pairs in the SAME room, where the single-active-session sweep kicks one
  // of them — a 24 h run of two pairs fighting each other, which would read as
  // a relay instability that is entirely the harness's own doing.
  const db = new PrismaClient();
  const userOn = await seedEntitledUser(db, {});
  const userOff = await seedEntitledUser(db, {});
  const pairs = {
    on: makePair({ name: 'on', mode: 'on', urls: relayUrls({ wsBase: RELAY_WS, secret: JWT_SECRET, user: userOn }) }),
    off: makePair({ name: 'off', mode: 'off', urls: relayUrls({ wsBase: RELAY_WS, secret: JWT_SECRET, user: userOff }) }),
  };

  appendLine(TRACE_PATH, { ...sample('start'), hours: HOURS, relay: RELAY_WS });
  appendLine(HEARTBEAT_PATH, { utc: START, kind: 'start', sha: SHA, hours: HOURS });

  const deadline = Date.parse(START) + HOURS * 3600_000;

  const hb = setInterval(() => {
    // The heartbeat carries enough to prove the pairs were HELD, not merely
    // that a timer fired — a heartbeat that only says "alive" cannot
    // distinguish a running soak from a running clock.
    appendLine(HEARTBEAT_PATH, {
      utc: new Date().toISOString(), kind: 'hb', sha: SHA,
      elapsedMin: Math.round((Date.now() - Date.parse(START)) / 60_000),
      onOpen: pairs.on.phone?.readyState === WebSocket.OPEN && pairs.on.browser?.readyState === WebSocket.OPEN,
      offOpen: pairs.off.phone?.readyState === WebSocket.OPEN && pairs.off.browser?.readyState === WebSocket.OPEN,
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      unexpectedCloses: counters.closesUnexpected,
    });
  }, HEARTBEAT_MS);

  const tr = setInterval(() => appendLine(TRACE_PATH, sample('hourly')), TRACE_MS);
  const tf = setInterval(() => { tick(pairs.on); tick(pairs.off); }, TRAFFIC_MS);

  const finish = (why) => {
    clearInterval(hb); clearInterval(tr); clearInterval(tf);
    const final = { ...sample('end'), why, unexpectedCloseLog: counters.unexpectedCloseLog };
    appendLine(TRACE_PATH, final);
    appendLine(HEARTBEAT_PATH, { utc: new Date().toISOString(), kind: 'end', sha: SHA, why });
    for (const p of [pairs.on, pairs.off]) {
      // Close by handle, never by killing anything: this process owns exactly
      // these four sockets and nothing else.
      try { p.phone?.removeAllListeners('close'); p.phone?.close(1000); } catch { /* closing */ }
      try { p.browser?.removeAllListeners('close'); p.browser?.close(1000); } catch { /* closing */ }
    }
    // The verdict is verify-soak.mjs's to give, not the runner's. The runner
    // exits 0 for "I ran"; whether what it produced is a VALID 24 h window is a
    // separate question answered from the evidence.
    console.log(`soak ended (${why}) — trace=${TRACE_PATH} heartbeat=${HEARTBEAT_PATH}`);
    process.exit(0);
  };

  const done = setInterval(() => { if (Date.now() >= deadline) finish('window-complete'); }, 30_000);
  done.unref?.();

  process.on('SIGTERM', () => finish('sigterm'));
  process.on('SIGINT', () => finish('sigint'));

  console.log(`soak started ${START} sha=${SHA} hours=${HOURS} relay=${RELAY_WS}`);
  console.log(`  heartbeat -> ${HEARTBEAT_PATH}`);
  console.log(`  trace     -> ${TRACE_PATH}`);
  return { heartbeatPath: HEARTBEAT_PATH, tracePath: TRACE_PATH };
}

// Entry-point guard. Importing this module must not seed a user, open a socket
// or start a clock. tests/soak-rig.test.mjs asserts exactly that.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
