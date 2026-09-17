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

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
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

const bg = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8')
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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
