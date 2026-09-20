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
 * THE PAIRS MUST BE ACTIVE, NOT MERELY CONNECTED
 * -----------------------------------------------
 * The first execution of this rig (Hetzner 2026-09-20T02:32Z) opened all four
 * sockets, authed cleanly, logged zero 4401 — and soaked nothing. The relay's
 * model is Connect+Accept (server.js startRelay docblock, dispatch #32): every
 * socket lands in `room.lobby`, and the data plane forwards ONLY between
 * `room.active.browser` and `room.active.phone`. A pair that never performs the
 * handshake stays in the lobby forever and every frame it sends is dropped and
 * logged (`Dropping lobby-phone frame`). That run was a 24 h soak of the
 * rejection path wearing a healthy heartbeat.
 *
 * So the runner now drives the real handshake, in the relay's own words:
 *
 *   browser --BROWSER_REQUEST_PAIRING:{ua,ip}--> relay
 *   relay   --PAIRING_REQUEST:{pairingId,...}--> phone
 *   phone   --ACCEPT_PAIRING:{pairingId}------> relay
 *   relay   --PAIRING_ACTIVE:{...}------------> BOTH
 *
 * and a pair is "open" only once BOTH of its sockets have seen PAIRING_ACTIVE.
 * The heartbeat's onOpen/offOpen now mean exactly that — sockets-open is no
 * longer sufficient, because sockets-open is the state that lied.
 *
 * WE RE-RUN THE HANDSHAKE ON EVERY RECONNECT rather than leaning on the relay's
 * resume claim. The claim (RESUME_WINDOW_MS soft hold) only re-forms a pair
 * when the SAME room's surviving peer is still active and the drop is inside
 * the window; outside it the relay sends PAIRING_TERMINATED and both sockets
 * return to the lobby. A soak whose recovery depended on the claim would go
 * quietly back to lobby-soaking the first time a reconnect fell outside the
 * window — the exact failure this fix exists to remove — so the runner re-arms
 * unconditionally and the relay's own `already_active` reject is what makes
 * that idempotent. PAIRING_ACTIVE arriving from a resume is indistinguishable
 * from one arriving from a fresh accept, and both are counted.
 *
 * TRAFFIC IS COUNTED WHERE IT LANDS. framesSent* only increments for a frame
 * the runner sent while the pair was ACTIVE, and framesRecv* counts frames on
 * the BROWSER socket — i.e. frames the relay actually forwarded. Counting sends
 * alone is how the first verifier would have graded a zero-forward window VALID.
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
    // How often the runner asks "is the window over yet". 30 s is right for a
    // 24 h window and wrong for a 15 s rehearsal, where it would add half a
    // minute of idling to every run of tests/soak-handshake.test.mjs. Same
    // rationale as the cadence overrides above: the REAL run uses the default,
    // and verify-soak grades against the real thresholds regardless.
    DONE_CHECK_MS: Number(env.SOAK_DONE_CHECK_MS || 30_000),
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

/**
 * Relay control frames that mean the pair is NOT active and must not be
 * mistaken for noise. PAIRING_REJECTED is the relay refusing to form the pair
 * at all; PAIRING_TERMINATED is an active pair being torn down. Both are
 * counted as unexpected: in a healthy window with zero unexpected closes and
 * zero reconnects neither can legitimately occur, and a window that saw them
 * spent part of itself back in the lobby.
 */
export const UNEXPECTED_PAIRING_FRAMES = new Set(['PAIRING_REJECTED', 'PAIRING_TERMINATED']);

/**
 * Split a relay frame into `TYPE` and its JSON payload.
 *
 * The wire format is `TYPE:{json}` at every server.js safeSend site. Exported
 * so the handshake logic is testable without a socket, and so an unparseable
 * payload on a known type comes back marked rather than swallowed — protocol
 * drift is not something a 24 h window should absorb silently.
 */
export function parseFrame(raw) {
  const text = typeof raw === 'string' ? raw : String(raw);
  const i = text.indexOf(':');
  if (i === -1) return { type: text, payload: null, parsed: false };
  const type = text.slice(0, i);
  try { return { type, payload: JSON.parse(text.slice(i + 1)), parsed: true }; }
  catch { return { type, payload: null, parsed: false }; }
}

export function newCounters() {
  return {
    framesSentOn: 0,
    framesSentOff: 0,
    // Counted on the BROWSER socket only: these are the frames the relay CHOSE
    // to forward. Counting the phone socket's receives too would fold the
    // runner's own control-plane traffic in and prove nothing about the data
    // plane, which is the only thing a forward-path soak is about.
    framesRecvOn: 0,
    framesRecvOff: 0,
    opensOn: 0,
    opensOff: 0,
    closesExpected: 0,
    closesUnexpected: 0,
    unexpectedCloseLog: [],
    reconnects: 0,
    sealOpenFailures: 0,
    // Handshake bookkeeping. pairingsOn/Off is how many times each pair reached
    // PAIRING_ACTIVE on BOTH sockets — 1 for a clean window, more only if it
    // had to re-form after a reconnect.
    pairingsOn: 0,
    pairingsOff: 0,
    pairingRequests: 0,
    pairingRejected: 0,
    pairingTerminated: 0,
    pairingTimeouts: 0,
    // Frames the runner declined to send because its pair was not active. A
    // non-zero value on a window with no reconnects means the relay never let
    // the pair form — the exact defect this file was rewritten to expose.
    ticksSkippedNotActive: 0,
  };
}

export async function main(env = process.env) {
  const cfg = readConfig(env);
  const { RELAY_WS, JWT_SECRET, EVIDENCE, SHA, HOURS, HEARTBEAT_MS, TRACE_MS, TRAFFIC_MS, DONE_CHECK_MS } = cfg;

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
    const pair = {
      name, mode, phone: null, browser: null, seq: 0, lastError: null,
      // Handshake state. `active` is the ONLY thing that makes this pair count
      // as open — see the heartbeat below.
      active: false,
      phoneActive: false,
      browserActive: false,
      phoneLobby: false,
      browserLobby: false,
      pendingRequest: false,
      retryTimer: null,
    };

    const recvBump = () => { if (mode === 'on') counters.framesRecvOn += 1; else counters.framesRecvOff += 1; };
    const activeBump = () => { if (mode === 'on') counters.pairingsOn += 1; else counters.pairingsOff += 1; };

    /** Both sides saw PAIRING_ACTIVE — and only then is the data plane open. */
    const settleActive = () => {
      if (pair.active || !pair.phoneActive || !pair.browserActive) return;
      pair.active = true;
      pair.pendingRequest = false;
      activeBump();
    };

    /**
     * Back to the lobby. Clears BOTH halves of the active flag, so a stale
     * PAIRING_ACTIVE still in flight to the other side cannot re-open the pair
     * on its own.
     */
    const dropToLobby = () => {
      pair.active = false;
      pair.phoneActive = false;
      pair.browserActive = false;
      pair.pendingRequest = false;
    };

    /**
     * Ask the relay to form the pair.
     *
     * Guarded on BOTH sockets having reached the lobby, because
     * BROWSER_REQUEST_PAIRING with no phone in the room is answered
     * `PAIRING_REJECTED:{reason:'already_pending'}` (server.js maps the
     * no-phone case onto that existing reason deliberately). Retried on every
     * reject/timeout: a soak that gives up on the handshake is the bug.
     */
    const requestPairing = () => {
      if (pair.active || pair.pendingRequest) return;
      if (!pair.phoneLobby || !pair.browserLobby) return;
      if (pair.browser?.readyState !== WebSocket.OPEN) return;
      pair.pendingRequest = true;
      counters.pairingRequests += 1;
      // No `e2e` block. Mode ON here means a sealed-SHAPED data body, not a
      // real encrypted pairing; sending a mode=1 block would put the handshake
      // at the mercy of E2E_PAIRING_ENABLED (server.js refuses it outright when
      // the kill switch is off) and the soak would be measuring the kill switch
      // instead of the forward path.
      pair.browser.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify({
        ua: `soak-runner/${name}`, ip: '127.0.0.1',
      })}`);
    };

    const retryPairing = () => {
      clearTimeout(pair.retryTimer);
      pair.retryTimer = setTimeout(requestPairing, 2000);
      pair.retryTimer.unref?.();
    };

    const onPhoneFrame = (raw) => {
      const { type, payload } = parseFrame(raw);
      switch (type) {
        case 'LOBBY_STATUS':
          pair.phoneLobby = true;
          requestPairing();
          break;
        case 'PAIRING_REQUEST':
          // The accept must echo the relay's OWN pairingId; a mismatch is
          // ignored ("ACCEPT_PAIRING ignored — id mismatch") and the pair would
          // silently never form.
          if (payload?.pairingId && pair.phone?.readyState === WebSocket.OPEN) {
            pair.phone.send(`ACCEPT_PAIRING:${JSON.stringify({ pairingId: payload.pairingId })}`);
          }
          break;
        case 'PAIRING_ACTIVE':
          pair.phoneActive = true;
          settleActive();
          break;
        case 'PAIRING_CANCELLED':
          counters.pairingTimeouts += 1;
          dropToLobby();
          retryPairing();
          break;
        case 'PAIRING_TERMINATED':
          counters.pairingTerminated += 1;
          dropToLobby();
          retryPairing();
          break;
        default:
          break;
      }
    };

    const onBrowserFrame = (raw) => {
      recvBump();
      const { type } = parseFrame(raw);
      switch (type) {
        case 'LOBBY_STATUS':
          pair.browserLobby = true;
          requestPairing();
          break;
        case 'PHONE_PRESENT':
          pair.phoneLobby = true;
          requestPairing();
          break;
        case 'PAIRING_ACTIVE':
          pair.browserActive = true;
          settleActive();
          break;
        case 'PAIRING_REJECTED':
          counters.pairingRejected += 1;
          pair.pendingRequest = false;
          retryPairing();
          break;
        case 'PAIRING_TIMEOUT':
          counters.pairingTimeouts += 1;
          dropToLobby();
          retryPairing();
          break;
        case 'PAIRING_TERMINATED':
          counters.pairingTerminated += 1;
          dropToLobby();
          retryPairing();
          break;
        default:
          break;
      }
    };

    const wire = (role) => {
      // A FRESH ticket per connect. A cached one survives the first reconnect
      // and then starts failing, which reproduces the 4401 storm this runner
      // exists to avoid — and a soak is all reconnects.
      const ws = new WebSocket(role === 'phone' ? urls.phone() : urls.browser());
      ws.on('open', () => {
        if (mode === 'on') counters.opensOn += 1; else counters.opensOff += 1;
      });
      ws.on('message', (data) => {
        if (role === 'phone') onPhoneFrame(data.toString());
        else onBrowserFrame(data.toString());
      });
      ws.on('close', (code, reason) => {
        // This socket is gone, so the pair is not active whatever the other
        // half still believes — and the lobby flag for THIS role resets, so the
        // reconnect's own LOBBY_STATUS is what re-arms the handshake.
        if (role === 'phone') pair.phoneLobby = false; else pair.browserLobby = false;
        dropToLobby();
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

    // Phone first. BROWSER_REQUEST_PAIRING needs a phone already in the lobby;
    // the handshake retries regardless, but this order keeps the common path
    // free of a rejected first attempt.
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
    // NOT ACTIVE, NOT SENT. A frame from a lobby socket is dropped by the relay
    // and logged; counting it as "sent" is precisely what let the first window
    // report traffic it never carried. Skips are counted instead, so a window
    // that never paired is loud in its own trace rather than silent.
    if (!pair.active || pair.phone?.readyState !== WebSocket.OPEN) {
      counters.ticksSkippedNotActive += 1;
      return;
    }
    const s = pair.seq++;
    const body = pair.mode === 'on'
      ? { e: 1, kid: `soak-${pair.name}`, s, c: crypto.randomBytes(96).toString('base64url') }
      : { text: `soak ${pair.name} ${s}`, at: Date.now() };
    pair.phone.send(`SMS_RECEIVED:${JSON.stringify(body)}`);
    if (pair.mode === 'on') counters.framesSentOn += 1; else counters.framesSentOff += 1;
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
      active: { on: pairs.on.active === true, off: pairs.off.active === true },
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

  // fwdOn/fwdOff are DELTAS: frames the relay forwarded to the browser socket
  // since the previous beat. A cumulative number can only ever go up and so
  // looks healthy forever after one good minute; a delta that goes to zero
  // names the beat where forwarding stopped.
  let lastRecvOn = 0, lastRecvOff = 0;

  const hb = setInterval(() => {
    // The heartbeat carries enough to prove the pairs were HELD, not merely
    // that a timer fired — a heartbeat that only says "alive" cannot
    // distinguish a running soak from a running clock.
    //
    // onOpen/offOpen NOW MEAN ACTIVE. Sockets-open was the field that lied in
    // the 02:32Z window: all four sockets were open for the whole run and not
    // one frame was forwarded. A pair is open here only when both its sockets
    // are OPEN *and* both have seen PAIRING_ACTIVE.
    const open = (p) => p.phone?.readyState === WebSocket.OPEN
      && p.browser?.readyState === WebSocket.OPEN && p.active === true;
    const fwdOn = counters.framesRecvOn - lastRecvOn;
    const fwdOff = counters.framesRecvOff - lastRecvOff;
    lastRecvOn = counters.framesRecvOn;
    lastRecvOff = counters.framesRecvOff;
    appendLine(HEARTBEAT_PATH, {
      utc: new Date().toISOString(), kind: 'hb', sha: SHA,
      elapsedMin: Math.round((Date.now() - Date.parse(START)) / 60_000),
      onOpen: open(pairs.on),
      offOpen: open(pairs.off),
      // Stated separately from onOpen so a future reader can tell "socket died"
      // apart from "socket fine, pair fell back to the lobby".
      onActive: pairs.on.active === true,
      offActive: pairs.off.active === true,
      fwdOn,
      fwdOff,
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      unexpectedCloses: counters.closesUnexpected,
      pairingRejected: counters.pairingRejected,
      pairingTerminated: counters.pairingTerminated,
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
      // The handshake retry timer is ours too — an un-cleared one would keep
      // the loop alive past the window and re-arm a pair we are tearing down.
      clearTimeout(p.retryTimer);
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

  const done = setInterval(() => { if (Date.now() >= deadline) finish('window-complete'); }, DONE_CHECK_MS);
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
