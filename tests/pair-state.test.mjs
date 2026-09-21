// Relay tests — PAIR_STATE, the listener's view of pairing truth (FORGE-O, 2026-09-16).
//
// Run: node tests/pair-state.test.mjs
//
// WHY THIS EXISTS
// ---------------
// The extension's MV3 worker joins the relay as `?role=listener` and sits in
// room.lobby forever. It is never promoted into room.active, so it never
// receives PAIRING_ACTIVE or PAIRING_TERMINATED — those are sent to the ACTIVE
// sockets by name. The only pairing-ish frames it could see were LOBBY_STATUS on
// join and PHONE_PRESENT / PHONE_ABSENT, every one of which answers "is a phone
// in this room" and none of which answers "is a phone PAIRED to a browser".
//
// So the worker painted its green dot from presence. On 2026-09-16 the 6eb9bc7
// deploy restarted the relay, wiping the in-memory pair claim. The phone rejoined
// the LOBBY and pinged every 15 s; no pair existed; the dot stayed green for
// minutes over a connection that could not place a call. Dennis, 10:01: "showing
// 'phone connected and green dot' even though phone is not connected."
//
// PAIR_STATE:{phonePresent, paired, held} is the fix — the three facts stated
// together so they cannot disagree, sent to LISTENERS ONLY so the /app web client
// and the v55 APK are untouched (no APK change was needed or made).
//
// server.js cannot be imported without booting Next.js, so — following the
// established pattern in the sibling .mjs relay tests — PART 1 mirrors the
// relay's derivation. A mirror can drift from the thing it mirrors and keep
// passing, which would make this file worse than useless, so PART 2 asserts
// against the REAL server.js SOURCE that every transition actually broadcasts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPEN = 1;
const CLOSED = 3;
const RESUME_WINDOW_MS = 180_000;

let NOW = 1_000_000;
const now = () => NOW;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else {
    fail += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
  }
}

// ── PART 1 — the derivation, mirrored from server.js derivePairState ────────

const ws = (role, { listener = false, readyState = OPEN } = {}) =>
  ({ role, listener, readyState, sent: [] });

const mkRoom = () => ({ lobby: new Set(), active: { phone: null, browser: null }, resumable: null });

/** Mirror of server.js countLivePhones. */
function countLivePhones(room) {
  let n = 0;
  for (const s of room.lobby) if (s.role === 'phone' && s.readyState === OPEN) n += 1;
  if (room.active.phone && room.active.phone.readyState === OPEN) n += 1;
  return n;
}

/** Mirror of server.js derivePairState. */
function derivePairState(room) {
  const phoneOpen = !!(room.active.phone && room.active.phone.readyState === OPEN);
  const browserOpen = !!(room.active.browser && room.active.browser.readyState === OPEN);
  const paired = phoneOpen && browserOpen;
  const claimLive = !!(room.resumable && now() <= room.resumable.expiresAt);
  return { phonePresent: countLivePhones(room) > 0, paired, held: !paired && claimLive };
}

console.log('PART 1 — derivation');

// The bug, stated as a test. This is the 09:57 room: a phone in the lobby, no
// pair anywhere. Before FORGE-O the worker read `phonePresent` and went green.
{
  const room = mkRoom();
  room.lobby.add(ws('phone'));
  const s = derivePairState(room);
  check('lobby phone, no pair ⇒ present but NOT paired and NOT held',
    s.phonePresent === true && s.paired === false && s.held === false, s);
}

// An empty room.
{
  const s = derivePairState(mkRoom());
  check('empty room ⇒ nothing true',
    s.phonePresent === false && s.paired === false && s.held === false, s);
}

// A live pair — the ONLY green state. Without this passing, every assertion
// above is vacuous: a derivation that always returns paired:false satisfies them.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.active.browser = ws('browser');
  const s = derivePairState(room);
  check('both active slots OPEN ⇒ paired (the control arm)',
    s.phonePresent === true && s.paired === true && s.held === false, s);
}

// Half a pair is not a pair. A browser socket that died without its close
// handler having run yet must not keep the dot green.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.active.browser = ws('browser', { readyState: CLOSED });
  const s = derivePairState(room);
  check('active browser socket CLOSED ⇒ not paired', s.paired === false, s);
}
{
  const room = mkRoom();
  room.active.phone = ws('phone', { readyState: CLOSED });
  room.active.browser = ws('browser');
  const s = derivePairState(room);
  check('active phone socket CLOSED ⇒ not paired', s.paired === false, s);
  check('…and a closed active phone is not counted present', s.phonePresent === false, s);
}

// The hold. FORGE-L/M: panel closed, phone held in the active slot, claim armed.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.resumable = { expiresAt: now() + RESUME_WINDOW_MS, panelHold: true };
  const s = derivePairState(room);
  check('panel closed, claim armed ⇒ held, not paired',
    s.paired === false && s.held === true && s.phonePresent === true, s);
}

// An EXPIRED claim is a torn-down pair wearing a live one's clothes. This is the
// same class of lie as the lobby-presence green and must not read as held.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.resumable = { expiresAt: now() - 1, panelHold: true };
  const s = derivePairState(room);
  check('EXPIRED claim ⇒ not held', s.held === false, s);
}

// paired and held are mutually exclusive by construction — a live pair wins, so
// the worker can never be handed a state it has to arbitrate.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.active.browser = ws('browser');
  room.resumable = { expiresAt: now() + RESUME_WINDOW_MS };
  const s = derivePairState(room);
  check('a live pair outranks a lingering claim (paired, not held)',
    s.paired === true && s.held === false, s);
}

// A phone still in the lobby alongside a dead active one keeps presence true.
{
  const room = mkRoom();
  room.lobby.add(ws('phone'));
  room.active.phone = ws('phone', { readyState: CLOSED });
  const s = derivePairState(room);
  check('a second live lobby phone keeps phonePresent true', s.phonePresent === true, s);
}

// Listeners are browsers in the lobby. They must never count as a pair half —
// if they did, every extension install would paint itself green.
{
  const room = mkRoom();
  room.lobby.add(ws('browser', { listener: true }));
  room.lobby.add(ws('phone'));
  const s = derivePairState(room);
  check('a listener in the lobby is NOT half a pair', s.paired === false, s);
}

// ── PART 2 — the mirror above is only worth something if the real relay ─────
// actually broadcasts at every transition. Assert that against the SOURCE.

console.log('\nPART 2 — server.js really emits it');

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n?/g, '\n');
// Strip comments before matching: a grep-proof that passes on the prose
// DESCRIBING an invariant, rather than on the code implementing it, is a proof
// that fails open the moment someone deletes the comment.
const code = server
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

check('derivePairState exists in server.js', /function derivePairState\s*\(/.test(code));
check('broadcastPairState exists in server.js', /function broadcastPairState\s*\(/.test(code));
check('PAIR_STATE is sent to LISTENERS only, never to lobby browsers',
  /broadcastToListeners\(\s*room\s*,\s*`PAIR_STATE:/.test(code) &&
  !/broadcastToLobbyBrowsers\([^)]*PAIR_STATE/.test(code));

// Backward compatibility, asserted rather than asserted-in-prose: LOBBY_STATUS
// must keep exactly the shape the /app client and the v55 APK already parse.
check('LOBBY_STATUS still carries phonePresent/alreadyActive unchanged',
  /LOBBY_STATUS:\$\{JSON\.stringify\(\{\s*phonePresent:/.test(code));
check('no `paired`/`held` field was smuggled into LOBBY_STATUS',
  !/LOBBY_STATUS:\$\{JSON\.stringify\(\{[^}]*\bpaired\b/.test(code));

// Every transition site. Counting call sites is the cheap, drift-resistant way
// to catch a future edit that adds a new teardown path and forgets to tell the
// listener — the failure mode that produced this dispatch in the first place.
const calls = (code.match(/broadcastPairState\(room\)/g) || []).length;
check(`broadcastPairState is called at every transition (found ${calls}, need >= 6)`,
  calls >= 6, calls);

// The specific one that caused the bug: a joining listener must be told the
// truth immediately, not left to infer it from LOBBY_STATUS.
check('a joining listener is sent PAIR_STATE',
  /if\s*\(\s*ws\.listener\s*\)\s*broadcastPairState\(room\)/.test(code));

// And the specific one that keeps a panel close honest.
check('the soft-hold early return broadcasts before returning',
  /broadcastPairState\(room\);\s*return;/.test(code));

// ── PART 3 — the worker's mapping rule, asserted against background.js ──────
//
// The live behavioural proof runs in scripts/ext-badge-counter-proof.mjs
// (section 11) against the real worker in a real Chromium. These are the two
// invariants cheap enough to guard on every run.

console.log('\nPART 3 — the worker maps it correctly');

const bg = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8').replace(/\r\n?/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

check('the worker consumes PAIR_STATE', /type === 'PAIR_STATE'/.test(bg));
// THE regression guard. If green is ever again reachable from presence alone,
// this fails.
check('green requires `paired` — never phonePresent alone',
  /if\s*\(\s*paired\s*\)\s*return applyIndicator\('connected'\)/.test(bg) &&
  !/phonePresent\s*\)\s*return applyIndicator\('connected'\)/.test(bg) &&
  !/wsOpen && phonePresent\) return applyIndicator\('connected'\)/.test(bg));
check('the traffic catch-all no longer implies a pair',
  !/notePhonePresence\(true\);?\s*paired\s*=/.test(bg) &&
  /notePhonePresence\(true\)/.test(bg));


// ── PART 4 — the sealed twin: the derivation is MODE-BLIND ──────────────────
//
// E2E-P6 (a). §13.7 keeps the frame TYPE and replaces only the BODY, so nothing
// the relay does to derive PAIR_STATE can depend on whether a session is open.
// This part runs the SAME scenario twice — plaintext bodies, then sealed bodies
// — over the SAME mirror functions declared above, and requires the observable
// result to be identical.
//
// SCOPE, stated so it cannot be overclaimed: this twins the MIRROR. It proves
// the modelled state machine has no body-dependent branch. It is not evidence
// about the shipped relay; P6 (g) is. See tests/lib/sealed-twin.mjs's header.

import { twin, transcript, openBody, assertNoPlaintext } from './lib/sealed-twin.mjs';

console.log('\nPART 4 — sealed twin (mode-blind derivation)');

// Long enough that assertNoPlaintext's minLen floor cannot skip it, and
// distinctive enough that a chance base64 collision is not credible.
const CANARY = 'CANARY-PAIRSTATE-b0f3c1a97e4d-must-never-reach-a-listener';
const LISTENER_DEVICE_ID = 'dev-listener-p6';

/**
 * Mirror of server.js derivePairState(room, forWs) INCLUDING the P1(c)/A3-M1
 * splice. The three truth fields come from the PART 1 mirror unchanged — that
 * shared call is the point: if the splice ever starts influencing them, this
 * function and the one above stop agreeing and PART 4 goes red.
 */
function derivePairStateForWs(room, forWs = null) {
  const state = derivePairState(room);
  const block = state.paired ? (room.active.e2e ?? null) : null;
  if (block && forWs && forWs.deviceId) {
    const mine = (block.wraps || []).find((w) => w.deviceId === forWs.deviceId);
    if (mine) {
      state.e2e = {
        kid: block.kid, epk: block.epk, mode: block.mode,
        recipKeys: block.recipKeys, wrap: mine.wrap, ctx: block.ctx,
      };
    }
  }
  return state;
}

/** Mirror of server.js broadcastPairState's per-listener splice. */
function broadcastPairStateTo(room, listeners) {
  const base = `PAIR_STATE:${JSON.stringify(derivePairStateForWs(room))}`;
  for (const l of listeners) {
    const msg = l.deviceId
      ? `PAIR_STATE:${JSON.stringify(derivePairStateForWs(room, l))}`
      : base;
    if (l.readyState === OPEN) l.sent.push(msg);
  }
}

/** transcript() minus chosen keys, so an ADDITIVE difference can be pinned separately. */
const stripKeys = (t, keys) => JSON.stringify(t.map((x) => {
  const o = { ...x };
  for (const k of keys) delete o[k];
  return o;
}));

/**
 * transcript() deliberately keeps only relay-owned fields, and PAIR_STATE's
 * three truth fields are not on that list — so a bare transcript comparison of a
 * listener would be an assertion that cannot fail. Re-attach them here, which is
 * exactly what makes P4.2 a detector rather than a decoration.
 */
const pairTranscript = (sent) => transcript(sent).map((x, i) => {
  const raw = sent[i];
  const p = raw.startsWith('PAIR_STATE:') ? JSON.parse(raw.slice('PAIR_STATE:'.length)) : {};
  return { ...x, phonePresent: p.phonePresent, paired: p.paired, held: p.held };
});

const scn = twin((mode) => {
  const room = mkRoom();
  const phone = ws('phone');
  const browser = ws('browser');
  room.active.phone = phone;
  room.active.browser = browser;

  const listener = ws('browser', { listener: true });
  listener.deviceId = LISTENER_DEVICE_ID;
  room.lobby.add(listener);

  // Mode ON: the SW wrap rides on room.active.e2e exactly as ACCEPT_PAIRING
  // stashes it. Mode OFF: no block at all — the A4.1 / §13.10 plaintext room.
  const block = mode.block();
  if (block) {
    room.active.e2e = {
      ...block,
      recipKeys: [{ deviceId: LISTENER_DEVICE_ID, k: 'cmVjaXAta2V5LW9wYXF1ZQ' }],
      wraps: [{ deviceId: LISTENER_DEVICE_ID, wrap: 'd3JhcHBlZC1zZXNzaW9uLWtleQ' }],
      ctx: {
        pairingId: 'p6-pair-0001', phoneDeviceId: 'dev-phone-p6',
        peerDeviceId: LISTENER_DEVICE_ID, pairEpoch: '7',
      },
    };
  }

  broadcastPairStateTo(room, [listener]);

  // A data-plane frame rides through the live pair. forwardDataPlane copies the
  // wire bytes verbatim — it never parses the body — so the same array push
  // models both arms.
  const body = mode.body('PHONE_NOTIFICATION', { title: CANARY, text: `${CANARY}-body` });
  browser.sent.push(`PHONE_NOTIFICATION:${JSON.stringify(body)}`);

  return { room, phone, browser, listener, body };
});

// (1) Transcript equality — the data plane carries no e2e block at all, so the
//     two arms must agree on every field transcript() keeps.
{
  const r = scn.agrees((o) => o.browser.sent);
  check('P4.1 browser transcript is identical plaintext vs sealed', r.equal, r);
}
// …and the listener's, once the deliberately-ADDITIVE e2e key is set aside.
{
  const a = stripKeys(pairTranscript(scn.plain.listener.sent), ['sealed', 'hasE2eBlock']);
  const b = stripKeys(pairTranscript(scn.sealed.listener.sent), ['sealed', 'hasE2eBlock']);
  check('P4.2 listener transcript is identical once the additive e2e key is set aside',
    a === b, { a, b });
  // Pinned, not hidden: that additive difference is the ONLY one, and it is
  // present exactly when mode is ON.
  check('P4.3 the e2e block rides only on the sealed arm',
    transcript(scn.plain.listener.sent)[0].hasE2eBlock === false &&
    transcript(scn.sealed.listener.sent)[0].hasE2eBlock === true,
    [transcript(scn.plain.listener.sent)[0], transcript(scn.sealed.listener.sent)[0]]);
}

// (2) (i) The derivation itself is identical WITH and WITHOUT the SW wrap.
{
  const pick = (o) => JSON.parse(o.listener.sent[0].slice('PAIR_STATE:'.length));
  const p = pick(scn.plain), s = pick(scn.sealed);
  check('P4.4 the three truth fields are byte-identical with and without the wrap',
    p.phonePresent === s.phonePresent && p.paired === s.paired && p.held === s.held &&
    JSON.stringify([p.phonePresent, p.paired, p.held]) === JSON.stringify([true, true, false]),
    { p, s });
  check('P4.5 the wrap is SINGULAR and the listener\'s own',
    s.e2e.wrap === 'd3JhcHBlZC1zZXNzaW9uLWtleQ' && s.e2e.wraps === undefined, s.e2e);
  check('P4.6 the A3-M1 ctx is spliced through verbatim',
    JSON.stringify(s.e2e.ctx) === JSON.stringify({
      pairingId: 'p6-pair-0001', phoneDeviceId: 'dev-phone-p6',
      peerDeviceId: LISTENER_DEVICE_ID, pairEpoch: '7',
    }), s.e2e.ctx);
}

// (3) Verbatim passthrough — the envelope out is the envelope in, to the byte,
//     and it still opens. Half the point of a twin: a relay that "helpfully"
//     re-serialised a body would break authentication, silently.
{
  const wire = scn.sealed.browser.sent[0];
  const out = JSON.parse(wire.slice('PHONE_NOTIFICATION:'.length));
  check('P4.7 the envelope out equals the envelope in',
    JSON.stringify(out) === JSON.stringify(scn.sealed.body), { out, sent: scn.sealed.body });
  let opened = null;
  try { opened = openBody(scn.session, 'PHONE_NOTIFICATION', out); } catch (e) { opened = { err: String(e) }; }
  check('P4.8 the forwarded envelope still opens after the relay handled it',
    opened && opened.title === CANARY && opened.text === `${CANARY}-body`, opened);
}

// (4) No plaintext leak anywhere the relay can reach: the listener's frames, the
//     browser's frames, the stashed e2e block, the lobby.
{
  const hay = JSON.stringify({
    listener: scn.sealed.listener.sent,
    browser: scn.sealed.browser.sent,
    e2e: scn.sealed.room.active.e2e,
    lobby: [...scn.sealed.room.lobby].map((s) => s.sent),
  });
  const res = assertNoPlaintext(hay, { title: CANARY, text: `${CANARY}-body` });
  check('P4.9 no fragment of the sealed body survives in relay-reachable state', res.clean, res.leaked);
  // The control arm. Without it, a broken assertNoPlaintext would pass P4.9 by
  // never finding anything at all.
  const ctrl = assertNoPlaintext(JSON.stringify({ browser: scn.plain.browser.sent }), { title: CANARY });
  check('P4.10 …and the PLAINTEXT arm genuinely does leak it (the detector works)',
    ctrl.clean === false && ctrl.leaked.includes(CANARY), ctrl);
}

// (5) (ii) A4.1 / §13.10 — a PAIR_STATE with NO e2e block is tolerated and
//     degrades to counts-only. Never to a plaintext preview.
{
  const room = mkRoom();
  room.active.phone = ws('phone');
  room.active.browser = ws('browser');
  const l = ws('browser', { listener: true });
  l.deviceId = LISTENER_DEVICE_ID;            // declared, but no block exists
  broadcastPairStateTo(room, [l]);
  const state = JSON.parse(l.sent[0].slice('PAIR_STATE:'.length));
  check('P4.11 a block-less PAIR_STATE is tolerated (still emitted, still paired)',
    l.sent.length === 1 && state.paired === true, state);
  check('P4.12 …and carries EXACTLY the three counts-only fields',
    JSON.stringify(Object.keys(state).sort()) === JSON.stringify(['held', 'paired', 'phonePresent']),
    Object.keys(state));
  // The degradation that must never happen: a body preview smuggled in as a
  // consolation prize for the listener that could not get keys.
  for (const forbidden of ['title', 'text', 'body', 'preview', 'sender', 'message']) {
    check(`P4.13 no \`${forbidden}\` preview field on a block-less PAIR_STATE`, state[forbidden] === undefined);
  }
  // A listener that declared NO deviceId gets the base frame — same three fields.
  const l2 = ws('browser', { listener: true });
  broadcastPairStateTo(room, [l2]);
  check('P4.14 a deviceId-less listener gets the identical counts-only frame',
    l2.sent[0] === l.sent[0], [l.sent[0], l2.sent[0]]);
}

// (6) Mode does not change the DECISION. Same room, same transitions, one with a
//     block stashed and one without: the truth fields must move identically.
{
  const run = (withBlock) => {
    const room = mkRoom();
    const phone = ws('phone');
    const browser = ws('browser');
    room.active.phone = phone; room.active.browser = browser;
    if (withBlock) room.active.e2e = { kid: 'kid-p6-0001', epk: 'x', mode: 1, recipKeys: [], wraps: [], ctx: {} };
    const seen = [];
    const snap = () => { const s = derivePairStateForWs(room); seen.push([s.phonePresent, s.paired, s.held]); };
    snap();                                                            // paired
    browser.readyState = CLOSED; snap();                               // browser died
    room.active.browser = null;
    room.resumable = { expiresAt: now() + RESUME_WINDOW_MS }; snap();   // held
    room.resumable = { expiresAt: now() - 1 }; snap();                  // claim expired
    room.active.phone = ws('phone', { readyState: CLOSED }); snap();    // gone
    return JSON.stringify(seen);
  };
  const withBlock = run(true), without = run(false);
  check('P4.15 the full transition sequence is identical with and without a session',
    withBlock === without, { withBlock, without });
  check('P4.16 …and it is not a constant (the sequence really moves)',
    new Set(JSON.parse(without).map((x) => JSON.stringify(x))).size >= 4, without);
}

// (7) (iii) PART 3's worker mapping rule is unchanged by mode. `bg` is the
//     already-comment-stripped background.js read in PART 3.
{
  check('P4.17 the worker never gates its green dot on an e2e block',
    !/e2e[^\n]{0,60}\)\s*return applyIndicator\('connected'\)/.test(bg) &&
    !/applyIndicator\('connected'\)[^\n]*e2e/.test(bg));
  check('P4.18 the worker still requires `paired` (PART 3\'s rule, re-asserted under mode)',
    /if\s*\(\s*paired\s*\)\s*return applyIndicator\('connected'\)/.test(bg));
}

// (8) PART 2's style, extended to the e2e path: assert against the REAL source
//     that the splice exists and that the three truth fields do not read it.
{
  check('P4.19 server.js derivePairState takes a per-listener socket',
    /function derivePairState\s*\(\s*room\s*,\s*forWs\s*=\s*null\s*\)/.test(code));
  check('P4.20 server.js splices the A3-M1 ctx into the listener slice',
    /state\.e2e\s*=\s*\{[\s\S]{0,600}?\bctx:\s*block\.ctx/.test(code));
  check('P4.21 server.js hands the listener a SINGULAR wrap, never wraps[]',
    /wrap:\s*mine\.wrap/.test(code) && !/state\.e2e\s*=\s*\{[\s\S]{0,600}?wraps:\s*block\.wraps/.test(code));
  check('P4.22 the splice is gated on `paired`, so an unpaired room never emits keys',
    /const block = paired \? room\.active\.e2e : null/.test(code));
  // THE mode-blindness claim, asserted against the source: the three truth
  // fields are computed BEFORE the block is even looked up. If a future edit
  // moves an e2e read above them, this goes red.
  check('P4.23 the three truth fields are computed before any e2e read', (() => {
    const fn = code.slice(code.indexOf('function derivePairState'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    const held = body.indexOf('held:');
    const firstE2e = body.indexOf('room.active.e2e');
    return held !== -1 && firstE2e !== -1 && held < firstE2e;
  })());
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
