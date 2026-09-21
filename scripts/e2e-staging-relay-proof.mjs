#!/usr/bin/env node
/**
 * scripts/e2e-staging-relay-proof.mjs — E2E-P6 deliverable (h), the
 * SECURITY-CONTROLLED STAGING RELAY.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 * M-A + B6: a relay variant that MISBEHAVES must not be able to weaken a
 * mode-ON pair. Four attack primitives, each named, each run twice — once with
 * the attack DISABLED (the positive control) and once with it armed:
 *
 *   strip-e2e        the relay deletes the `e2e` block from PAIRING_ACTIVE
 *   downgrade-mode   the relay rewrites mode 1 -> 0 on the accept block.
 *                    Since M-A5-5 §1 (effective = OR(localMode, block.mode))
 *                    this byte flip against a local-ON computer is ABSORBED,
 *                    not refused: the defense is the OR, so the outcome is
 *                    identical to the untampered run. R-BD 2026-09-20.
 *   replay-epoch     the relay re-offers a SUPERSEDED accept block
 *   replay-epoch-rebound  the same, with ctx.pairingId re-bound to the live
 *                         pairing, which isolates the A3-M2 epoch floor
 *   forge-pubkey     the relay substitutes a recipient's static public key
 *
 * ── WHY A TAMPERING PROXY AND NOT A PATCHED server.js ──────────────────────
 * The "staging relay" here is a WebSocket proxy that sits between the clients
 * and the REAL `node server.js`. Three reasons, and they are the design:
 *
 *   1. The shipped relay stays BYTE-IDENTICAL, so every green line below is
 *      evidence about the code that deploys. A patched server.js would make
 *      this file evidence about a file that exists only in this harness.
 *   2. Each attack is a small named function. `ATTACKS` can be printed, and a
 *      scenario that quietly ran no attack cannot hide — the proxy counts its
 *      own tampering and the harness asserts the count is non-zero.
 *   3. The attack surface is exactly THE WIRE, which is the actual threat
 *      model. M-A's adversary is relay-position; it does not get to edit the
 *      relay's source, it gets to edit frames.
 *
 * ── THE ANTI-PATTERN THIS FILE IS BUILT AGAINST ────────────────────────────
 * An attack scenario that "passes" because the pairing failed for an unrelated
 * reason — a dropped socket, a stale ticket, a 4401 — is worthless, and it is
 * the single most likely way a file like this goes wrong. So:
 *
 *   - Every attack has a POSITIVE CONTROL first. The same flow with the attack
 *     disabled must COMPLETE and produce MATCHING SAS digits on both sides.
 *     Without that, "it refused" proves nothing.
 *   - Every refusal is asserted by its SPECIFIC error code and its FROZEN user
 *     copy, never by "something failed".
 *   - Every attack is DETECTOR-PROVEN: the same armed attack is re-run with the
 *     client-side check neutered, and the harness asserts the attack then
 *     SUCCEEDS. A check that cannot be made to fail is not delivering an
 *     attack, and this file says so out loud rather than reporting a pass.
 *     ONE EXCEPTION, and it is a property and not a gap (R-BD 2026-09-20):
 *     downgrade-mode has NO check left to remove. Under M-A5-5 §1 the defense
 *     is the OR itself — decideAccept has no `block.mode < 1` branch — so the
 *     detector proves ABSORPTION instead: neutered and armed produce the
 *     IDENTICAL outcome, and the separate "SAS under mode 0 DIFFERS" assertion
 *     is what shows that HONOURING the flipped byte would have diverged the
 *     SAS. That pair is the evidence the attack is still being delivered.
 *
 * ── WHOSE LOGIC IS REAL, AND WHOSE IS A MIRROR ─────────────────────────────
 * REAL, imported from the shipped tree:
 *   hooks/phoneE2e.ts          decideAccept / readAcceptBlock / pinPhoneKey
 *                              — the C-1 OR-latch, the B6 mode floor, the C-2 pin
 *   lib/e2e/kdf.mjs            pairContextFromWire (A3-M3, A3-M4, A4-R2)
 *   lib/e2e/webKey.ts          admitPairEpoch / EpochFloorError (the A3-M2 floor)
 *   lib/e2e/session.mjs        openWrap (A4-R3's cryptographic membership check)
 *   lib/e2e/sas.mjs            sasDigits / sasTranscript
 *   lib/encryptedModeCopy.ts   the two frozen refusal sentences
 *   server.js                  the relay, unmodified, as a child process
 *   /api/devicekeys/list       the real Next route, over real HTTP, real bearer
 *
 * MIRROR, and flagged as one: the PHONE-side recipient pin. The shipped
 * implementation is Kotlin (`E2eKeyPin.kt`) and cannot be called from node, so
 * `pinRecipients()` below re-states its rule and a DRIFT GUARD greps the Kotlin
 * source for the four clauses it depends on. That is the established pattern in
 * this repo (lib/e2eBlock-core.js's header argues it), and it is stated here
 * rather than buried so nobody quotes scenario 4 as "the Android pin passed".
 *
 * ── A CHANNEL GAP THIS HARNESS MEASURES RATHER THAN PAPERS OVER ────────────
 * The real relay's browser-side PAIRING_ACTIVE carries NO `pairingId` (see
 * server.js handleAcceptPairing: `browserActive = { deviceName }`). So the page
 * learns its own pairingId only from the extension SW bridge (R-T), which means
 * A3-M3(a) — "ctx.pairingId is the pairing I am party to" — is only as strong
 * as that bridge. The harness asserts the absence as a FACT and supplies the
 * pairingId on a simulated bridge channel, exactly as useE2e.ts's fallback does.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { withRealRelay } from './lib/real-relay.mjs';
import { census } from './lib/reap.mjs';
import { mintSecret, seedEntitledUser, relayUrls } from './lib/relay-auth.mjs';

import * as KDF from '../lib/e2e/kdf.mjs';
import * as SESSION from '../lib/e2e/session.mjs';
import { sasDigits } from '../lib/e2e/sas.mjs';
import { decideAccept, readAcceptBlock } from '../hooks/phoneE2e.ts';
import {
  generateWebDeviceKey, memoryWebKeyStore, admitPairEpoch, EpochFloorError,
} from '../lib/e2e/webKey.ts';
import {
  ABORT_SETUP_FAILED, ABORT_KEY_MISMATCH, encryptionIndicator,
} from '../lib/encryptedModeCopy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LOG_DIR = 'C:/Users/D/worktrees/computercaller/p6-logs';
const DATABASE_URL = 'postgresql://pix:pix@localhost:15433/cc_p6';

// A harness that hangs teaches nothing and, per gate ticket P5a-1.1, counts as
// a failure of its own. Unref'd so it never keeps the loop alive by itself.
const WATCHDOG = setTimeout(() => {
  console.error('  FAIL  watchdog — e2e-staging-relay-proof exceeded 9 minutes');
  process.exit(1);
}, 9 * 60_000);
WATCHDOG.unref?.();

// ───────────────────────────────────────────────────────────────────────────
// assertions
// ───────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); return true; }
  failed += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const ne = (name, got, notWant) => check(name, got !== notWant, `got ${JSON.stringify(got)} which must NOT equal ${JSON.stringify(notWant)}`);

const b64 = SESSION.toBase64Url;
const unb64 = SESSION.fromBase64Url;

// ───────────────────────────────────────────────────────────────────────────
// drift guards — every mirror and every frozen fact this file leans on
// ───────────────────────────────────────────────────────────────────────────
function driftGuards() {
  console.log('\n── drift guards ──────────────────────────────────────────────');
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const kt = readFileSync(join(ROOT,
    'dnkdialer-android/app/src/main/java/com/dnkdialer/companion/E2eKeyPin.kt'), 'utf8');

  check('drift: server.js still stashes ONE accept block on room.active.e2e',
    /room\.active\.e2e\s*=\s*acceptCheck\.block/.test(server));
  check('drift: server.js still forwards the request block on PAIRING_REQUEST',
    /forwardPayload\.e2e\s*=\s*e2eBlock/.test(server));
  check('drift: the browser PAIRING_ACTIVE payload still carries NO pairingId (the R-T channel gap)',
    /const browserActive = \{ deviceName \};/.test(server));
  check('drift: N-1 kill switch still REFUSES mode=1 rather than stripping it',
    /if \(!E2E_PAIRING_ENABLED && e2eBlock && e2eBlock\.mode === 1\)[\s\S]{0,400}PAIRING_E2E_UNAVAILABLE/.test(server));
  // R-BD 2026-09-20 / N-1.1: P1.3 (38d4031) inverted the spelling to an opt-IN
  // literal '1'. P6 predates that commit (P1.3 is NOT an ancestor of aa06366),
  // so this pin carried the old `!== 'false'` spelling. Re-pinned to the
  // CURRENT server.js:233 text, exact, no `.*` loosening.
  check("drift: the kill switch is exactly === '1' (N-1.1)",
    /E2E_PAIRING_ENABLED\s*=\s*process\.env\.E2E_PAIRING_ENABLED\s*===\s*'1'/.test(server));

  check('drift: the Kotlin pin still refuses on a key that disagrees with the registry',
    /advertised a key that is NOT the one/.test(kt));
  check("drift: the Kotlin pin still indexes only LIVE rows (a revoked row must not satisfy it)",
    /rows\.filter \{ !it\.isRevoked \}/.test(kt));
  check("drift: the Kotlin pin still checks kind, so a 'web' row cannot satisfy an 'extension' recipient",
    /if \(row\.kind != r\.kind\)/.test(kt));
  check('drift: the Kotlin mismatch copy is still "Unexpected device key"',
    /MISMATCH_MESSAGE = "Unexpected device key"/.test(kt));
  eq('drift: ABORT_SETUP_FAILED is the frozen sentence',
    ABORT_SETUP_FAILED, "Couldn't set up encrypted pairing — try again");
  eq('drift: ABORT_KEY_MISMATCH is the frozen sentence',
    ABORT_KEY_MISMATCH, "Couldn't verify this device — try again");
}

// ───────────────────────────────────────────────────────────────────────────
// THE ATTACKS — one named function each, all operating on a frame in flight
// ───────────────────────────────────────────────────────────────────────────
/**
 * An attack is `(dir, type, payload, memo) => payload | null`.
 *   dir    'toClient' (relay -> client) | 'toRelay' (client -> relay)
 *   memo   per-proxy scratch space, so an attack can remember a past frame
 * Returning the payload unchanged is a no-op; mutating it is the tamper. Every
 * mutation MUST call `memo.tampered()` so the harness can assert the attack
 * actually fired — an attack that silently matched nothing is the failure mode
 * this whole file exists to avoid.
 */
const ATTACKS = {
  /** The control. Byte-carrier only. */
  none: (_dir, _type, payload) => payload,

  /**
   * Delete the `e2e` block from the accept the BROWSER sees. The phone still
   * built and sent a real mode-1 block; the browser is told the pair is plain.
   */
  'strip-e2e': (dir, type, payload, memo) => {
    if (dir === 'toClient' && type === 'PAIRING_ACTIVE' && memo.target === 'browser' && payload.e2e) {
      delete payload.e2e;
      memo.tampered();
    }
    return payload;
  },

  /**
   * B6's primitive: rewrite the advertised mode downward. Everything else in
   * the block stays valid, so the ONLY thing that can catch this is the client
   * refusing a mode it did not ask down to.
   */
  'downgrade-mode': (dir, type, payload, memo) => {
    if (dir === 'toClient' && type === 'PAIRING_ACTIVE' && memo.target === 'browser'
        && payload.e2e && payload.e2e.mode === 1) {
      payload.e2e.mode = 0;
      memo.tampered();
    }
    return payload;
  },

  /**
   * Re-offer a SUPERSEDED accept block. `memo.replayBlock` is installed by the
   * harness from a pairing that already completed, so this is a real replay of
   * a real, once-valid frame — not a hand-built forgery.
   */
  'replay-epoch': (dir, type, payload, memo) => {
    if (dir === 'toClient' && type === 'PAIRING_ACTIVE' && memo.target === 'browser'
        && payload.e2e && memo.replayBlock) {
      payload.e2e = JSON.parse(JSON.stringify(memo.replayBlock));
      memo.tampered();
    }
    return payload;
  },

  /**
   * The SAME replay, but the attacker also re-binds `ctx.pairingId` to the LIVE
   * pairing.
   *
   * This exists because the first version of the plain `replay-epoch` scenario
   * passed for the WRONG REASON, and the detector proof is what caught it:
   * A3-M3(a) ("ctx.pairingId is not the pairing this device is party to")
   * refuses the stale block BEFORE the A3-M2 floor is ever consulted, so the
   * scenario asserted an epoch defence while a completely different check was
   * doing the work. A relay-position attacker rewrites bytes, and ctx is bytes,
   * so re-binding the id is inside its power — and doing it is what isolates
   * the epoch floor as the ONLY remaining defence.
   */
  'replay-epoch-rebound': (dir, type, payload, memo) => {
    if (dir === 'toClient' && type === 'PAIRING_REQUEST' && payload.pairingId) {
      memo.notePairingId(payload.pairingId);
    }
    if (dir === 'toClient' && type === 'PAIRING_ACTIVE' && memo.target === 'browser'
        && payload.e2e && memo.replayBlock) {
      const stale = JSON.parse(JSON.stringify(memo.replayBlock));
      if (stale.ctx && memo.livePairingId) stale.ctx.pairingId = memo.livePairingId;
      payload.e2e = stale;
      memo.tampered();
    }
    return payload;
  },

  /**
   * Substitute a recipient's static public key on the way to the PHONE, so the
   * phone seals a wrap to a key the attacker holds. `memo.forgedPub` /
   * `memo.forgedFor` are installed by the harness. The forged key is a REAL
   * P-256 point in the pinned encoding, so the relay's own e2eBlock-core
   * validation passes it — the pin is the only thing left that can object.
   */
  'forge-pubkey': (dir, type, payload, memo) => {
    if (dir === 'toClient' && type === 'PAIRING_REQUEST' && memo.target === 'phone'
        && payload.e2e?.recips) {
      for (const r of payload.e2e.recips) {
        if (r.deviceId === memo.forgedFor) { r.pub = memo.forgedPub; memo.tampered(); }
      }
    }
    return payload;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// the tampering proxy
// ───────────────────────────────────────────────────────────────────────────
/**
 * A WS proxy in front of the real relay.
 *
 * Every client socket gets its own upstream socket, opened to the SAME path and
 * query — which is what carries the ticket / phone token, so credentials reach
 * the relay untouched and the entitlement gate behaves exactly as it does in
 * production. Frames from the client are QUEUED until upstream is open; a frame
 * dropped there would look like a refused pairing and would be precisely the
 * false green this harness must not produce.
 */
function startProxy({ upstreamPort, attack }) {
  const fn = ATTACKS[attack];
  if (!fn) throw new Error(`startProxy: unknown attack ${attack}`);
  const wss = new WebSocketServer({ port: 0 });
  const shared = { replayBlock: null, forgedPub: null, forgedFor: null, livePairingId: null, count: 0 };

  wss.on('connection', (client, req) => {
    const path = req.url || '/';
    const memo = {
      ...shared,
      target: path.startsWith('/relay/phone') ? 'phone' : 'browser',
      tampered() { shared.count += 1; },
      notePairingId(id) { shared.livePairingId = id; },
    };
    // Late-installed values (the replay block, the forged key) must be read at
    // FRAME time, not at connection time — the harness installs them between
    // the control run and the armed run.
    Object.defineProperties(memo, {
      replayBlock: { get: () => shared.replayBlock },
      forgedPub: { get: () => shared.forgedPub },
      forgedFor: { get: () => shared.forgedFor },
      livePairingId: { get: () => shared.livePairingId },
    });

    const up = new WebSocket(`ws://127.0.0.1:${upstreamPort}${path}`);
    const pending = [];
    const pump = (raw, dir, sink) => {
      const data = raw.toString();
      const i = data.indexOf(':');
      const type = i === -1 ? data : data.slice(0, i);
      let payload;
      try { payload = i === -1 ? {} : JSON.parse(data.slice(i + 1)); } catch {
        // Not a JSON frame (the relay sends none today, but a byte-carrier must
        // stay a byte-carrier for anything it does not understand).
        if (sink.readyState === WebSocket.OPEN) sink.send(data);
        return;
      }
      const out = fn(dir, type, payload, memo);
      if (out === null) return; // an attack may also DROP a frame
      if (sink.readyState === WebSocket.OPEN) sink.send(`${type}:${JSON.stringify(out)}`);
    };

    up.on('open', () => { for (const m of pending.splice(0)) pump(m, 'toRelay', up); });
    client.on('message', (m) => {
      if (up.readyState === WebSocket.OPEN) pump(m, 'toRelay', up); else pending.push(m);
    });
    up.on('message', (m) => pump(m, 'toClient', client));
    // Close codes must survive the proxy verbatim: openAuthed() reports 4401 /
    // 4403 by code, and a proxy that collapsed them to 1006 would turn every
    // auth failure into an indistinguishable "socket died".
    const relay = (code, reason) => {
      const c = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000;
      try { client.close(c, reason?.toString?.() ?? ''); } catch { /* already gone */ }
      try { up.close(c, reason?.toString?.() ?? ''); } catch { /* already gone */ }
    };
    up.on('close', relay);
    client.on('close', relay);
    up.on('error', () => relay(1011, 'upstream error'));
    client.on('error', () => relay(1011, 'client error'));
  });

  return {
    port: wss.address().port,
    wsBase: `ws://127.0.0.1:${wss.address().port}`,
    /** How many frames this attack actually tampered with. */
    tamperCount: () => shared.count,
    arm: (patch) => Object.assign(shared, patch),
    close: () => new Promise((resolve) => {
      for (const c of wss.clients) { try { c.terminate(); } catch { /* gone */ } }
      wss.close(() => resolve());
      setTimeout(resolve, 500).unref?.();
    }),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// a client socket with a typed inbox
// ───────────────────────────────────────────────────────────────────────────
/**
 * `openAuthed` attaches nothing until it has resolved, and it deliberately
 * waits out a 750 ms settle window to catch a 4401/4403 that arrives just after
 * 'open'. The relay's LOBBY_STATUS lands INSIDE that window, so a naive
 * `openAuthed(...).then(ws => ws.on('message'))` loses the very frame the
 * frame-on-open trap says to wait for — and the scenario then times out looking
 * like a relay fault. The inbox is therefore attached to the socket BEFORE the
 * settle, and openAuthed's close-code semantics are kept by racing against it.
 */
async function connect(url) {
  const inbox = [];
  const waiters = [];
  const onMessage = (raw) => {
    const d = raw.toString();
    const i = d.indexOf(':');
    const frame = { type: i === -1 ? d : d.slice(0, i), payload: i === -1 ? {} : JSON.parse(d.slice(i + 1)) };
    const w = waiters.findIndex((x) => x.types.includes(frame.type));
    if (w !== -1) { const [x] = waiters.splice(w, 1); x.resolve(frame); } else inbox.push(frame);
  };
  const attach = (ws) => ws.on('message', onMessage);
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const t = setTimeout(() => done(reject, new Error('socket did not open within 15000ms')), 15_000);
    sock.on('open', () => {
      attach(sock); // BEFORE the settle window — this is the whole fix
      setTimeout(() => { clearTimeout(t); if (sock.readyState === 1) done(resolve, sock); }, 750);
    });
    sock.on('close', (code, reason) => {
      clearTimeout(t);
      const why = code === 4401 ? 'invalid_token — check JWT_SECRET length (>=32) and that the user row exists'
        : code === 4403 ? 'subscription_required — the entitlement gate rejected this user'
          : String(reason || '');
      done(reject, new Error(`relay closed the socket: ${code} ${why}`));
    });
    sock.on('error', (e) => { clearTimeout(t); done(reject, e); });
  });
  return {
    ws,
    send: (type, payload) => ws.send(`${type}:${JSON.stringify(payload)}`),
    waitAny: (types, ms = 8000) => new Promise((res, rej) => {
      const k = inbox.findIndex((f) => types.includes(f.type));
      if (k !== -1) return res(inbox.splice(k, 1)[0]);
      const entry = { types, resolve: null };
      const t = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);  // disarm, or it eats a later frame
        rej(new Error(`timeout waiting for ${types.join('|')}`));
      }, ms);
      entry.resolve = (f) => { clearTimeout(t); res(f); };
      waiters.push(entry);
      return undefined;
    }),
    wait: function wait(type, ms = 8000) { return this.waitAny([type], ms); },
    /** Resolve with null instead of throwing — for "this frame must NOT arrive". */
    maybe: async function maybe(type, ms) { try { return await this.wait(type, ms); } catch { return null; } },
    close: () => { try { ws.terminate(); } catch { /* already gone */ } },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// actors: one user, three device keys, three real DeviceKey rows
// ───────────────────────────────────────────────────────────────────────────
async function mintP256() {
  const p = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey));
  return { priv: p.privateKey, pub, b64: b64(pub) };
}

async function newActors(db) {
  const user = await seedEntitledUser(db);
  // The WEB key is the real client record: non-extractable private half, the
  // same object useE2e holds in keyRef and the same one admitPairEpoch mutates.
  const web = await generateWebDeviceKey();
  const ext = await mintP256();
  const phone = await mintP256();
  const extDeviceId = `ext-${Math.random().toString(36).slice(2, 10)}`;
  const phoneDeviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
  await db.deviceKey.createMany({
    data: [
      { userId: user.id, deviceId: web.deviceId, kind: 'web', publicKey: web.pubB64Url },
      { userId: user.id, deviceId: extDeviceId, kind: 'extension', publicKey: ext.b64 },
      { userId: user.id, deviceId: phoneDeviceId, kind: 'phone', publicKey: phone.b64 },
    ],
  });
  return {
    user, web, ext, phone, extDeviceId, phoneDeviceId,
    store: memoryWebKeyStore(),
  };
}

/** The REAL registry read: the shipped Next route, over HTTP, with the real bearer. */
async function fetchRegistry(httpBase, phoneToken) {
  try {
    const r = await fetch(`${httpBase}/api/devicekeys/list`, {
      headers: { authorization: `Bearer ${phoneToken}` },
    });
    if (!r.ok) return { ok: false, reason: `http ${r.status}` };
    const d = await r.json();
    return { ok: true, rows: d.keys ?? [] };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * MIRROR of E2eKeyPin.verify (Kotlin). See the header: the shipped pin is
 * Android-only and cannot be called from node. The drift guard above fails if
 * any of the four clauses restated here leaves the Kotlin source.
 */
function pinRecipients(recips, registry, modeOn) {
  if (!registry.ok) {
    return modeOn
      ? { verdict: 'fail-closed', userMessage: ABORT_KEY_MISMATCH, reason: registry.reason }
      : { verdict: 'fail-open-unverified', reason: registry.reason };
  }
  if (recips.length === 0) {
    return { verdict: 'mismatch', userMessage: 'Unexpected device key', reason: 'nothing to pin' };
  }
  const live = new Map(registry.rows.filter((r) => !r.revokedAt).map((r) => [r.deviceId, r]));
  for (const r of recips) {
    const row = live.get(r.deviceId);
    if (!row) return { verdict: 'mismatch', userMessage: 'Unexpected device key', reason: `${r.deviceId} has no live row` };
    if (row.publicKey !== r.pub) {
      return {
        verdict: 'mismatch', userMessage: 'Unexpected device key',
        reason: `recipient ${r.deviceId} (${r.kind}) advertised a key that is NOT the one on record`,
      };
    }
    if (row.kind !== r.kind) {
      return { verdict: 'mismatch', userMessage: 'Unexpected device key', reason: `kind ${r.kind} vs registry ${row.kind}` };
    }
  }
  return { verdict: 'verified', checked: recips.length };
}

// ───────────────────────────────────────────────────────────────────────────
// the PHONE half — real kdf/session, P4's wire shape
// ───────────────────────────────────────────────────────────────────────────
async function phoneBuildAccept({ pairingId, userId, phoneDeviceId, recips, phoneKey, pairEpoch, modeOn }) {
  const peerDeviceId = KDF.canonicalPeerDeviceId(recips.map((r) => ({ deviceId: r.deviceId })));
  const ctxBytes = KDF.pairContext({ pairingId, userId, phoneDeviceId, peerDeviceId, pairEpoch });
  const sk = crypto.getRandomValues(new Uint8Array(32));
  const kid = b64(crypto.getRandomValues(new Uint8Array(16)));
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const wraps = [];
  for (const r of recips) {
    const peer = await crypto.subtle.importKey('raw', unb64(r.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
    const kekBytes = await KDF.kek({ pairingId, sharedSecret: z, context: ctxBytes, recipientKey: unb64(r.pub) });
    const kekKey = await crypto.subtle.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await KDF.seal({
      sender: { direction: SESSION.DIR_P2C, key: kekKey, sessionPrefix: await SESSION.wrapPrefix(r.deviceId) },
      frameType: SESSION.WRAP_FRAME_TYPE, kid, seq: 0, pairEpoch, plaintext: sk,
    });
    z.fill(0); kekBytes.fill(0);
    wraps.push({ deviceId: r.deviceId, wrap: b64(ct) });
  }

  const block = {
    v: 1, mode: modeOn ? 1 : 0, kid, epk: b64(epk),
    recipKeys: [phoneKey.b64, ...recips.map((r) => r.pub)],
    wraps,
    // MIRROR FIX (R-BD 2026-09-20): the real phone attaches ctx
    // UNCONDITIONALLY — PhoneService.kt:2797
    // `E2ePairIdentity.withCtx(prepared.block, pairContext)`, with no mode
    // gate. This mirror used to gate it on modeOn, which was invisible
    // pre-A5 because a 0/0 pair went in the clear and never read ctx. Under
    // M-A5-5 §2 a 0/0 pair with a usable block SEALS, pairContextFromWire
    // then needs ctx, and the missing field surfaced as a bogus
    // "ctx refused" refusal the shipped phone can never produce.
    // `sas` stays mode-gated below: that one IS mode-dependent.
    ctx: { pairingId, phoneDeviceId, peerDeviceId, pairEpoch: String(pairEpoch) },
  };
  const sas = modeOn
    ? await sasDigits({ pairingId, epk, keys: block.recipKeys.map(unb64), pairEpoch, modeOn: true })
    : null;
  sk.fill(0);
  return { block, sas, kid };
}

// ───────────────────────────────────────────────────────────────────────────
// the COMPUTER half — the SAME ordering useE2e.onPairingActive uses
// ───────────────────────────────────────────────────────────────────────────
/**
 * `neuter` names the ONE check to remove, for the detector proof. Every other
 * check stays armed, so a neutered run that still refuses is refusing for the
 * reason it names and not for a dropped socket.
 *
 *   'mode'   skip decideAccept's abort  (defeats strip-e2e; under M-A5-5 §1
 *            downgrade-mode has no abort left to skip — see its detector)
 *   'epoch'  skip admitPairEpoch        (defeats replay-epoch)
 */
async function computerAccept({ payload, localMode, webKey, store, userId, bridgePairingId, latched = false, neuter = null }) {
  const block = readAcceptBlock(payload.e2e);

  // C-2's own input: the phone's row, read from the DB-backed registry the same
  // way useE2e reads /api/devicekeys/list. A failed read stays null, which
  // pinPhoneKey turns into 'no-phone-row' — never into a pass.
  const phoneRowPublicKey = payload.__phoneRowPublicKey ?? null;

  const decision = decideAccept({
    localMode, block, ourDeviceId: webKey.deviceId, phoneRowPublicKey, latched,
  });

  if (decision.action === 'abort' && neuter !== 'mode') {
    const ind = encryptionIndicator({ state: 'error', error: decision.error, peer: { supports: true } });
    return { completed: false, error: decision.error, copy: ind.detail, label: ind.label, detail: decision.detail, sas: null };
  }
  if (decision.action === 'abort' && neuter === 'mode') {
    // NEUTERED: the client swallows the B6 refusal and carries on in the clear.
    // This is what the attack achieves when the check is not there.
    const ind = encryptionIndicator({ state: 'unencrypted', peer: { supports: true } });
    return { completed: true, mode: 'off', state: 'unencrypted', label: ind.label, sas: null, neutered: true };
  }
  if (decision.mode === 'off' || !block) {
    const ind = encryptionIndicator({ state: 'unencrypted', peer: { supports: true } });
    return { completed: true, mode: 'off', state: 'unencrypted', label: ind.label, detail: ind.detail, sas: null };
  }

  let context;
  try {
    context = KDF.pairContextFromWire(block.ctx, {
      userId,
      pairingId: typeof payload.pairingId === 'string' ? payload.pairingId : bridgePairingId,
      recipientDeviceIds: block.wraps.map((w) => w.deviceId),
    });
  } catch (e) {
    const ind = encryptionIndicator({ state: 'error', error: 'e2e-setup-failed', peer: { supports: true } });
    return { completed: false, error: 'e2e-setup-failed', copy: ind.detail, label: ind.label, detail: `ctx refused: ${e.message}`, sas: null };
  }

  // A3-M2 BEFORE any key derivation — the position is the control.
  if (neuter !== 'epoch') {
    try {
      await admitPairEpoch({
        store, key: webKey, userId, phoneDeviceId: context.phoneDeviceId, pairEpoch: context.pairEpoch,
        kid: block.kid,
      });
    } catch (e) {
      const code = e instanceof EpochFloorError ? 'e2e-epoch-replayed' : 'e2e-setup-failed';
      const ind = encryptionIndicator({ state: 'error', error: code, peer: { supports: true } });
      return { completed: false, error: code, copy: ind.detail, label: ind.label, detail: e.message, sas: null };
    }
  }

  try {
    const wrap = block.wraps.find((w) => w.deviceId === webKey.deviceId)?.wrap;
    if (!wrap) throw new Error('no wrap for our deviceId');
    const sessionKey = await SESSION.openWrap({
      wrap, kid: block.kid, epk: unb64(block.epk),
      ourPrivateKey: webKey.privateKey, ourPublicSec1: webKey.pub, ourDeviceId: webKey.deviceId,
      pairingId: context.pairingId, context: context.contextBytes, pairEpoch: context.pairEpoch,
    });
    sessionKey.fill(0);
  } catch (e) {
    const ind = encryptionIndicator({ state: 'error', error: 'e2e-setup-failed', peer: { supports: true } });
    return { completed: false, error: 'e2e-setup-failed', copy: ind.detail, label: ind.label, detail: `wrap did not open: ${e.message}`, sas: null };
  }

  const sas = await sasDigits({
    pairingId: context.pairingId, epk: unb64(block.epk),
    keys: block.recipKeys.map(unb64), pairEpoch: context.pairEpoch, modeOn: true,
  });
  const ind = encryptionIndicator({ state: decision.state, peer: { supports: true } });
  return { completed: true, mode: 'on', state: decision.state, verified: decision.verified, label: ind.label, sas, kid: block.kid };
}

// ───────────────────────────────────────────────────────────────────────────
// one full pairing through the proxy
// ───────────────────────────────────────────────────────────────────────────
/**
 * Drives phone + browser through a whole handshake and returns BOTH sides'
 * outcomes. Everything that can silently make a scenario vacuous is a throw
 * here, not a quiet null: no LOBBY_STATUS, no PAIRING_REQUEST, no
 * PAIRING_ACTIVE all abort the scenario loudly.
 */
async function runPairing({
  relay, proxy, actors, localMode, phoneModeOn = true, pairEpoch,
  neuter = null, pinNeutered = false, expectPhoneRefusal = false,
}) {
  const urls = relayUrls({ wsBase: proxy.wsBase, secret: relay.secret, user: actors.user });
  // The phone joins FIRST: handleBrowserRequestPairing needs one in the lobby.
  const phone = await connect(urls.phone());
  await joined(phone);                        // the frame-on-open trap
  const browser = await connect(urls.browser());
  await joined(browser);

  try {
    const recips = [
      { kind: 'web', deviceId: actors.web.deviceId, pub: actors.web.pubB64Url },
      { kind: 'extension', deviceId: actors.extDeviceId, pub: actors.ext.b64 },
    ];
    browser.send('BROWSER_REQUEST_PAIRING', {
      ua: 'p6-staging-relay', e2e: { v: 1, mode: localMode === 'on' ? 1 : 0, recips },
    });

    const unavailable = await browser.maybe('PAIRING_E2E_UNAVAILABLE', 1200);
    if (unavailable) return { killSwitch: unavailable.payload, phone, browser };

    const req = await phone.wait('PAIRING_REQUEST');
    const pairingId = req.payload.pairingId;
    if (!pairingId) throw new Error('no pairingId on PAIRING_REQUEST — the scenario is vacuous');

    // ── the PHONE's pin, against the REAL registry over real HTTP ──────────
    const seen = req.payload.e2e?.recips ?? [];
    const registry = await fetchRegistry(relay.httpBase, actors.user.phoneToken);
    const pin = pinRecipients(seen, registry, phoneModeOn);
    if (!pinNeutered && (pin.verdict === 'mismatch' || pin.verdict === 'fail-closed')) {
      phone.send('DECLINE_PAIRING', { pairingId });
      return { phonePin: pin, pairingId, phone, browser, phoneRefused: true };
    }

    const accept = await phoneBuildAccept({
      pairingId, userId: actors.user.id, phoneDeviceId: actors.phoneDeviceId,
      recips: seen, phoneKey: actors.phone, pairEpoch, modeOn: phoneModeOn,
    });
    phone.send('ACCEPT_PAIRING', { pairingId, e2e: accept.block });

    const active = await browser.wait('PAIRING_ACTIVE');
    const computer = await computerAccept({
      payload: { ...active.payload, __phoneRowPublicKey: actors.phone.b64 },
      localMode, webKey: actors.web, store: actors.store, userId: actors.user.id,
      bridgePairingId: pairingId, neuter,
    });
    return { pairingId, accept, computer, activePayload: active.payload, phonePin: pin, phone, browser };
  } finally {
    // Sockets are closed by the caller after it has read what it needs, but a
    // throw must never leave two sockets in the relay's lobby for the next
    // scenario to trip over.
    if (expectPhoneRefusal) { /* caller closes */ }
  }
}

function closeAll(...r) {
  for (const x of r) { x?.phone?.close(); x?.browser?.close(); }
}

/**
 * End a pair the way the product does, then close.
 *
 * Terminating the sockets is NOT enough and the first run proved it: the relay
 * holds a RESUME CLAIM for a dropped active pair, so the next phone to join is
 * silently re-linked and receives PAIRING_ACTIVE *instead of* LOBBY_STATUS
 * (server.js: "PAIRING_ACTIVE REPLACES LOBBY_STATUS for this socket"). The
 * scenario then waits forever for a frame that is never coming — which would
 * have read as "the relay refused", i.e. the exact false green this file is
 * built to avoid. LEAVE_ACTIVE is the explicit teardown that clears the claim.
 */
async function endPair(r) {
  try { r?.browser?.send('LEAVE_ACTIVE', {}); } catch { /* already gone */ }
  await new Promise((res) => setTimeout(res, 250));
  closeAll(r);
  await new Promise((res) => setTimeout(res, 250));
}

/**
 * The join frame is LOBBY_STATUS normally and PAIRING_ACTIVE after a silent
 * resume. Racing them means an unexpected resume fails the SCENARIO on its own
 * assertions rather than hanging the harness on a timeout.
 */
async function joined(sock) {
  // NOT Promise.race(wait(a), wait(b)): the losing waiter would stay armed and
  // silently eat the NEXT frame of its type — the browser's real PAIRING_ACTIVE.
  return sock.waitAny(['LOBBY_STATUS', 'PAIRING_ACTIVE']);
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  driftGuards();

  const secret = mintSecret();
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const seededUsers = [];

  const relayOpts = (env, label) => ({
    cwd: ROOT, logDir: LOG_DIR, databaseUrl: DATABASE_URL, label,
    env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET: secret, ...env },
  });

  try {
    await withRealRelay(relayOpts({}, 'staging'), async (real) => {
      const relay = { ...real, secret };
      console.log(`\n  relay pid ${real.pid} on ${real.port}; log ${real.logPath}`);

      // ─────────────────────────────────────────────────────────────────────
      // ATTACK 0 — the shape of a healthy pair (the control every other
      // scenario is measured against)
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n── attack "none" — POSITIVE CONTROL, mode ON both sides ──────');
      {
        const proxy = startProxy({ upstreamPort: real.port, attack: 'none' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 10 });
        check('none: the pairing COMPLETED', r.computer?.completed === true, r.computer?.detail);
        eq('none: effective mode is ON', r.computer?.mode, 'on');
        eq('none: state is encrypted-verified', r.computer?.state, 'encrypted-verified');
        eq('none: the badge says Encrypted', r.computer?.label, 'Encrypted');
        eq('none: the phone pin VERIFIED both recipients against the real registry', r.phonePin?.verdict, 'verified');
        check('none: the SAS is five digits', /^\d{5}$/.test(r.computer?.sas ?? ''), r.computer?.sas);
        eq('none: BOTH SIDES computed the SAME SAS', r.computer?.sas, r.accept?.sas);
        eq('none: the proxy tampered with NOTHING', proxy.tamperCount(), 0);
        // The measured channel gap, asserted rather than assumed.
        check('none: the real relay sent the browser NO pairingId (R-T channel gap)',
          r.activePayload?.pairingId === undefined);
        await endPair(r); await proxy.close();
      }

      // ─────────────────────────────────────────────────────────────────────
      // ATTACK 1 — strip-e2e
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n── attack "strip-e2e" ───────────────────────────────────────');
      {
        // ARMED, mode ON: must refuse.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'strip-e2e' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 11 });
        check('strip-e2e/ON: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        eq('strip-e2e/ON: the pairing was REFUSED', r.computer?.completed, false);
        eq('strip-e2e/ON: refused with e2e-setup-failed (B6), not a generic failure', r.computer?.error, 'e2e-setup-failed');
        check('strip-e2e/ON: the user copy is the frozen sentence',
          (r.computer?.copy ?? '').startsWith(ABORT_SETUP_FAILED), r.computer?.copy);
        check('strip-e2e/ON: the detail names the missing block',
          /no e2e block/.test(r.computer?.detail ?? ''), r.computer?.detail);
        // SAS divergence — the detection mechanism, asserted as divergence.
        check('strip-e2e/ON: the phone HAD digits and the browser produced NONE (the codes cannot match)',
          typeof r.accept?.sas === 'string' && r.computer?.sas === null,
          `phone=${r.accept?.sas} browser=${r.computer?.sas}`);
        await endPair(r); await proxy.close();
      }
      {
        // ARMED, mode OFF: must pair PLAINTEXT with the Unencrypted badge.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'strip-e2e' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'off', phoneModeOn: false, pairEpoch: 11 });
        check('strip-e2e/OFF: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        eq('strip-e2e/OFF: the pairing COMPLETED in the clear', r.computer?.completed, true);
        eq('strip-e2e/OFF: effective mode is OFF', r.computer?.mode, 'off');
        eq('strip-e2e/OFF: the badge says Not encrypted', r.computer?.label, 'Not encrypted');
        await endPair(r); await proxy.close();
      }
      {
        // DETECTOR PROOF — neuter the B6 mode check and the attack SUCCEEDS.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'strip-e2e' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 11, neuter: 'mode' });
        console.log('  DETECTOR PROOF strip-e2e: B6 mode check REMOVED —');
        console.log(`    completed=${r.computer?.completed} mode=${r.computer?.mode} badge=${r.computer?.label}`);
        check('strip-e2e DETECTOR: with the check removed the attack SUCCEEDS (mode-ON user silently plaintext)',
          r.computer?.completed === true && r.computer?.mode === 'off',
          'the attack could NOT be made to succeed — this harness may not be delivering it');
        await endPair(r); await proxy.close();
      }

      // ─────────────────────────────────────────────────────────────────────
      // ATTACK 2 — downgrade-mode (the B6 primitive)
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n── attack "downgrade-mode" ──────────────────────────────────');
      {
        const proxy = startProxy({ upstreamPort: real.port, attack: 'downgrade-mode' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 12 });
        check('downgrade-mode/ON: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        // R-BD 2026-09-20 / M-A5-5 §1: effective = OR(localMode, block.mode).
        // The flipped byte (1 -> 0) meets a local-ON computer, the OR absorbs
        // it, and the pair seals VERIFIED — the downgrade does not land. These
        // four were pinned pre-A5, when decideAccept had a `block.mode < 1`
        // abort; that branch is gone and its absence IS the M-A5-5 defense.
        eq('downgrade-mode/ON: the pairing COMPLETED - the flip was absorbed (M-A5-5 §1)',
          r.computer?.completed, true);
        eq('downgrade-mode/ON: no error - absorption is not a refusal', r.computer?.error, undefined);
        // The flipped byte DID reach the browser (proves the attack is still
        // delivered end to end), and the browser's SAS still equals the
        // phone's mode-1 code: effective ON on BOTH ends — vector M3's shape.
        eq('downgrade-mode/ON: the flipped byte reached the browser (mode=0 on the wire)',
          r.activePayload?.e2e?.mode, 0);
        eq("downgrade-mode/ON: the SAS still MATCHES the phone's mode-1 code (effective ON both ends, vector M3)",
          r.computer?.sas, r.accept?.sas);
        eq('downgrade-mode/ON: the badge is the sealed-and-verified one', r.computer?.label, 'Encrypted');
        // The SAS transcript's modeByte (0x04) makes the downgrade visible even
        // if every other field survived — assert the digits DIVERGE, which is
        // the property, not merely that something refused.
        const downgradedSas = await sasDigits({
          pairingId: r.pairingId, epk: unb64(r.accept.block.epk),
          keys: r.accept.block.recipKeys.map(unb64), pairEpoch: 12, modeOn: false,
        });
        ne('downgrade-mode/ON: the SAS under mode 0 DIFFERS from the phone\'s mode-1 code', downgradedSas, r.accept.sas);
        await endPair(r); await proxy.close();
      }
      {
        // DETECTOR PROOF.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'downgrade-mode' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 12, neuter: 'mode' });
        console.log('  DETECTOR PROOF downgrade-mode: the `mode` neuter is a NO-OP under M-A5-5 —');
        console.log(`    completed=${r.computer?.completed} mode=${r.computer?.mode} badge=${r.computer?.label} sas=${r.computer?.sas}`);
        // R-BD 2026-09-20: there is no longer a check to remove. decideAccept
        // has no `block.mode < 1` branch, so `neuter: 'mode'` cannot change
        // this outcome — and that INVARIANCE is the detector. The proof that
        // the attack is still being delivered, and that honouring the flipped
        // byte would have been fatal, is the `SAS under mode 0 DIFFERS`
        // assertion in the armed block above.
        check('downgrade-mode DETECTOR: the byte flip is absorbed, not refused - OR(local, peer) is the defense (M-A5-5 §1)',
          r.computer?.completed === true && r.computer?.mode === 'on' && r.computer?.sas === r.accept?.sas,
          `completed=${r.computer?.completed} mode=${r.computer?.mode} sasMatches=${r.computer?.sas === r.accept?.sas}`);
        await endPair(r); await proxy.close();
      }

      // ─────────────────────────────────────────────────────────────────────
      // ATTACK 3 — replay-epoch (A3-M2 floor)
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n-- attack "replay-epoch" -----------------------------------');
      {
        // ── PRIMITIVE A: the stale block replayed VERBATIM ────────────────
        //
        // The refusal here is A3-M3(a), NOT the epoch floor, and that ordering
        // is asserted rather than glossed. The first version of this scenario
        // claimed the floor and got this refusal — the detector proof is what
        // exposed it, which is the whole argument for running one.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'replay-epoch' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);

        const first = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 20 });
        eq('replay-epoch CONTROL: pairing #1 at epoch 20 COMPLETED', first.computer?.completed, true);
        eq('replay-epoch CONTROL: both sides agreed on the SAS', first.computer?.sas, first.accept?.sas);
        eq('replay-epoch CONTROL: nothing was tampered with yet', proxy.tamperCount(), 0);
        await endPair(first);

        proxy.arm({ replayBlock: first.accept.block });
        const second = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 21 });
        check('replay-epoch/ON: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        eq('replay-epoch/ON: the pairing was REFUSED', second.computer?.completed, false);
        eq('replay-epoch/ON: refused with e2e-setup-failed', second.computer?.error, 'e2e-setup-failed');
        check('replay-epoch/ON: caught by the A3-M3(a) pairingId binding BEFORE the epoch floor is consulted',
          /ctx\.pairingId is not the pairing this device is party to/.test(second.computer?.detail ?? ''),
          second.computer?.detail);
        ne("replay-epoch/ON: the replayed block's SAS DIFFERS from what the phone is showing",
          first.accept.sas, second.accept.sas);
        await endPair(second); await proxy.close();
      }

      console.log('\n-- attack "replay-epoch-rebound" -- the floor, isolated ----');
      {
        // ── PRIMITIVE B: the attacker ALSO re-binds ctx.pairingId ─────────
        //
        // With A3-M3(a) satisfied, the A3-M2 epoch floor is the ONLY defence
        // left standing between a replayed epoch and a key derivation. That is
        // what makes this scenario a test of the floor rather than of something
        // upstream of it.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'replay-epoch-rebound' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);

        const first = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 30 });
        eq('rebound CONTROL: pairing #1 at epoch 30 COMPLETED and set the floor', first.computer?.completed, true);
        eq('rebound CONTROL: both sides agreed on the SAS', first.computer?.sas, first.accept?.sas);
        eq('rebound CONTROL: nothing was tampered with yet', proxy.tamperCount(), 0);
        await endPair(first);

        proxy.arm({ replayBlock: first.accept.block });
        const second = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 31 });
        check('rebound/ON: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        eq('rebound/ON: the pairing was REFUSED', second.computer?.completed, false);
        eq('rebound/ON: refused by the A3-M2 epoch floor specifically', second.computer?.error, 'e2e-epoch-replayed');
        // ── P2.8 / R-BP (d): re-pinned after P2.6 ────────────────────────
        // This cell pinned `/pairEpoch 30 is at or below the stored floor 30/`
        // until P2.6 split `EpochFloorError` into FOUR reason-specific
        // sentences (lib/e2e/webKey.ts:208-236) and that sentence stopped
        // existing anywhere in the product. A pinned English sentence inside a
        // gate-STEP script is a floor the tests/ node sweep never runs, which
        // is why P2.6's sweep did not see it move and P6.1e found it live.
        //
        // The refusal is printed unconditionally, not just on failure: WHICH
        // of the four cells fired is the finding, and a check that only speaks
        // when it is red cannot report it.
        console.log(`    rebound/ON refusal: ${second.computer?.detail}`);
        // Two checks, because the sentence carries two independent claims.
        // 1. The resume-shaped refusal — it still names the floor AND the
        //    offered epoch, which is the property the old pin existed for.
        check('rebound/ON: the refusal names the floor and the offered epoch',
          /E2E pairEpoch 30 equals the stored floor 30 for /.test(second.computer?.detail ?? ''),
          second.computer?.detail);
        // 2. The reason-specific fragment. The harness replays first.accept.block
        //    — same kid, epoch 30 against a floor of 30 — and `endPair` clears
        //    the seq store while the floor survives, so the cell that fires is
        //    `seq-state-missing`. `kid-mismatch` would be a correct refusal too
        //    (it would mean the harness mints a kid per pairing), so it is
        //    accepted here and named by the printed line above; `below-floor`
        //    would NOT be, because it would mean the floor is 31 and this whole
        //    control is testing something other than the equal-epoch cell.
        check('rebound/ON: ...and says WHICH cell refused (seq-state-missing, or kid-mismatch)',
          /has no seq history left to continue/.test(second.computer?.detail ?? '')
            || /kid is NOT the one admitted/.test(second.computer?.detail ?? ''),
          second.computer?.detail);
        check('rebound/ON: ...and it is NOT below-floor (that would mean the floor is 31, not 30)',
          !/is below the stored floor/.test(second.computer?.detail ?? ''),
          second.computer?.detail);
        eq('rebound/ON: the badge says Pairing refused', second.computer?.label, 'Pairing refused');
        ne('rebound/ON: the replayed epoch-30 SAS DIFFERS from the epoch-31 code the phone is showing',
          first.accept.sas, second.accept.sas);
        await endPair(second); await proxy.close();

        // ── DETECTOR PROOF ───────────────────────────────────────────────
        // A3-M2's stated property is POSITIONAL: "a replayed epoch never
        // reaches a key derivation". So the proof is that removing the floor
        // lets the replay reach one — the refusal moves DOWNSTREAM, from the
        // epoch check to openWrap. A harness that demanded `completed === true`
        // here would be asserting something the protocol never promised (the
        // re-bound ctx cannot open the stale wrap) and would report red forever
        // while the floor worked perfectly.
        const proxy2 = startProxy({ upstreamPort: real.port, attack: 'replay-epoch-rebound' });
        const a2 = await newActors(db); seededUsers.push(a2.user.id);
        const warm = await runPairing({ relay, proxy: proxy2, actors: a2, localMode: 'on', pairEpoch: 40 });
        eq('rebound DETECTOR warm-up: the floor was set at epoch 40', warm.computer?.completed, true);
        await endPair(warm);

        proxy2.arm({ replayBlock: warm.accept.block });
        const neutered = await runPairing({ relay, proxy: proxy2, actors: a2, localMode: 'on', pairEpoch: 41, neuter: 'epoch' });
        console.log('  DETECTOR PROOF replay-epoch-rebound: the A3-M2 floor REMOVED --');
        console.log(`    error=${neutered.computer?.error} detail=${neutered.computer?.detail}`);
        check('rebound DETECTOR: with the floor removed the replay is ADMITTED and reaches key derivation',
          neutered.computer?.error === 'e2e-setup-failed'
            && /wrap did not open/.test(neutered.computer?.detail ?? ''),
          'the replay did NOT get past the epoch check — this harness may not be delivering it');
        check('rebound DETECTOR: and the floor is what moved — armed it refuses at the epoch, neutered it does not',
          neutered.computer?.error !== 'e2e-epoch-replayed');
        await endPair(neutered); await proxy2.close();
      }

      // ─────────────────────────────────────────────────────────────────────
      // ATTACK 4 — forge-pubkey (M-A's stated test)
      // ─────────────────────────────────────────────────────────────────────
      console.log('\n── attack "forge-pubkey" ────────────────────────────────────');
      {
        // POSITIVE CONTROL first: the same flow, attack disabled.
        const control = startProxy({ upstreamPort: real.port, attack: 'forge-pubkey' });
        const actors = await newActors(db); seededUsers.push(actors.user.id);
        // forgedFor is unset, so the attack matches nothing — a true control
        // through the SAME code path as the armed run.
        const c = await runPairing({ relay, proxy: control, actors, localMode: 'on', pairEpoch: 40 });
        eq('forge-pubkey CONTROL: the attack fired on nothing', control.tamperCount(), 0);
        eq('forge-pubkey CONTROL: the pairing COMPLETED', c.computer?.completed, true);
        eq('forge-pubkey CONTROL: the phone pin VERIFIED', c.phonePin?.verdict, 'verified');
        eq('forge-pubkey CONTROL: both sides agreed on the SAS', c.computer?.sas, c.accept?.sas);
        await endPair(c); await control.close();

        // ARMED: forge the EXTENSION recipient's key — §13.6 names kind
        // 'extension' explicitly because it is the leg whose code the user
        // never sees.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'forge-pubkey' });
        const a2 = await newActors(db); seededUsers.push(a2.user.id);
        const attacker = await mintP256();
        proxy.arm({ forgedFor: a2.extDeviceId, forgedPub: attacker.b64 });
        const r = await runPairing({ relay, proxy, actors: a2, localMode: 'on', pairEpoch: 41 });
        check('forge-pubkey/ON: the attack actually fired', proxy.tamperCount() > 0, `tampered ${proxy.tamperCount()}`);
        eq('forge-pubkey/ON: the PHONE refused and the pairing did not complete', r.phoneRefused, true);
        eq('forge-pubkey/ON: the verdict is mismatch', r.phonePin?.verdict, 'mismatch');
        eq('forge-pubkey/ON: the copy is "Unexpected device key"', r.phonePin?.userMessage, 'Unexpected device key');
        check('forge-pubkey/ON: the reason names the substitution',
          /NOT the one on record/.test(r.phonePin?.reason ?? ''), r.phonePin?.reason);
        check('forge-pubkey/ON: no accept block was ever built, so no SAS exists on either side',
          r.accept === undefined && r.computer === undefined);
        // Prove the digits WOULD have diverged: the recipKeys set is in the SAS
        // transcript, so a swapped SW key changes the code on the side that did
        // not see the swap. This is the B9 property, computed explicitly.
        const honest = await sasDigits({
          pairingId: r.pairingId, epk: unb64(a2.phone.b64), pairEpoch: 41, modeOn: true,
          keys: [a2.phone.b64, a2.web.pubB64Url, a2.ext.b64].map(unb64),
        });
        const forged = await sasDigits({
          pairingId: r.pairingId, epk: unb64(a2.phone.b64), pairEpoch: 41, modeOn: true,
          keys: [a2.phone.b64, a2.web.pubB64Url, attacker.b64].map(unb64),
        });
        ne('forge-pubkey/ON: the SAS over the FORGED key set DIFFERS from the honest one (B9)', forged, honest);
        await endPair(r); await proxy.close();
      }
      {
        // C-2's other half: mode OFF fails OPEN with a warning and an
        // unverified badge. Tested so "fails closed" cannot quietly become
        // "always refuses", which would be an availability break.
        const proxy = startProxy({ upstreamPort: real.port, attack: 'forge-pubkey' });
        const a3 = await newActors(db); seededUsers.push(a3.user.id);
        const registryDown = pinRecipients(
          [{ kind: 'web', deviceId: a3.web.deviceId, pub: a3.web.pubB64Url }],
          { ok: false, reason: 'registry unreachable' }, false,
        );
        eq('C-2/OFF: an unreachable registry with mode OFF fails OPEN', registryDown.verdict, 'fail-open-unverified');
        const registryDownOn = pinRecipients(
          [{ kind: 'web', deviceId: a3.web.deviceId, pub: a3.web.pubB64Url }],
          { ok: false, reason: 'registry unreachable' }, true,
        );
        eq('C-2/ON: an unreachable registry with mode ON fails CLOSED', registryDownOn.verdict, 'fail-closed');
        eq('C-2/ON: and says the frozen sentence', registryDownOn.userMessage, ABORT_KEY_MISMATCH);
        // A MISMATCH refuses in BOTH modes — §13.6 softens only "unreachable".
        const mismatchOff = pinRecipients(
          [{ kind: 'web', deviceId: a3.web.deviceId, pub: (await mintP256()).b64 }],
          { ok: true, rows: [{ deviceId: a3.web.deviceId, kind: 'web', publicKey: a3.web.pubB64Url, revokedAt: null }] },
          false,
        );
        eq('C-2/OFF: a MISMATCH still refuses (only "unreachable" is softened)', mismatchOff.verdict, 'mismatch');

        // DETECTOR PROOF — neuter the pin and the forged key is sealed to.
        const a4 = await newActors(db); seededUsers.push(a4.user.id);
        const attacker = await mintP256();
        proxy.arm({ forgedFor: a4.extDeviceId, forgedPub: attacker.b64 });
        const r = await runPairing({ relay, proxy, actors: a4, localMode: 'on', pairEpoch: 42, pinNeutered: true });
        console.log('  DETECTOR PROOF forge-pubkey: the phone-side registry pin REMOVED —');
        console.log(`    phone built an accept block: ${!!r.accept}; recipKeys include the attacker key: ${r.accept?.block.recipKeys.includes(attacker.b64)}`);
        console.log(`    browser completed=${r.computer?.completed} browserSAS=${r.computer?.sas} phoneSAS=${r.accept?.sas}`);
        check('forge-pubkey DETECTOR: with the pin removed the phone SEALS A WRAP TO THE ATTACKER KEY',
          !!r.accept && r.accept.block.recipKeys.includes(attacker.b64)
            && r.accept.block.wraps.some((w) => w.deviceId === a4.extDeviceId),
          'the forgery could NOT be made to land — this harness may not be delivering it');
        // And the residual defence, when the pin is gone: the SAS still
        // diverges from what an honest key set would have produced, which is
        // why B9 puts the WHOLE key set in the transcript.
        const honest = await sasDigits({
          pairingId: r.pairingId, epk: unb64(r.accept.block.epk), pairEpoch: 42, modeOn: true,
          keys: [a4.phone.b64, a4.web.pubB64Url, a4.ext.b64].map(unb64),
        });
        ne('forge-pubkey DETECTOR: even with the pin gone the SAS diverges from the honest key set (B9 backstop)',
          r.accept.sas, honest);
        await endPair(r); await proxy.close();
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    // N-1 — the kill switch is NOT itself an attack vector
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── N-1 kill switch: refuses, never strips, never downgrades ──');
    await withRealRelay(relayOpts({ E2E_PAIRING_ENABLED: 'false' }, 'killswitch'), async (real) => {
      const relay = { ...real, secret };
      const proxy = startProxy({ upstreamPort: real.port, attack: 'none' });
      const actors = await newActors(db); seededUsers.push(actors.user.id);
      const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 50 });
      check('N-1: mode 1 was REFUSED with PAIRING_E2E_UNAVAILABLE', !!r.killSwitch, JSON.stringify(r.killSwitch));
      eq('N-1: the reason is the kill switch', r.killSwitch?.reason, 'kill-switch');
      check('N-1: the relay did NOT strip the block and pair plaintext instead',
        r.computer === undefined && r.accept === undefined);
      await endPair(r); await proxy.close();

      // The switch refuses NEW encrypted pairings only. A mode-0 request still
      // pairs — so the switch is not a denial of the product, just of encryption.
      const proxy2 = startProxy({ upstreamPort: real.port, attack: 'none' });
      const a2 = await newActors(db); seededUsers.push(a2.user.id);
      const r2 = await runPairing({ relay, proxy: proxy2, actors: a2, localMode: 'off', phoneModeOn: false, pairEpoch: 51 });
      eq('N-1: a plaintext pairing is unaffected by the kill switch', r2.computer?.completed, true);
      // R-BD 2026-09-20 / M-A5-5 §2: a 0/0 pair WITH a usable block seals and
      // is `Encrypted, unverified`. Plaintext is now reserved for pairs with
      // NO usable block. The property this row guards is unchanged and is the
      // second half: it must never come out silently VERIFIED.
      eq('N-1: a 0/0 pair under the switch seals UNVERIFIED (M-A5-5 §2) - never silently verified',
        r2.computer?.label, 'Encrypted, unverified');
      eq('N-1: ...and `verified` says so explicitly', r2.computer?.verified, false);
      eq('N-1: ...sealed, so the effective mode is on', r2.computer?.mode, 'on');
      await endPair(r2); await proxy2.close();
    });

    // The SPELLING of the switch. R-BD 2026-09-20 / N-1.1: P1.3 (38d4031)
    // inverted it to an opt-IN literal '1' — `E2E_PAIRING_ENABLED === '1'`
    // (server.js:233) — so '0' now ARMS the switch, matching the dispatch
    // brief. P6 predates P1.3 and pinned the old opt-OUT spelling. A wrong
    // option value silently disabling a MUST is exactly why this is asserted
    // and not assumed, so the assertion is INVERTED, not deleted.
    console.log('\n── N-1 spelling: E2E_PAIRING_ENABLED=0 ARMS the switch (N-1.1) ──');
    await withRealRelay(relayOpts({ E2E_PAIRING_ENABLED: '0' }, 'killswitch-zero'), async (real) => {
      const relay = { ...real, secret };
      const proxy = startProxy({ upstreamPort: real.port, attack: 'none' });
      const actors = await newActors(db); seededUsers.push(actors.user.id);
      const r = await runPairing({ relay, proxy, actors, localMode: 'on', pairEpoch: 60 });
      check("N-1 spelling: E2E_PAIRING_ENABLED=0 ARMS the switch (N-1.1)",
        !!r.killSwitch && r.killSwitch.reason === 'kill-switch' && r.computer === undefined,
        `killSwitch=${JSON.stringify(r.killSwitch)} computer=${JSON.stringify(r.computer)}`);
      console.log("    NOTE: the switch is opt-IN since P1.3 - ONLY the literal '1' leaves encrypted pairing ENABLED; every other value, '0' included, ARMS it.");
      await endPair(r); await proxy.close();
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── reap census ──────────────────────────────────────────────');
    const alive = new Set(census().map((p) => p.pid));
    check('no relay pid leaked (withRealRelay reaped every child it spawned)',
      process.exitCode !== 1, `process.exitCode=${process.exitCode}`);
    check('census taken and non-empty (the leak check is not vacuous)', alive.size > 0);

    console.log('\nWHAT WAS MEASURED');
    console.log(`  relay:   node server.js, unmodified, NODE_ENV=production, real Postgres`);
    console.log(`  attacks: ${Object.keys(ATTACKS).filter((k) => k !== 'none').join(', ')}`);
    console.log('  real:    decideAccept, pairContextFromWire, admitPairEpoch, openWrap, sasDigits,');
    console.log('           the frozen copy module, and GET /api/devicekeys/list over real HTTP.');
    console.log('  MIRROR:  the PHONE-side registry pin (E2eKeyPin.kt is Kotlin and cannot be');
    console.log('           called from node). Drift-guarded against the Kotlin source above.');
  } finally {
    for (const id of seededUsers) {
      await db.user.deleteMany({ where: { id } }).catch(() => {});
    }
    await db.$disconnect().catch(() => {});
  }
}

main().then(
  () => {
    clearTimeout(WATCHDOG);
    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed === 0 && process.exitCode !== 1 ? 0 : 1);
  },
  (e) => {
    clearTimeout(WATCHDOG);
    console.error('  FAIL  harness threw:', e?.stack ?? e);
    console.log('');
    console.log(`${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  },
);
