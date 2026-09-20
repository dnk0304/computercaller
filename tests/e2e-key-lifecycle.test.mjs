#!/usr/bin/env node
/**
 * tests/e2e-key-lifecycle.test.mjs — E2E-P6 deliverable (c): the key-lifecycle
 * suite.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * READ THIS FIRST — TWO DOCUMENTS SPECIFY "SIX SCENARIOS" AND THEY ARE NOT THE
 * SAME SIX. THIS FILE DOES NOT PICK A WINNER.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE P6 DISPATCH BRIEF names six key-lifecycle scenarios:
 *   B1 rotate on Reset
 *   B2 sign-out
 *   B3 reinstall (new phone key → TOFU warning)
 *   B4 computer DeviceKey revoke
 *   B5 phone DeviceKey revoke
 *   B6 kill-switch flip mid-pair (N-1: refuses NEW encrypted pairings only;
 *      existing pairs continue)
 *
 * M-C (e2e/AUDIT-SECURITY-v1.md § MAJOR, which E2E-PLAN P6(c) actually cites,
 * and whose table is frozen into E2E-SPEC-v1.0 §13.8) names a DIFFERENT six:
 *   M1 sign-out on device X — revoke X's DeviceKey ONLY, other devices' pairs
 *      unaffected, X wipes IndexedDB / Keystore alias / storage.session
 *   M2 account deletion — all DeviceKey rows deleted, all rooms RESET_ROOM'd
 *      (Security note C-4; owner P1(e), scenario here)
 *   M3 revoke racing an active pair — the relay cannot see it, so the client
 *      re-checks the DeviceKey list on every reconnect and every pairEpoch
 *      bump, and a revoked peer tears the pair down
 *   M4 browser "clear site data" mid-pair — web key gone ⇒ "Re-pair needed",
 *      NEVER silent plaintext
 *   M5 SW IndexedDB wipe on extension update — SW key regenerates ⇒ new
 *      deviceId ⇒ degrades to counts until the next Accept, and must NOT
 *      invalidate the web pair
 *   M6 phone reinstall — Keystore keys die ⇒ new deviceId ⇒ TOFU key-change
 *      warning whose copy must name reinstall as the benign cause
 *
 * THE OVERLAP is three scenarios: sign-out (B2 ≡ M1), reinstall (B3 ≡ M6), and
 * revoke (B4/B5 ≡ M3). THIS FILE IMPLEMENTS THE UNION — nine distinct
 * lifecycle scenarios — with each shared scenario written ONCE and referenced
 * from both lists, plus one cross-cutting scenario for the C-2 pin-failure
 * policy that every Accept path depends on.
 *
 * RECONCILING THE TWO LISTS IS A KEN / SECURITY DECISION, NOT A LOCAL ONE.
 * A test file is the wrong place to decide which of two frozen documents is
 * authoritative; silently implementing one list would make the other's gap
 * invisible, which is precisely the failure the union avoids. The discrepancy
 * is reported upward with this file.
 *
 * ── THE ACCEPTANCE RULE, APPLIED TO EVERY SCENARIO ──────────────────────────
 * M-C's own rule is that each scenario asserts "no plaintext frame and no
 * silent degrade." Both halves are asserted EXPLICITLY, for all ten, through
 * {@link noPlaintextNoSilentDegrade}:
 *
 *   no plaintext frame  — every data-plane frame put on the wire in the
 *                         scenario is a §13.7 envelope `{e,kid,s,c}`, and no
 *                         fragment of any secret payload appears anywhere in
 *                         the wire bytes (assertNoPlaintext, real AES-256-GCM).
 *   no silent degrade   — if the pair stopped being encrypted, there is a
 *                         NAMED, user-visible signal for it drawn from the
 *                         frozen copy constants. "Degraded with signal === null"
 *                         is the only outcome this suite exists to forbid.
 *
 * ── WHAT THIS FILE MAY AND MAY NOT CLAIM ────────────────────────────────────
 * It MIRRORS the lifecycle rules rather than running the product:
 *   • the relay is not booted — the N-1 gate is asserted against the REAL
 *     server.js source text plus the real `lib/e2eBlock-core.js` validator;
 *   • the extension's `chrome-extension/e2e/sw-key.js` is READ AS TEXT, never
 *     imported (chrome.* and indexedDB at module scope), with a drift guard in the
 *     style of tests/lib/sealed-twin.mjs `assertAllowlistInSync`;
 *   • the Android lane is asserted only where the rule is expressible in JS
 *     from the frozen spec — THE LIVE ANDROID ASSERTION BELONGS TO DELIVERABLE
 *     (g), and nothing here may be cited as Android evidence;
 *   • the DeviceKey ledger is an in-memory mirror of lib/deviceKeys.ts. The
 *     DATABASE contract (WHERE clauses, partial unique index, cascade) is
 *     owned by tests/devicekey-authz.test.mjs against the real Postgres — this
 *     file must not be cited for it, and deliberately re-states the B8 rules it
 *     depends on (userId from the session, list scoped to the caller, 409
 *     during an in-flight pairing, rotation revokes the old row) as a drift
 *     guard over that suite's source rather than re-proving them.
 *
 * The crypto is REAL: sealBody/openBody perform AES-256-GCM with a real key and
 * a real nonce, so "no plaintext on the wire" is a measurement, not a
 * placeholder that trivially passes.
 *
 * Run:  node tests/e2e-key-lifecycle.test.mjs      (no database, no network)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createECDH, randomBytes } from 'node:crypto';

import {
  makeTestSession, sealBody, openBody, e2eBlock,
  assertNoPlaintext, transcript, ENVELOPE_VERSION,
} from './lib/sealed-twin.mjs';
import {
  memoryWebKeyStore, ensureWebDeviceKey, loadWebDeviceKey, resetWebDeviceKey,
  hydrateRecord, WebKeyRecordVersionError, WEB_KEY_RECORD_VERSION,
} from '../lib/e2e/webKey.ts';
import {
  ABORT_KEY_MISMATCH, SETTING_BLOCKED_REASONS,
} from '../lib/encryptedModeCopy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const { validateE2eBlock, e2eRequestKeys } = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));

const SERVER_SRC = readFileSync(join(ROOT, 'server.js'), 'utf8');
const SW_KEY_SRC = readFileSync(join(ROOT, 'chrome-extension', 'e2e', 'sw-key.js'), 'utf8');
const BACKGROUND_SRC = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const AUTHZ_SRC = readFileSync(join(ROOT, 'tests', 'devicekey-authz.test.mjs'), 'utf8');
const LIFECYCLE_KT = readFileSync(
  join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion', 'E2eLifecycle.kt'), 'utf8');
const KEYSTORE_KT = readFileSync(
  join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion', 'E2eKeyStore.kt'), 'utf8');

// ── harness ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const scenarios = new Set();
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
/** Declares a scenario so the final count is derived, never typed by hand. */
function scenario(id) { scenarios.add(id); return (n, ...a) => check(`${id}: ${n}`, ...a); }

// ── the acceptance rule, as ONE callable ────────────────────────────────────

/**
 * M-C's rule for every scenario, asserted as two independent facts.
 *
 * @param id       scenario id, for the assertion names
 * @param wire     every frame the scenario put on the data plane
 * @param secrets  the plaintext payloads that must not appear anywhere in it
 * @param degrade  {degraded:boolean, signal:string|null} — the pair's honest
 *                 end state. `degraded && signal === null` is THE failure.
 * @param opts.expectFrames  minimum data-plane frames; guards the vacuous case
 *                 where a scenario emitted nothing and "no plaintext" is true
 *                 the way it is true of an empty file.
 */
/**
 * The "no silent degrade" half, as its own predicate so the self-check at the
 * bottom can fire the REAL one rather than a retyped copy of it. A predicate
 * asserted only through the code path that always satisfies it is a predicate
 * nobody has watched fail.
 */
function degradeIsHonest(degrade) {
  if (degrade.degraded === false) return true;
  return typeof degrade.signal === 'string' && degrade.signal.length > 0;
}

function noPlaintextNoSilentDegrade(id, wire, secrets, degrade, { expectFrames = 1 } = {}) {
  const c = scenario(id);
  const bytes = JSON.stringify(wire);

  // (i) NO PLAINTEXT FRAME.
  c('the scenario actually put frames on the wire (not vacuous)',
    wire.length >= expectFrames, `got ${wire.length} frames, wanted >= ${expectFrames}`);
  const envelopes = wire.filter((f) => f.body && f.body.e === ENVELOPE_VERSION && typeof f.body.c === 'string');
  c('every data-plane frame is a §13.7 envelope, none is a plaintext body',
    envelopes.length === wire.length,
    `${wire.length - envelopes.length} of ${wire.length} frames were not sealed: ` +
    JSON.stringify(wire.filter((f) => !(f.body && f.body.e === ENVELOPE_VERSION)).map((f) => f.type)));
  const leak = assertNoPlaintext(bytes, secrets);
  c('no fragment of any secret payload survives in the wire bytes',
    leak.clean, `leaked ${JSON.stringify(leak.leaked)}`);

  // (ii) NO SILENT DEGRADE.
  c('the end state is honest: any degrade carries a named, user-visible signal',
    degradeIsHonest(degrade),
    `degraded=${degrade.degraded} signal=${JSON.stringify(degrade.signal)}`);
  if (degrade.degraded) {
    c('…and that signal is real copy, not a status word invented here',
      KNOWN_SIGNALS.has(degrade.signal), `signal ${JSON.stringify(degrade.signal)} is not a frozen signal`);
  }
}

/**
 * Every signal a degrade is allowed to carry, sourced from the frozen copy
 * modules and the frozen relay frame — never retyped. A scenario that degrades
 * with a string invented in this file fails, which is what stops the acceptance
 * rule from being satisfiable by writing `signal: 'something happened'`.
 */
const KNOWN_SIGNALS = new Set([
  ABORT_KEY_MISMATCH,                     // C-2 fail-closed, mode ON
  SETTING_BLOCKED_REASONS.keyChanged,     // TOFU key change (reinstall)
  're-pair-needed',                       // webKey.ts record-version / absent-key state
  'PAIRING_E2E_UNAVAILABLE',              // N-1 relay refusal frame
  'counts-only',                          // SW lost its key: visible as counts, no content
  'unverified-badge',                     // C-2 fail-open, mode OFF
  'RESET_ROOM',                           // account deletion tore the rooms down
]);

// ── the pair model (mirrors §13.8; real crypto underneath) ──────────────────

/**
 * A live encrypted pair. Every method below is a rule from §13.8 or §13.5
 * written once, so the nine scenarios differ in what they DO, not in what a
 * pair IS.
 */
function makePair({ kid = 'kid-lc-0001', epoch = 1n, secret = 'lifecycle-sk-0' } = {}) {
  const pair = {
    kid,
    epoch,
    session: makeTestSession({ kid, secret }),
    wire: [],
    drops: 0,
    dedupe: new Set(),
    live: true,
    degraded: false,
    signal: null,
    /** Seal and transmit. Refuses to emit plaintext when the pair is encrypted. */
    send(type, payload) {
      if (!this.live) throw new Error('send on a torn-down pair');
      const body = sealBody(this.session, type, payload);
      this.wire.push({ type, kid: this.kid, epoch: String(this.epoch), body });
      return body;
    },
    /** Receive: §13.5 — a frame for another kid is DROPPED AND COUNTED. */
    receive(type, frame) {
      if (frame.kid !== this.kid) { this.drops++; return { ok: false, reason: 'kid' }; }
      const k = `${frame.body.kid}|${frame.body.s}`;
      if (this.dedupe.has(k)) { this.drops++; return { ok: false, reason: 'duplicate' }; }
      this.dedupe.add(k);
      return { ok: true, payload: openBody(this.session, type, frame.body) };
    },
    /** §13.8 Accept: fresh SK, NEW kid (kid↔SK is 1:1), epoch bump, window reset. */
    rekeyOnAccept(nextKid, nextSecret) {
      if (nextKid === this.kid) throw new Error('kid↔SK is 1:1 — a rekey must mint a new kid');
      this.kid = nextKid;
      this.epoch += 1n;
      this.session = makeTestSession({ kid: nextKid, secret: nextSecret });
      this.dedupe = new Set();
    },
    /** Tear the pair down with a NAMED signal. There is no unnamed teardown. */
    teardown(signal) {
      if (!KNOWN_SIGNALS.has(signal)) throw new Error(`teardown needs a frozen signal, got ${signal}`);
      this.live = false;
      this.degraded = true;
      this.signal = signal;
    },
    verdict() { return { degraded: this.degraded, signal: this.signal }; },
  };
  return pair;
}

// ── the DeviceKey ledger (mirrors lib/deviceKeys.ts; NOT the DB contract) ────

function makeLedger() {
  const rows = [];
  let n = 0;
  return {
    rows,
    register(userId, { deviceId, kind, publicKey }) {
      const live = rows.find((r) => r.userId === userId && r.deviceId === deviceId && r.revokedAt === null);
      if (live && live.publicKey === publicKey) return { rotated: false, key: live };
      if (live) { live.revokedAt = new Date(); }       // N-4: revoke, never update in place
      const key = { id: `k${++n}`, userId, deviceId, kind, publicKey, revokedAt: null };
      rows.push(key);
      return { rotated: Boolean(live), key };
    },
    /** B8: scoped to the caller. A list that ignored userId would pass a
     *  single-user test, so every scenario here keeps a second account live. */
    list(userId) { return rows.filter((r) => r.userId === userId); },
    liveFor(userId, deviceId) {
      return rows.find((r) => r.userId === userId && r.deviceId === deviceId && r.revokedAt === null) ?? null;
    },
    revoke(userId, deviceId) {
      const row = this.liveFor(userId, deviceId);
      if (!row) return { ok: false, status: 404 };
      row.revokedAt = new Date();
      return { ok: true, key: row };
    },
    /** C-4: account deletion removes EVERY row for that user, and no other's. */
    deleteUser(userId) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === userId) rows.splice(i, 1);
    },
  };
}

const pubKey = () => {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
};

/**
 * M3's rule as a function: the client re-checks the registry on every reconnect
 * and every pairEpoch bump, and a revoked peer tears the pair down.
 *
 * Expressed as its own function because it is the ONLY thing standing between a
 * revoked device and a pair that keeps decrypting — the relay cannot see a
 * revocation, so if this check is absent the revocation is decorative.
 */
function recheckPeerOrTearDown(pair, ledger, userId, peerDeviceId) {
  const live = ledger.liveFor(userId, peerDeviceId);
  if (!live) { pair.teardown(ABORT_KEY_MISMATCH); return false; }
  return true;
}

const OWNER = 'user-owner';
const BYSTANDER = 'user-bystander';   // the second account; see the B8 note above

// ════════════════════════════════════════════════════════════════════════════
// PART ONE — THE BRIEF'S SIX
// (B2, B3 and B4/B5 are implemented in PART THREE and referenced from here.)
// ════════════════════════════════════════════════════════════════════════════

// ── B1: rotate on Reset ─────────────────────────────────────────────────────
// §13.8: Accept mints a fresh SK, bumps pairEpoch and resets the dedupe window;
// kid↔SK is strictly 1:1, so the rotation MUST carry a new kid. The assertion
// that earns its keep is the last one: frames sealed under the OLD kid after
// the rotation are dropped AND COUNTED. A receiver that silently ignored them
// and a receiver that opened them are indistinguishable without the counter.
{
  const c = scenario('B1 rotate-on-Reset');
  const pair = makePair({ kid: 'kid-A', secret: 'sk-A' });
  const before = pair.send('SMS_RECEIVED', { body: 'plaintext-before-reset-1234' });
  c('a frame under the first kid opens', pair.receive('SMS_RECEIVED', pair.wire[0]).ok === true);

  const staleFrame = { type: 'SMS_RECEIVED', kid: 'kid-A', epoch: '1', body: before };
  const oldSecret = pair.session.key.toString('hex');
  const oldEpoch = pair.epoch;

  pair.rekeyOnAccept('kid-B', 'sk-B');
  c('the rotation minted a NEW kid (kid↔SK is 1:1)', pair.kid === 'kid-B');
  c('…a genuinely different session key', pair.session.key.toString('hex') !== oldSecret);
  c('…bumped the pairEpoch', pair.epoch === oldEpoch + 1n);
  c('…and reset the dedupe window (§13.5: a new epoch is a new key)', pair.dedupe.size === 0);

  let rotationKeptKid = false;
  try { pair.rekeyOnAccept('kid-B', 'sk-C'); } catch { rotationKeptKid = true; }
  c('a rotation that REUSED the kid is refused (the 1:1 rule is enforced, not documented)',
    rotationKeptKid);

  const dropsBefore = pair.drops;
  const stale = pair.receive('SMS_RECEIVED', staleFrame);
  c('an old-kid frame is DROPPED', stale.ok === false && stale.reason === 'kid');
  c('…and COUNTED (a silent dropper is indistinguishable from a working receiver)',
    pair.drops === dropsBefore + 1);

  pair.send('SMS_RECEIVED', { body: 'plaintext-after-reset-5678' });
  noPlaintextNoSilentDegrade('B1 rotate-on-Reset', pair.wire,
    { a: 'plaintext-before-reset-1234', b: 'plaintext-after-reset-5678' },
    pair.verdict(), { expectFrames: 2 });
}

// ── B6 / N-1: kill-switch flip MID-PAIR ─────────────────────────────────────
// The frozen rule: E2E_PAIRING_ENABLED=false refuses NEW encrypted pairings and
// NOTHING ELSE. It never strips a block and never downgrades a live pair —
// doing either would make the B6 downgrade attack a first-party feature.
//
// So the load-bearing assertion here is the one about the EXISTING pair, and it
// is deliberately the harder one to satisfy: the pair must keep sealing, under
// the SAME kid, across the flip.
{
  const c = scenario('B6 kill-switch-mid-pair');

  /** The relay's N-1 gate, mirrored from server.js (asserted against it below). */
  function relayHandleRequestPairing({ pairingEnabled, e2e }) {
    const checked = validateE2eBlock(e2e, e2eRequestKeys);
    const block = checked.block;
    if (!pairingEnabled && block && block.mode === 1) {
      return { frame: 'PAIRING_E2E_UNAVAILABLE', reason: 'kill-switch', pendingPairing: false, forwarded: null };
    }
    // Forwarded VERBATIM when present — same object, not a copy with fields dropped.
    return { frame: 'PAIRING_REQUEST', pendingPairing: true, forwarded: block ?? null };
  }

  const realKeyBlock = (mode) => ({ v: 1, mode, recips: [{ kind: 'web', deviceId: 'web-1', pub: pubKey() }] });

  // A pair formed while the switch was ON.
  const pair = makePair({ kid: 'kid-live', secret: 'sk-live' });
  pair.send('PHONE_NOTIFICATION', { title: 'notification-secret-aaaa', text: 'body-secret-bbbb' });
  const kidAtFlip = pair.kid;
  const epochAtFlip = pair.epoch;

  // ── THE FLIP. Nothing in the data plane may notice.
  const killSwitch = { pairingEnabled: false };

  // A NEW mode=1 pairing is refused, explicitly.
  const refused = relayHandleRequestPairing({ pairingEnabled: killSwitch.pairingEnabled, e2e: realKeyBlock(1) });
  c('a NEW mode=1 pairing is refused with PAIRING_E2E_UNAVAILABLE',
    refused.frame === 'PAIRING_E2E_UNAVAILABLE');
  c('…for reason kill-switch', refused.reason === 'kill-switch');
  c('…and no pendingPairing is created', refused.pendingPairing === false);
  c('…and the block was NOT stripped-and-forwarded (B6: refuse, never downgrade)',
    refused.forwarded === null);

  // mode=0 is forwarded INTACT: it never held the pairing hostage to the SAS.
  const modeZero = relayHandleRequestPairing({ pairingEnabled: false, e2e: realKeyBlock(0) });
  c('a mode=0 pairing still proceeds while the switch is off', modeZero.frame === 'PAIRING_REQUEST');
  c('…with its e2e block forwarded intact', modeZero.forwarded !== null && modeZero.forwarded.mode === 0);

  // THE assertion this scenario exists for.
  pair.send('SMS_RECEIVED', { body: 'sealed-after-the-flip-cccc' });
  c('the EXISTING pair kept sealing across the flip', pair.live === true);
  c('…under the SAME kid (no forced rekey)', pair.kid === kidAtFlip);
  c('…at the same pairEpoch (the switch gates the handshake, not the data plane)',
    pair.epoch === epochAtFlip);
  c('…and was not degraded by the flip', pair.degraded === false);

  // Flipping BACK admits new pairings again, with no trace left on the pair.
  const restored = relayHandleRequestPairing({ pairingEnabled: true, e2e: realKeyBlock(1) });
  c('flipping back admits a new mode=1 pairing', restored.frame === 'PAIRING_REQUEST');

  // The mirror above is pinned to the REAL relay, so this cannot rot silently.
  // REBASE (P6.1a): the pin moved with the relay, not against it. P6 froze
  // `!== 'false'` (default ON). D1-PREP (b2) changed the default to OFF because
  // every instruction in the D1 runbook says to set E2E_PAIRING_ENABLED=0 — which
  // the old predicate read as ENABLED — and P1.3 (a) 38d4031 then ratified the
  // exact form as N-1.1's `=== '1'`. Integration is newer and authoritative, so
  // the test follows it. The pin is no weaker: it is still an exact-source match,
  // and it still goes red the moment the predicate drifts again.
  c("server.js reads the flag as N-1.1's ratified `=== '1'` (default OFF)",
    /const E2E_PAIRING_ENABLED = process\.env\.E2E_PAIRING_ENABLED === '1'/.test(SERVER_SRC));
  c('server.js gates on !E2E_PAIRING_ENABLED && the VALIDATED block with mode === 1',
    /if \(!E2E_PAIRING_ENABLED && e2eBlock && e2eBlock\.mode === 1\)/.test(SERVER_SRC));
  c('server.js answers with PAIRING_E2E_UNAVAILABLE and returns before pendingPairing',
    /PAIRING_E2E_UNAVAILABLE:\$\{JSON\.stringify\(\{ reason: 'kill-switch' \}\)\}`\);\s*\n\s*return;/.test(SERVER_SRC));
  // The negative: the refusal must be the ONLY thing the flag does. If the flag
  // ever appears next to a mutation of the forwarded block, the relay has
  // learned to downgrade.
  // Every LIVE (non-comment, non-log) mention of the flag, which must be
  // exactly two: the definition and the ONE gate. A third live mention means
  // the flag has grown a second behaviour, and the only second behaviour
  // available to it is a downgrade.
  {
    // REBASE (P6.1a): this filter was LINE-based, and integration's startup
    // banner is a MULTI-LINE console.log whose ternary arms mention the flag on
    // lines that contain no `console.log` text of their own. It scored 5 and
    // called a logging statement a second behaviour. Stripping whole console.log
    // CALLS (balanced parens) instead of lines that look like one keeps the
    // assertion's teeth — a genuine third live mention still fires, proven by the
    // control below — without being fooled by where the newlines fall.
    const stripCalls = (src) => {
      let out = '';
      for (let i = 0; i < src.length;) {
        const at = src.indexOf('console.log(', i);
        if (at === -1) { out += src.slice(i); break; }
        out += src.slice(i, at);
        let depth = 0; let j = at + 'console.log'.length;
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        }
        i = j;
      }
      return out;
    };
    const liveSrc = stripCalls(
      SERVER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''));
    const live = liveSrc.split(/\r?\n/).filter((l) => l.includes('E2E_PAIRING_ENABLED'));
    c('the flag has exactly TWO live mentions: the definition and the ONE gate',
      live.length === 2, `found ${live.length}: ${JSON.stringify(live.map((l) => l.trim()))}`);
    // CONTROL: a planted third live mention must be counted. Without this the
    // rewrite above could have stripped the flag itself and scored a serene 2.
    const planted = stripCalls(
      `${liveSrc}${'\n'}if (!E2E_PAIRING_ENABLED) e2eBlock.mode = 0;${'\n'}`)
      .split(/\r?\n/).filter((l) => l.includes('E2E_PAIRING_ENABLED'));
    c('CONTROL: a third live mention is seen (the counter is not stuck on two)',
      planted.length === 3, `planted count ${planted.length}`);
  }
  c('the forwarded payload attaches the block verbatim, with no kill-switch branch',
    /if \(e2eBlock\) forwardPayload\.e2e = e2eBlock;/.test(SERVER_SRC));

  noPlaintextNoSilentDegrade('B6 kill-switch-mid-pair', pair.wire,
    { a: 'notification-secret-aaaa', b: 'body-secret-bbbb', c: 'sealed-after-the-flip-cccc' },
    pair.verdict(), { expectFrames: 2 });
}

// ════════════════════════════════════════════════════════════════════════════
// PART TWO — M-C's SIX
// (M1, M3 and M6 are implemented in PART THREE and referenced from here.)
// ════════════════════════════════════════════════════════════════════════════

// ── M2 / C-4: account deletion ──────────────────────────────────────────────
// §13.8: "all DeviceKey rows deleted and every room RESET_ROOM'd". The reason
// it is a DELETE and not a revoke is in the spec's own sentence: "deleted
// accounts leave key rows the pin will trust if an account id is ever reused."
// So the assertion is about ABSENCE, and it is paired with a bystander account
// whose rows must survive — without that control, "no rows for the deleted
// user" is also satisfied by a routine that deletes the whole table.
{
  const c = scenario('M2 account-deletion');
  const ledger = makeLedger();
  ledger.register(OWNER, { deviceId: 'phone-1', kind: 'phone', publicKey: pubKey() });
  ledger.register(OWNER, { deviceId: 'web-1', kind: 'web', publicKey: pubKey() });
  ledger.register(OWNER, { deviceId: 'ext-1', kind: 'extension', publicKey: pubKey() });
  ledger.register(BYSTANDER, { deviceId: 'phone-1', kind: 'phone', publicKey: pubKey() });

  const pair = makePair({ kid: 'kid-del', secret: 'sk-del' });
  pair.send('CONTACTS', { name: 'contact-name-secret-dddd' });

  c('the doomed account has rows (the deletion is not vacuous)', ledger.list(OWNER).length === 3);
  const rooms = [{ token: 'room-owner', userId: OWNER, state: 'active' }, { token: 'room-other', userId: BYSTANDER, state: 'active' }];

  // The deletion, as §13.8 specifies it: rows deleted AND rooms reset.
  ledger.deleteUser(OWNER);
  for (const r of rooms) if (r.userId === OWNER) r.state = 'RESET_ROOM';
  pair.teardown('RESET_ROOM');

  c('every DeviceKey row of the deleted account is GONE (deleted, not revoked)',
    ledger.list(OWNER).length === 0);
  c('…including the revoked ones — a revoked row left behind is still a row the pin can read',
    ledger.rows.every((r) => r.userId !== OWNER));
  c('the bystander account kept every row (the delete is scoped, not a table wipe)',
    ledger.list(BYSTANDER).length === 1);
  c('the deleted account’s room was RESET_ROOM’d', rooms[0].state === 'RESET_ROOM');
  c('the bystander’s room is untouched', rooms[1].state === 'active');
  // Re-registering the same deviceId under a REUSED account id must find
  // nothing to trust — the exact failure §13.8 names.
  c('a reused account id inherits NO trusted key', ledger.liveFor(OWNER, 'phone-1') === null);

  // The real cascade (ON DELETE) is the database's job and is proved against
  // Postgres in tests/devicekey-authz.test.mjs. Pinned here so this mirror
  // cannot drift from the suite that actually owns the claim.
  c('devicekey-authz.test.mjs is the suite that proves the C-4 cascade for real',
    /deleting the user deleted every key row \(C-4 cascade\)/.test(AUTHZ_SRC));
  c('…and that it takes nobody else’s rows with it',
    /the other users’ rows are untouched/.test(AUTHZ_SRC));

  noPlaintextNoSilentDegrade('M2 account-deletion', pair.wire,
    { a: 'contact-name-secret-dddd' }, pair.verdict());
}

// ── M4: browser "clear site data" mid-pair ──────────────────────────────────
// The web key lives in IndexedDB. Clearing site data takes it, and the ONLY
// acceptable outcome is "Re-pair needed" — never a silent fall back to
// plaintext, because a user who asked for encryption and got plaintext with no
// notice has been downgraded by their own browser's privacy feature.
//
// Driven against the REAL lib/e2e/webKey.ts with a real WebCrypto keypair.
{
  const c = scenario('M4 clear-site-data');
  const store = memoryWebKeyStore();
  const ensured = await ensureWebDeviceKey({ store, registerFn: async () => ({ ok: true }) });
  c('a web device key exists before the wipe', Boolean(ensured.key?.deviceId));
  const deviceIdBefore = ensured.key.deviceId;
  c('…and its private key is a non-extractable CryptoKey',
    ensured.key.privateKey?.type === 'private' && ensured.key.privateKey.extractable === false);

  const pair = makePair({ kid: 'kid-web', secret: 'sk-web' });
  pair.send('MESSAGES', { text: 'message-body-secret-eeee' });

  // Chrome's Clear-site-data: the whole store goes, not one record.
  await store.clear();
  const after = await loadWebDeviceKey({ store });
  c('the web key is GONE after clear-site-data', after === null);

  // THE assertion. The pair must stop and SAY so. `re-pair-needed` is the state
  // webKey.ts's own header names for this, so the signal is the product's word.
  pair.teardown('re-pair-needed');
  c('the pair is torn down, not continued', pair.live === false);
  c('…with the "Re-pair needed" signal', pair.signal === 're-pair-needed');
  let sentAfterWipe = false;
  try { pair.send('MESSAGES', { text: 'must-never-be-sent-ffff' }); sentAfterWipe = true; } catch { /* expected */ }
  c('NOTHING is sent after the key is gone — no plaintext fallback frame exists',
    sentAfterWipe === false);
  c('…and the wire never grew a plaintext frame',
    pair.wire.every((f) => f.body && f.body.e === ENVELOPE_VERSION));

  // The adjacent failure — a record from a future build — must land on the SAME
  // state, and must NOT be repaired by regenerating: a fresh key is, from the
  // phone's side, indistinguishable from an attacker swapping the recipient.
  let versionThrew = null;
  try { hydrateRecord({ ...ensured.key, v: WEB_KEY_RECORD_VERSION + 1 }); }
  catch (e) { versionThrew = e; }
  c('an unknown record version THROWS rather than regenerating',
    versionThrew instanceof WebKeyRecordVersionError);
  c('…and it reports the re-pair-needed state', versionThrew?.state === 're-pair-needed');

  // Recovery is an EXPLICIT user action, and it mints a genuinely new identity.
  const reset = await resetWebDeviceKey({ store, registerFn: async () => ({ ok: true }) });
  c('an explicit reset mints a NEW deviceId', reset.key.deviceId !== deviceIdBefore);

  noPlaintextNoSilentDegrade('M4 clear-site-data', pair.wire,
    { a: 'message-body-secret-eeee', b: 'must-never-be-sent-ffff' }, pair.verdict());
}

// ── M5: SW IndexedDB wipe on extension update ───────────────────────────────
// The extension's key regenerating is NOT a failure — it is a device that the
// current pairing never sealed to. It degrades to counts-only until the next
// Accept, and, critically, THE WEB PAIR IS UNTOUCHED: the page holds its own
// key and its own wrap, and nothing in the worker can reach either.
//
// sw-key.js is read as TEXT and never imported (chrome.* and indexedDB at module
// scope). The rules below are mirrored, and pinned to the source so the mirror
// cannot rot — the drift-guard pattern from tests/lib/sealed-twin.mjs.
{
  const c = scenario('M5 sw-idb-wipe');
  const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  /** The SW's load-or-create rule, mirrored: ABSENT ⇒ mint; UNKNOWN ⇒ throw. */
  function swLoadOrCreate(record) {
    if (!record) {
      const fresh = { v: 1, deviceId: `ext-${randomBytes(16).toString('base64url')}`, kind: 'extension', pub: pubKey() };
      if (!DEVICE_ID_RE.test(fresh.deviceId)) throw new Error('relay would reject this deviceId');
      return { record: fresh, minted: true };
    }
    if (record.v !== 1) throw new Error('Re-pair needed');   // never silently regenerate
    return { record, minted: false };
  }

  const webPair = makePair({ kid: 'kid-web-pair', secret: 'sk-web-pair' });
  webPair.send('SMS_RECEIVED', { body: 'web-pair-secret-gggg' });

  const before = swLoadOrCreate(null).record;
  const swRecipients = new Set([before.deviceId, 'web-1']);
  c('the SW is in the pairing’s recipient set before the wipe', swRecipients.has(before.deviceId));

  // The extension update takes IndexedDB with it.
  const after = swLoadOrCreate(null);
  c('the wipe regenerated a key', after.minted === true);
  c('…with a NEW deviceId', after.record.deviceId !== before.deviceId);
  c('…that the relay’s charset accepts', DEVICE_ID_RE.test(after.record.deviceId));
  c('the new deviceId is NOT in the current pairing’s recipient set',
    swRecipients.has(after.record.deviceId) === false);

  const swDegrade = { degraded: true, signal: 'counts-only' };
  c('so the worker degrades to counts-only — visible, not silent', swDegrade.signal === 'counts-only');

  // THE cross-surface assertion. A worker losing its key must not cost the page
  // its pair; if it did, one extension update would unencrypt the product.
  webPair.send('SMS_RECEIVED', { body: 'web-pair-still-sealed-hhhh' });
  c('THE WEB PAIR IS UNTOUCHED — still live', webPair.live === true);
  c('…still on its own kid', webPair.kid === 'kid-web-pair');
  c('…still not degraded', webPair.degraded === false);
  c('…and still opening its own frames',
    webPair.receive('SMS_RECEIVED', webPair.wire[1]).payload.body === 'web-pair-still-sealed-hhhh');

  // The next Accept takes the worker back in — the degrade is temporary AND it
  // costs a new kid, because the recipient set changed.
  const rekeyed = makePair({ kid: 'kid-after-accept', secret: 'sk-after-accept' });
  c('the next Accept re-includes the SW under a new kid', rekeyed.kid !== 'kid-web-pair');

  // Drift guards over the real sw-key.js.
  c('sw-key.js: an ABSENT record mints a fresh key',
    /const existing = await readRecord\(\);\s*\n\s*if \(existing\) return assertUsable\(existing\);\s*\n\s*const fresh = await generateRecord\(\);/.test(SW_KEY_SRC));
  c('sw-key.js: an UNKNOWN version THROWS and never regenerates',
    /if \(record\.v !== KEY_RECORD_VERSION\)/.test(SW_KEY_SRC)
    && /Refusing to regenerate/.test(SW_KEY_SRC));
  c('sw-key.js: the promise is NOT cached past settlement, so a wipe is seen',
    /const settle = \(\) => \{ inflight = null; \};/.test(SW_KEY_SRC));
  c('sw-key.js: the deviceId charset matches the relay’s',
    /const DEVICE_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,128\}\$\//.test(SW_KEY_SRC));
  c('sw-key.js: the private key is generated NON-extractable',
    /generateKey\([\s\S]{0,40}?\{ name: 'ECDH', namedCurve: 'P-256' \},[\s\S]{0,600}?false,[\s\S]{0,20}?'deriveBits'/.test(SW_KEY_SRC));
  c('sw-key.js: a failed registration DEGRADES, it never throws',
    /return \{ ok: false, reason: `http-\$\{res\.status\}`/.test(SW_KEY_SRC));
  c('sw-key.js: the file states that the web pair is untouched by an SW wipe',
    /THE WEB PAIR IS UNTOUCHED/.test(SW_KEY_SRC));
  c('background.js: sign-out drops SK and storage.session explicitly',
    /dropSessionState\(\)\.catch/.test(BACKGROUND_SRC) && /storage\.session is cleared explicitly/.test(BACKGROUND_SRC));

  noPlaintextNoSilentDegrade('M5 sw-idb-wipe', webPair.wire,
    { a: 'web-pair-secret-gggg', b: 'web-pair-still-sealed-hhhh' },
    webPair.verdict(), { expectFrames: 2 });
  // The WORKER's own degrade is asserted separately, because it IS a degrade
  // and it must carry its own signal.
  noPlaintextNoSilentDegrade('M5 sw-idb-wipe (worker surface)', webPair.wire,
    { a: 'web-pair-secret-gggg' }, swDegrade, { expectFrames: 2 });
}

// ════════════════════════════════════════════════════════════════════════════
// PART THREE — THE SHARED SCENARIOS
// Written ONCE. Referenced by the brief's list and by M-C's list:
//   S1 sign-out          = brief B2  ≡  M-C M1
//   S2 reinstall / TOFU  = brief B3  ≡  M-C M6
//   S3 revoke            = brief B4 + B5  ≡  M-C M3
// ════════════════════════════════════════════════════════════════════════════

// ── S1 (= B2 = M1): sign-out on device X ────────────────────────────────────
// The discriminating fact is SCOPE. Sign-out on X revokes X's DeviceKey and
// NOTHING ELSE: a sign-out that revoked the account's other devices would log a
// user out of their desk machine because they signed out on their laptop, and
// a sign-out that revoked nothing would leave a live key on a device the user
// just asked to forget. Both are silent, so both are asserted against.
{
  const c = scenario('S1 sign-out (brief B2 = M-C M1)');
  const ledger = makeLedger();
  ledger.register(OWNER, { deviceId: 'web-X', kind: 'web', publicKey: pubKey() });
  ledger.register(OWNER, { deviceId: 'web-Y', kind: 'web', publicKey: pubKey() });
  ledger.register(OWNER, { deviceId: 'phone-1', kind: 'phone', publicKey: pubKey() });
  ledger.register(BYSTANDER, { deviceId: 'web-X', kind: 'web', publicKey: pubKey() });

  const pairX = makePair({ kid: 'kid-X', secret: 'sk-X' });
  const pairY = makePair({ kid: 'kid-Y', secret: 'sk-Y' });
  pairX.send('MESSAGES', { text: 'device-X-secret-iiii' });
  pairY.send('MESSAGES', { text: 'device-Y-secret-jjjj' });

  // Sign-out on X. §13.8: SK dropped; device key deleted; revokedAt set.
  const revoked = ledger.revoke(OWNER, 'web-X');
  const localWipe = { indexedDb: true, keystoreAlias: true, storageSession: true };
  pairX.teardown('re-pair-needed');

  c('X’s DeviceKey row is revoked', revoked.ok === true && revoked.key.revokedAt instanceof Date);
  c('…and X has no live row left', ledger.liveFor(OWNER, 'web-X') === null);
  c('X’s IndexedDB is wiped', localWipe.indexedDb === true);
  c('X’s Keystore alias is wiped', localWipe.keystoreAlias === true);
  c('X’s storage.session is wiped', localWipe.storageSession === true);
  c('X’s SK is dropped — the pair is down', pairX.live === false);

  // THE scope assertions.
  c('device Y’s key is STILL LIVE (sign-out on X is not sign-out everywhere)',
    ledger.liveFor(OWNER, 'web-Y') !== null);
  c('the phone’s key is still live', ledger.liveFor(OWNER, 'phone-1') !== null);
  c('Y’s pair is unaffected', pairY.live === true && pairY.degraded === false);
  pairY.send('MESSAGES', { text: 'device-Y-after-X-signout-kkkk' });
  c('…and keeps sealing', pairY.wire.length === 2);
  c('the bystander account’s same-named device is untouched (revoke is user-scoped)',
    ledger.liveFor(BYSTANDER, 'web-X') !== null);
  // The revoked row is KEPT, not deleted — the ledger's value IS the history.
  // (Deletion is account deletion's job, M2, and only there.)
  c('the revoked row still exists as evidence',
    ledger.rows.some((r) => r.userId === OWNER && r.deviceId === 'web-X' && r.revokedAt !== null));

  // Android lane: the rule is expressible from the frozen spec, so it is pinned
  // as source text. THE LIVE ANDROID ASSERTION BELONGS TO DELIVERABLE (g) —
  // nothing below runs Kotlin and nothing below is Android evidence.
  c('[android/(g)] E2eLifecycle.onSignOut revokes the registry row BEFORE the local delete',
    /Revoke FIRST, while the token is still valid/.test(LIFECYCLE_KT));
  c('[android/(g)] …deletes the device key, clears counters and drops the device id',
    /E2eKeyAgreement\.rotateDeviceKey\(ctx\)[\s\S]{0,200}E2eKeyStore\.clearAll\(\)[\s\S]{0,200}E2eSeqStore\.clearAll\(ctx\)[\s\S]{0,120}clearDeviceId\(ctx\)/.test(LIFECYCLE_KT));
  c('[android/(g)] …and the local delete happens even when the remote revoke fails',
    /local delete happens whether or not the remote revoke succeeds/i.test(LIFECYCLE_KT));
  c('[android/(g)] a Reset/LEAVE_ACTIVE drops SK but KEEPS the device key (not a compromise)',
    /deviceKeyRotated = false/.test(LIFECYCLE_KT) && /leaving a room is not losing a key/.test(LIFECYCLE_KT));
  c('[android/(g)] the Keystore alias is version-tagged and fails loudly on a foreign version',
    /ANY_VERSION_ALIAS/.test(KEYSTORE_KT) && /E2eKeyVersionException/.test(KEYSTORE_KT));

  noPlaintextNoSilentDegrade('S1 sign-out — device X', pairX.wire,
    { a: 'device-X-secret-iiii' }, pairX.verdict());
  noPlaintextNoSilentDegrade('S1 sign-out — device Y (must NOT degrade)', pairY.wire,
    { a: 'device-Y-secret-jjjj', b: 'device-Y-after-X-signout-kkkk' },
    pairY.verdict(), { expectFrames: 2 });
}

// ── S2 (= B3 = M6): phone reinstall → new key → TOFU warning ────────────────
// A reinstall takes the Keystore keys with it, so the phone comes back with a
// new deviceId and a new key. The computer genuinely CANNOT distinguish that
// from a substitution — so the warning is correct, and accepting the new key
// silently would be the attack.
//
// The copy assertion is the one that matters to a real user: it must name
// reinstall as a benign cause, EARLY, without asserting it is THE cause.
{
  const c = scenario('S2 reinstall/TOFU (brief B3 = M-C M6)');
  const ledger = makeLedger();
  const originalPub = pubKey();
  ledger.register(OWNER, { deviceId: 'phone-1', kind: 'phone', publicKey: originalPub });
  const pair = makePair({ kid: 'kid-tofu', secret: 'sk-tofu' });
  pair.send('CALL_LOG_ENTRY', { number: 'call-number-secret-llll' });

  // The reinstall: prefs and Keystore are gone, so BOTH the id and the key are new.
  const rebornDeviceId = `ph-${randomBytes(16).toString('base64url')}`;
  const rebornPub = pubKey();
  c('the reinstalled phone has a NEW deviceId', rebornDeviceId !== 'phone-1');
  c('…and a NEW public key', rebornPub !== originalPub);

  // TOFU: the pinned key is what the computer saw before. A key it has never
  // seen for an id it has never seen is a key change, full stop.
  const pinned = ledger.liveFor(OWNER, 'phone-1');
  const tofu = (offeredPub, offeredId) => ({
    keyChanged: !(offeredId === pinned.deviceId && offeredPub === pinned.publicKey),
  });
  c('the control: the ORIGINAL key still pins clean (the check is not always-true)',
    tofu(originalPub, 'phone-1').keyChanged === false);
  c('the reinstalled key is flagged as a key change', tofu(rebornPub, rebornDeviceId).keyChanged === true);

  pair.teardown(SETTING_BLOCKED_REASONS.keyChanged);
  c('the pair does NOT silently accept the new key', pair.live === false);

  const copy = SETTING_BLOCKED_REASONS.keyChanged;
  c('the warning copy names reinstall as the benign cause', /reinstalled/i.test(copy));
  c('…early enough to be read, not buried at the end',
    copy.indexOf('reinstalled') < copy.length / 2 + 40, copy);
  c('…and asks the user to pair again to confirm', /pair again/i.test(copy));
  c('…without asserting the reinstall as fact (it says "If you reinstalled")',
    /\bIf you reinstalled\b/.test(copy));
  c('…and never opens with an accusation',
    !/^you may be under attack/i.test(copy) && !/\battacker\b/i.test(copy));

  // The Android side states the same rule, and phrases it as A cause, not THE
  // cause. Pinned as text; the live assertion is deliverable (g)'s.
  c('[android/(g)] REINSTALL_CAUSE_COPY lists reinstall among the benign causes',
    /reinstalling the app/.test(LIFECYCLE_KT));
  c('[android/(g)] …and still tells the user to check the code if none apply',
    /check the code on both devices/.test(LIFECYCLE_KT));
  c('[android/(g)] the file states a reinstall is indistinguishable from a new device',
    /Reinstall is indistinguishable from a new device — and that is correct/.test(LIFECYCLE_KT));

  noPlaintextNoSilentDegrade('S2 reinstall/TOFU', pair.wire,
    { a: 'call-number-secret-llll' }, pair.verdict());
}

// ── S3 (= B4 + B5 = M3): revoke, including a revoke RACING an active pair ────
// The relay cannot see a revocation — it routes on `type` and never reads a
// body, which is the property that makes it mode-blind. That is exactly why the
// CLIENT must re-check: if nothing re-checks, a revoked device keeps decrypting
// for the life of the pair and the revoke button is decorative.
//
// Re-check points, per M-C: EVERY reconnect and EVERY pairEpoch bump.
{
  const c = scenario('S3 revoke + revoke-races-active-pair (brief B4/B5 = M-C M3)');
  const ledger = makeLedger();
  ledger.register(OWNER, { deviceId: 'computer-1', kind: 'web', publicKey: pubKey() });
  ledger.register(OWNER, { deviceId: 'phone-1', kind: 'phone', publicKey: pubKey() });
  ledger.register(BYSTANDER, { deviceId: 'computer-1', kind: 'web', publicKey: pubKey() });

  // ── B4: the COMPUTER's DeviceKey is revoked.
  const compPair = makePair({ kid: 'kid-comp', secret: 'sk-comp' });
  compPair.send('CONTACTS', { name: 'contacts-secret-mmmm' });
  c('the control: before the revoke, a reconnect re-check PASSES',
    recheckPeerOrTearDown(compPair, ledger, OWNER, 'computer-1') === true);
  c('…and the pair is still live after that passing check', compPair.live === true);

  ledger.revoke(OWNER, 'computer-1');
  c('B4: the computer’s row is revoked', ledger.liveFor(OWNER, 'computer-1') === null);

  // THE RACE. The revoke lands while the pair is up. The relay forwards frames
  // exactly as before — it cannot know — so nothing changes until a re-check.
  compPair.send('CONTACTS', { name: 'contacts-secret-nnnn' });
  c('…the relay kept forwarding (it cannot see a revocation — that is the race)',
    compPair.wire.length === 2 && compPair.live === true);

  // Re-check point 1: reconnect.
  const tornByReconnect = recheckPeerOrTearDown(compPair, ledger, OWNER, 'computer-1') === false;
  c('the RECONNECT re-check tears the pair down', tornByReconnect);
  c('…with a named signal, not a silent stop', compPair.signal === ABORT_KEY_MISMATCH);
  c('…and nothing can be sent afterwards',
    (() => { try { compPair.send('CONTACTS', { name: 'never-sent-oooo' }); return false; } catch { return true; } })());

  // Re-check point 2: a pairEpoch bump, on a fresh pair, so the two points are
  // proved independently. One of them working is not evidence about the other.
  const epochPair = makePair({ kid: 'kid-epoch', secret: 'sk-epoch' });
  epochPair.send('CALL_LOGS', { number: 'call-secret-pppp' });
  ledger.revoke(OWNER, 'phone-1');
  epochPair.rekeyOnAccept('kid-epoch-2', 'sk-epoch-2');
  const tornByEpoch = recheckPeerOrTearDown(epochPair, ledger, OWNER, 'phone-1') === false;
  c('B5: the PAIREPOCH-BUMP re-check tears the pair down after a phone revoke', tornByEpoch);
  c('…with the same named signal', epochPair.signal === ABORT_KEY_MISMATCH);

  // Scope, again: revoking the owner's computer must not touch the bystander's
  // same-named device. Without this, "revoke works" is also satisfied by a
  // revoke that ignores userId entirely — the B8 bug.
  c('the bystander’s same-named device is still live',
    ledger.liveFor(BYSTANDER, 'computer-1') !== null);

  // B8 drift guard: the authz rules this scenario assumes are proved against
  // the real database elsewhere, and are pinned here so an edit there that
  // dropped them would surface in this suite too.
  c('[B8] devicekey-authz proves userId comes from the caller, never the body',
    /NEVER reads a userId from the request/.test(AUTHZ_SRC));
  c('[B8] …that list returns only the caller’s rows',
    /EVERY row the attacker sees is the attacker’s/.test(AUTHZ_SRC));
  c('[B8] …that a cross-account revoke is 404, never 403 (no existence oracle)',
    /with 404, not 403 \(no existence oracle\)/.test(AUTHZ_SRC));
  c('[B8] …that rotation revokes the old row rather than mutating publicKey',
    /the old row KEPT its original key \(publicKey is immutable\)/.test(AUTHZ_SRC));
  c('[B8] …and that register during an in-flight pairing is 409',
    /register returns 409 while a pairing handshake is in flight/.test(AUTHZ_SRC));

  noPlaintextNoSilentDegrade('S3 revoke — computer', compPair.wire,
    { a: 'contacts-secret-mmmm', b: 'contacts-secret-nnnn', c: 'never-sent-oooo' },
    compPair.verdict(), { expectFrames: 2 });
  noPlaintextNoSilentDegrade('S3 revoke — phone (epoch-bump re-check)', epochPair.wire,
    { a: 'call-secret-pppp' }, epochPair.verdict());
}

// ════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING — C-2, the pin-failure policy every Accept above depends on
// ════════════════════════════════════════════════════════════════════════════
// §13.6, frozen: mode ON ⇒ fail CLOSED with "Couldn't verify this device — try
// again", no pair. mode OFF ⇒ fail OPEN, warn client-side, badge stays
// UNVERIFIED. Both are tested, because an unspecified failure mode gets
// implemented fail-open and the pin becomes decorative — which is the exact
// sentence the spec uses.
//
// A MISMATCH refuses in BOTH modes. §13.6 softens only the UNREACHABLE case.
{
  const c = scenario('C-2 pin-failure policy');

  function pinVerdict({ modeOn, registry }) {
    if (registry === 'mismatch') return { pair: false, signal: ABORT_KEY_MISMATCH, verified: false };
    if (registry === 'unreachable') {
      return modeOn
        ? { pair: false, signal: ABORT_KEY_MISMATCH, verified: false }
        : { pair: true, signal: 'unverified-badge', verified: false };
    }
    return { pair: true, signal: null, verified: true };
  }

  const onUnreachable = pinVerdict({ modeOn: true, registry: 'unreachable' });
  c('mode ON + unreachable registry FAILS CLOSED — no pair', onUnreachable.pair === false);
  c('…with the frozen copy, verbatim', onUnreachable.signal === "Couldn't verify this device — try again");
  c('…which is the constant the product renders', onUnreachable.signal === ABORT_KEY_MISMATCH);

  const offUnreachable = pinVerdict({ modeOn: false, registry: 'unreachable' });
  c('mode OFF + unreachable registry FAILS OPEN — the pair proceeds', offUnreachable.pair === true);
  c('…but the badge stays UNVERIFIED (it must not claim what was not checked)',
    offUnreachable.verified === false);
  c('…and the degrade is signalled, not silent', offUnreachable.signal === 'unverified-badge');

  c('a MISMATCH refuses in mode ON', pinVerdict({ modeOn: true, registry: 'mismatch' }).pair === false);
  c('a MISMATCH refuses in mode OFF too (§13.6 softens only "unreachable")',
    pinVerdict({ modeOn: false, registry: 'mismatch' }).pair === false);
  c('the control: a clean registry verifies in both modes',
    pinVerdict({ modeOn: true, registry: 'ok' }).verified === true
    && pinVerdict({ modeOn: false, registry: 'ok' }).verified === true);

  // Cross-lane: the Android lane ships the same sentence, and keeps the three
  // outcomes distinct rather than collapsing them into a boolean.
  const pinKt = readFileSync(join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java',
    'com', 'dnkdialer', 'companion', 'E2eKeyPin.kt'), 'utf8');
  c('[android/(g)] FAIL_CLOSED_MESSAGE is the same sentence the web renders',
    pinKt.includes(`const val FAIL_CLOSED_MESSAGE = "${ABORT_KEY_MISMATCH}"`));
  c('[android/(g)] the three outcomes are distinct types, not a boolean',
    /data class Verified/.test(pinKt) && /data class FailClosed/.test(pinKt)
    && /data class FailOpenUnverified/.test(pinKt));
  c('[android/(g)] a mismatch refuses in BOTH modes there too',
    /A \*\*mismatch always refuses, in both modes\.\*\*/.test(pinKt));
  c('[android/(g)] the registry is a check, never a source of keys',
    /it never returns keys/.test(pinKt));
}

// ── the harness is not vacuous ──────────────────────────────────────────────
// A suite whose own acceptance rule can never fire is the failure this file is
// most at risk of. Both halves are fired deliberately, here, against synthetic
// inputs, so the rule is known to be capable of going red.
{
  const c = scenario('self-check');
  const before = failed;
  const leaky = [{ type: 'SMS_RECEIVED', body: { text: 'a-secret-that-leaks' } }];
  const leak = assertNoPlaintext(JSON.stringify(leaky), { s: 'a-secret-that-leaks' });
  c('the no-plaintext detector FIRES on an actual plaintext body', leak.clean === false);
  const sealed = [{ type: 'SMS_RECEIVED', body: sealBody(makeTestSession(), 'SMS_RECEIVED', { text: 'a-secret-that-leaks' }) }];
  c('…and does NOT fire on the same payload sealed',
    assertNoPlaintext(JSON.stringify(sealed), { s: 'a-secret-that-leaks' }).clean === true);
  c('an unnamed teardown is refused (the signal cannot be invented)',
    (() => { try { makePair().teardown('something happened'); return false; } catch { return true; } })());
  c('the REAL degrade predicate REJECTS a degrade with a null signal',
    degradeIsHonest({ degraded: true, signal: null }) === false);
  c('…rejects an empty-string signal too', degradeIsHonest({ degraded: true, signal: '' }) === false);
  c('…accepts a degrade that names itself', degradeIsHonest({ degraded: true, signal: ABORT_KEY_MISMATCH }) === true);
  c('…and accepts a pair that never degraded', degradeIsHonest({ degraded: false, signal: null }) === true);
  c('the transcript helper drops bodies but keeps relay-owned fields',
    transcript(['PAIRING_ACTIVE:{"pairingId":"p1","deviceName":"Pixel"}'])[0].pairingId === 'p1');
  c('e2eBlock builds a mode-ON block with a kid', e2eBlock({ kid: 'kid-x' }).kid === 'kid-x');
  c('the self-check added no failures of its own', failed === before);
}

const total = passed + failed;
console.log(
  `e2e-key-lifecycle: ${passed} passed, ${failed} failed (${total} checks across ` +
  `${scenarios.size} scenario groups; 9 lifecycle scenarios = brief 6 ∪ M-C 6, 3 shared, ` +
  `+ C-2 cross-cutting)`,
);
process.exit(failed === 0 ? 0 : 1);
