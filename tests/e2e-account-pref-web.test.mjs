#!/usr/bin/env node
/**
 * tests/e2e-account-pref-web.test.mjs — T-E2E-ACCOUNT-PREF step 3, the web +
 * extension client of the per-account Encrypted-mode setting.
 *
 * Drives the REAL lib/e2eAccountPref-core.ts (pure) plus source pins over the
 * binders that cannot be imported into node (React hooks, the MV3 worker).
 * The brief names three things the unit layer must prove; each has its own
 * section and a CONTROL that must be able to go red:
 *
 *   (1) mirror keying + wipe (Security M1): keyed by userId, not email; the
 *       sign-out wipe takes this account's mirror, rev and legacy switch and
 *       nothing else; the sign-in sweep removes every other account's mirror;
 *       account B never inherits A's rev or mode.
 *   (2) rev drop: rev < last dropped, rev == last dropped EXCEPT the two
 *       master-switch fields (a boot-time flag flip does not bump rev), rev >
 *       last applied.
 *   (3) seed once (DESIGN §7): only null-server + local ON seeds; local OFF
 *       never seeds; the legacy switch is retired after a server answer and
 *       kept after a transport failure.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIRROR_PREFIX,
  mirrorKey,
  legacyModeKey,
  parseResolved,
  readMirror,
  writeMirror,
  readLegacyMode,
  wipeAccountPrefStorage,
  sweepOtherMirrors,
  applyIncoming,
  advertisedMode,
  serverNeverChose,
  shouldSeed,
  legacyConsumed,
  legacyRetiredWithoutSeed,
  classifyWriteResponse,
  CONFIRM_TITLE,
  CONFIRM_BODY,
  CONFIRM_ACTION,
  STATE_LABEL_PAUSED,
  RATE_LIMITED_COPY,
  COULD_NOT_APPLY_COPY,
  stateLabel,
  reconnectingCopy,
  changedFromLine,
  remoteNoticeCopy,
  formatChangeTime,
} from '../lib/e2eAccountPref-core.ts';
import { encryptedModeKey } from '../hooks/phoneE2e.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** A Storage with key()/length, and a switch to make every call throw. */
function memStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  let hostile = false;
  const guard = () => { if (hostile) throw new Error('SecurityError'); };
  return {
    map: m,
    hostile(v = true) { hostile = v; },
    getItem(k) { guard(); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { guard(); m.set(k, String(v)); },
    removeItem(k) { guard(); m.delete(k); },
    key(i) { guard(); return [...m.keys()][i] ?? null; },
    get length() { guard(); return m.size; },
  };
}

const R = (o = {}) => ({
  preference: 'off', effective: 'off', pausedByServer: false, rev: 0, updatedAt: null, updatedBy: null, ...o,
});
const ON = (rev, by = 'web', at = '2026-09-25T12:00:00.000Z') =>
  R({ preference: 'on', effective: 'on', rev, updatedBy: by, updatedAt: at });
const OFF = (rev, by = 'web', at = '2026-09-25T12:00:00.000Z') =>
  R({ preference: 'off', effective: 'off', rev, updatedBy: by, updatedAt: at });
const PAUSED = (rev, by = 'web') =>
  R({ preference: 'on', effective: 'off', pausedByServer: true, rev, updatedBy: by, updatedAt: '2026-09-25T12:00:00.000Z' });
const M = (resolved, notice = null) => ({ resolved, notice });

// ───────────────────────────────────────────────────────────────────────────
// (1) mirror keying + wipe — Security M1
// ───────────────────────────────────────────────────────────────────────────
{
  eq('M1: mirror key is per userId', mirrorKey('u_A'), 'cc:e2e:acct:u_A');
  check('M1: two accounts, two keys', mirrorKey('u_A') !== mirrorKey('u_B'));
  eq('legacy key format matches the P2 switch it migrates', legacyModeKey('A@B.com'), encryptedModeKey('A@B.com'));
  check('M1: mirror prefix is disjoint from every legacy (email) key — no "@" in it',
    !MIRROR_PREFIX.includes('@') && legacyModeKey('x@y.z').includes('@'));

  const s = memStore();
  writeMirror(s, 'u_A', M(ON(9)));
  eq('M1: A reads back its own mirror', readMirror(s, 'u_A')?.resolved.rev, 9);
  eq('M1: B does NOT read A\'s mirror', readMirror(s, 'u_B'), null);
  eq('M1: no userId, no mirror', readMirror(s, null), null);
  eq('M1: advertised for B with nothing stored is the §6 default OFF', advertisedMode(readMirror(s, 'u_B')), 'off');

  // Account switch A -> B: A's rev 9 must not make B's first push (rev 1) stale.
  const bFirst = applyIncoming({ current: readMirror(s, 'u_B'), incoming: ON(1, 'phone'), source: 'push', pendingOwnWrite: null });
  check('M1: B\'s first push at rev 1 is APPLIED although A sits at rev 9', bFirst.applied === true);
  check('M1: B\'s first value raises no notice (there is no "before" for B)', bFirst.applied && bFirst.noticeRaised === false);
  // CONTROL: a device-global rev (the pre-M1 shape) WOULD drop it.
  const globalRev = applyIncoming({ current: readMirror(s, 'u_A'), incoming: ON(1, 'phone'), source: 'push', pendingOwnWrite: null });
  check('CONTROL M1: under a shared (A\'s) rev, B\'s push would have been dropped as stale',
    globalRev.applied === false && globalRev.reason === 'stale');

  // Sign-out wipe.
  const w = memStore({
    'cc:e2e:a@b.com': 'on',
    'cc:e2e:c@d.com': 'on',
    'cc:e2e-other-thing': 'keep',
    'unrelated': 'keep',
  });
  writeMirror(w, 'u_A', M(ON(3)));
  writeMirror(w, 'u_C', M(OFF(4)));
  wipeAccountPrefStorage(w, 'u_A', 'A@b.com');
  eq('wipe: A\'s mirror (and its rev) is gone', w.getItem(mirrorKey('u_A')), null);
  eq('wipe: A\'s legacy switch is gone (email case-folded)', w.getItem('cc:e2e:a@b.com'), null);
  check('wipe: C\'s mirror untouched', w.getItem(mirrorKey('u_C')) !== null);
  eq('wipe: C\'s legacy untouched', w.getItem('cc:e2e:c@d.com'), 'on');
  eq('wipe: unrelated keys untouched', [w.getItem('cc:e2e-other-thing'), w.getItem('unrelated')], ['keep', 'keep']);
  w.hostile();
  check('wipe: a throwing store does not throw',
    (() => { try { wipeAccountPrefStorage(w, 'u_C', 'c@d.com'); return true; } catch { return false; } })());
  w.hostile(false);
  wipeAccountPrefStorage(null, 'u_C', 'c@d.com');
  check('wipe: a null store is a no-op', w.getItem(mirrorKey('u_C')) !== null);

  // Sign-in sweep.
  const sw = memStore({ 'cc:e2e:a@b.com': 'on', 'other': '1' });
  writeMirror(sw, 'u_A', M(ON(3)));
  writeMirror(sw, 'u_B', M(OFF(2)));
  writeMirror(sw, 'u_C', M(ON(8)));
  eq('sweep: removes the two OTHER mirrors', sweepOtherMirrors(sw, 'u_B'), 2);
  check('sweep: keeps the signed-in account\'s mirror', readMirror(sw, 'u_B') !== null);
  check('sweep: A and C are gone', readMirror(sw, 'u_A') === null && readMirror(sw, 'u_C') === null);
  eq('sweep: never touches non-mirror keys', [sw.getItem('cc:e2e:a@b.com'), sw.getItem('other')], ['on', '1']);
  sw.hostile();
  eq('sweep: a throwing store removes nothing and does not throw', sweepOtherMirrors(sw, 'u_B'), 0);

  // Garbage in storage never paints anything.
  const g = memStore({ [mirrorKey('u_A')]: '{not json' });
  eq('mirror: garbage JSON reads as no mirror', readMirror(g, 'u_A'), null);
  g.setItem(mirrorKey('u_A'), JSON.stringify({ resolved: { preference: 'maybe' } }));
  eq('mirror: a malformed resolved reads as no mirror', readMirror(g, 'u_A'), null);
  g.setItem(mirrorKey('u_A'), JSON.stringify({ resolved: ON(2), notice: { value: 'x' } }));
  eq('mirror: a malformed notice is dropped, the value kept', readMirror(g, 'u_A')?.notice, null);
}

// ───────────────────────────────────────────────────────────────────────────
// (2) rev drop
// ───────────────────────────────────────────────────────────────────────────
{
  const cur = M(ON(5, 'web'));
  const stale = applyIncoming({ current: cur, incoming: OFF(4, 'phone'), source: 'push', pendingOwnWrite: null });
  eq('rev: a push with rev < last is dropped (stale)', [stale.applied, stale.reason], [false, 'stale']);
  const dup = applyIncoming({ current: cur, incoming: ON(5, 'web'), source: 'push', pendingOwnWrite: null });
  eq('rev: the same rev with the same value is dropped (duplicate)', [dup.applied, dup.reason], [false, 'duplicate']);
  const staleGet = applyIncoming({ current: cur, incoming: OFF(3), source: 'get', pendingOwnWrite: null });
  check('rev: a GET answer obeys the same drop', staleGet.applied === false);

  // Equal rev may NOT move the preference or its author.
  const forged = applyIncoming({ current: cur, incoming: OFF(5, 'phone'), source: 'push', pendingOwnWrite: null });
  eq('rev: an equal-rev push that flips the PREFERENCE is dropped outright (not even the master fields)',
    [forged.applied, forged.reason], [false, 'duplicate']);

  // Equal rev, master switch flipped 0 -> 1 at relay boot: paused -> on.
  const pausedCur = M(PAUSED(7));
  const flip = applyIncoming({ current: pausedCur, incoming: ON(7), source: 'push', pendingOwnWrite: null });
  check('rev: master 0->1 at the SAME rev is applied (masterOnly)', flip.applied && flip.masterOnly === true);
  eq('rev: ... and the account now advertises ON', flip.applied ? advertisedMode(flip.mirror) : null, 'on');
  eq('rev: ... and is no longer paused', flip.applied ? flip.mirror.resolved.pausedByServer : null, false);
  check('rev: a master flip raises no notice', flip.applied && flip.noticeRaised === false);
  // And 1 -> 0.
  const unflip = applyIncoming({ current: M(ON(7)), incoming: PAUSED(7), source: 'push', pendingOwnWrite: null });
  eq('rev: master 1->0 at the same rev -> paused, advertising OFF',
    unflip.applied ? [unflip.mirror.resolved.pausedByServer, advertisedMode(unflip.mirror)] : null, [true, 'off']);
  // CONTROL: the brief's literal "drop rev <= lastRev" would pin the paused state.
  check('CONTROL rev: the master flip is a real equal-rev case (strict <= would drop it)',
    flip.applied && 7 <= pausedCur.resolved.rev);

  const newer = applyIncoming({ current: cur, incoming: OFF(6, 'phone'), source: 'push', pendingOwnWrite: null });
  check('rev: rev > last is applied', newer.applied && newer.mirror.resolved.rev === 6);
  eq('rev: ... and the advertised mode follows it', newer.applied ? advertisedMode(newer.mirror) : null, 'off');

  // Out-of-order delivery: 8 then 7.
  let m = cur;
  for (const inc of [ON(8, 'phone'), OFF(7, 'ext')]) {
    const r = applyIncoming({ current: m, incoming: inc, source: 'push', pendingOwnWrite: null });
    if (r.applied) m = r.mirror;
  }
  eq('rev: 8 then 7 ends at 8', m.resolved.rev, 8);
}

// ───────────────────────────────────────────────────────────────────────────
// notice — shown once, both directions, never for our own write or the seed
// ───────────────────────────────────────────────────────────────────────────
{
  const cur = M(OFF(2, 'web'));
  const remoteOn = applyIncoming({ current: cur, incoming: ON(3, 'phone'), source: 'push', pendingOwnWrite: null });
  check('notice: remote OFF->ON raises', remoteOn.applied && remoteOn.noticeRaised);
  eq('notice: carries value/author/rev', remoteOn.applied ? remoteOn.mirror.notice : null,
    { value: 'on', updatedBy: 'phone', updatedAt: '2026-09-25T12:00:00.000Z', rev: 3 });
  const remoteOff = applyIncoming({ current: M(ON(3)), incoming: OFF(4, 'ext'), source: 'push', pendingOwnWrite: null });
  check('notice: remote ON->OFF raises (both directions)', remoteOff.applied && remoteOff.noticeRaised);

  const own = applyIncoming({ current: cur, incoming: ON(3, 'web'), source: 'own-write', pendingOwnWrite: 'on' });
  check('notice: our own write\'s answer raises nothing', own.applied && !own.noticeRaised);
  const early = applyIncoming({ current: cur, incoming: ON(3, 'web'), source: 'push', pendingOwnWrite: 'on' });
  check('notice: the push of our own write that beats the PUT answer raises nothing', early.applied && !early.noticeRaised);
  const forgedBy = applyIncoming({ current: cur, incoming: ON(3, 'web'), source: 'push', pendingOwnWrite: null });
  check('notice: updatedBy "web" from the server is NOT taken as "ours" (local knowledge only)',
    forgedBy.applied && forgedBy.noticeRaised);
  const seed = applyIncoming({ current: cur, incoming: ON(3, 'seed'), source: 'push', pendingOwnWrite: null });
  check('notice: the silent seed raises nothing (§7)', seed.applied && !seed.noticeRaised);
  const same = applyIncoming({ current: cur, incoming: OFF(3, 'phone'), source: 'push', pendingOwnWrite: null });
  check('notice: a newer rev with the SAME preference raises nothing', same.applied && !same.noticeRaised);

  const withNotice = M(ON(3, 'phone'), { value: 'on', updatedBy: 'phone', updatedAt: null, rev: 3 });
  const unrelated = applyIncoming({ current: withNotice, incoming: ON(4, 'phone'), source: 'push', pendingOwnWrite: null });
  check('notice: persists across an unrelated newer push until dismissed', unrelated.applied && unrelated.mirror.notice?.rev === 3);
  const mine = applyIncoming({ current: withNotice, incoming: OFF(4, 'web'), source: 'own-write', pendingOwnWrite: 'off' });
  check('notice: our own change clears an older one', mine.applied && mine.mirror.notice === null);
}

// ───────────────────────────────────────────────────────────────────────────
// (3) seed once — DESIGN §7
// ───────────────────────────────────────────────────────────────────────────
{
  const never = R();
  check('seed: rev 0 + no author = never chose', serverNeverChose(never));
  check('seed: a seeded row (rev 1, seed) has chosen', !serverNeverChose(ON(1, 'seed')));
  check('seed: default-resolved OFF at rev 0 with an author is not "never"', !serverNeverChose(OFF(0, 'web')));

  eq('seed: never chose + local ON -> seed', shouldSeed(never, 'on'), true);
  eq('seed: never chose + local OFF -> NO seed', shouldSeed(never, 'off'), false);
  eq('seed: never chose + no local -> no seed', shouldSeed(never, null), false);
  eq('seed: already chose OFF + local ON -> no seed (server wins once set)', shouldSeed(OFF(2, 'phone'), 'on'), false);
  eq('seed: already chose ON + local ON -> no seed', shouldSeed(ON(2), 'on'), false);

  eq('seed: local OFF is retired without a write', legacyRetiredWithoutSeed(never, 'off'), true);
  eq('seed: local ON on a chosen account is retired without a write', legacyRetiredWithoutSeed(OFF(2), 'on'), true);
  eq('seed: local ON on a never-chose account is NOT retired before the seed', legacyRetiredWithoutSeed(never, 'on'), false);
  eq('seed: nothing stored, nothing to retire', legacyRetiredWithoutSeed(never, null), false);

  eq('seed: legacy consumed after a 200 (applied)', legacyConsumed(classifyWriteResponse(200, { applied: true, changed: true, resolved: ON(1, 'seed'), reset: null })), true);
  eq('seed: legacy consumed after a 200 (CAS lost — account chose meanwhile)', legacyConsumed(classifyWriteResponse(200, { applied: false, changed: false, resolved: OFF(3), reset: null })), true);
  eq('seed: legacy KEPT after 429 (retry next load)', legacyConsumed(classifyWriteResponse(429, {})), false);
  eq('seed: legacy KEPT after 503', legacyConsumed(classifyWriteResponse(503, {})), false);
  eq('seed: legacy KEPT after a transport failure', legacyConsumed(classifyWriteResponse(0, null)), false);

  const ls = memStore({ 'cc:e2e:a@b.com': 'on', 'cc:e2e:c@d.com': 'yes-please' });
  eq('seed: legacy ON reads on', readLegacyMode(ls, 'A@B.com'), 'on');
  eq('seed: a garbage legacy value is OFF, never ON', readLegacyMode(ls, 'c@d.com'), 'off');
  eq('seed: absent legacy is null', readLegacyMode(ls, 'x@y.z'), null);
  // CONTROL: the predicate can say yes, so the "no seed" rows above are not a constant.
  check('CONTROL seed: shouldSeed is not constant-false', shouldSeed(never, 'on') && !shouldSeed(never, 'off'));
}

// ───────────────────────────────────────────────────────────────────────────
// advertised mode, parsing, write outcomes
// ───────────────────────────────────────────────────────────────────────────
{
  eq('advertise: no mirror -> off', advertisedMode(null), 'off');
  eq('advertise: on -> on', advertisedMode(M(ON(1))), 'on');
  eq('advertise: paused (pref on, master off) -> off, the effective value', advertisedMode(M(PAUSED(1))), 'off');
  eq('advertise: off -> off', advertisedMode(M(OFF(1))), 'off');

  eq('parse: a real frame body parses', parseResolved(ON(4, 'phone')), ON(4, 'phone'));
  eq('parse: null', parseResolved(null), null);
  eq('parse: bad preference', parseResolved({ ...ON(1), preference: 'yes' }), null);
  eq('parse: negative rev', parseResolved({ ...ON(1), rev: -1 }), null);
  eq('parse: fractional rev', parseResolved({ ...ON(1), rev: 1.5 }), null);
  eq('parse: missing pausedByServer', parseResolved({ preference: 'on', effective: 'on', rev: 1 }), null);
  eq('parse: effective ON under preference OFF is impossible (§3) and refused',
    parseResolved({ ...OFF(1), effective: 'on' }), null);
  eq('parse: an oversize updatedBy is nulled, not trusted', parseResolved({ ...ON(1), updatedBy: 'x'.repeat(40) })?.updatedBy, null);

  const ok = classifyWriteResponse(200, { changed: true, resolved: ON(5), reset: { closed: 2, phones: 1, browsers: 1, listeners: 0 } });
  eq('write: 200 changed with a reset', [ok.kind, ok.changed, ok.resetClosed], ['saved', true, 2]);
  const noop = classifyWriteResponse(200, { changed: false, resolved: ON(5), reset: null });
  eq('write: re-confirming the current value = saved, unchanged, nobody closed', [noop.kind, noop.changed, noop.resetClosed], ['saved', false, 0]);
  eq('write: 429 -> rate-limited', classifyWriteResponse(429, { error: 'rate_limited' }).kind, 'rate-limited');
  eq('write: 503 -> failed', classifyWriteResponse(503, { error: 'relay_unavailable' }), { kind: 'failed', status: 503 });
  eq('write: 500 reset:null -> failed', classifyWriteResponse(500, { error: 'reset_failed', reset: null }), { kind: 'failed', status: 500 });
  eq('write: 401 -> failed', classifyWriteResponse(401, {}).kind, 'failed');
  eq('write: transport failure -> failed', classifyWriteResponse(0, null).kind, 'failed');
  eq('write: 200 with no body is not "saved"', classifyWriteResponse(200, null).kind, 'failed');
}

// ───────────────────────────────────────────────────────────────────────────
// copy — DESIGN §8 LOCKED strings + the brief's
// ───────────────────────────────────────────────────────────────────────────
{
  eq('copy: ON title', CONFIRM_TITLE.on, 'Turn on Encrypted mode?');
  eq('copy: ON body', CONFIRM_BODY.on, 'Your phone and computer will disconnect. Connect again and check the code on both screens.');
  eq('copy: OFF title', CONFIRM_TITLE.off, 'Turn off Encrypted mode?');
  eq('copy: OFF body', CONFIRM_BODY.off, 'Your phone and computer will disconnect. Next time you connect there is no code check.');
  eq('copy: actions', [CONFIRM_ACTION.on, CONFIRM_ACTION.off], ['Turn on', 'Turn off']);
  eq('copy: 429', RATE_LIMITED_COPY, 'Too many changes, try again in a minute');
  eq('copy: 503/500', COULD_NOT_APPLY_COPY, 'Could not apply, try again');
  eq('copy: paused', STATE_LABEL_PAUSED, 'On, paused by ComputerCaller');
  eq('copy: paused is never a plain Off', stateLabel(PAUSED(1)), 'On, paused by ComputerCaller');
  eq('copy: on / off', [stateLabel(ON(1)), stateLabel(OFF(1))], ['On', 'Off']);
  check('copy: reconnecting names the mode', reconnectingCopy('on').startsWith('Reconnecting in Encrypted mode')
    && reconnectingCopy('off').startsWith('Reconnecting'));

  const now = new Date('2026-09-25T15:00:00.000Z');
  eq('copy: same-day time', formatChangeTime('2026-09-25T12:32:00.000Z', now, 'en-GB', 'UTC'), '12:32');
  eq('copy: other-day time', formatChangeTime('2026-09-24T12:32:00.000Z', now, 'en-GB', 'UTC'), '24 Sept, 12:32');
  eq('copy: bad time is null', formatChangeTime('nope', now), null);
  eq('copy: changed-from line', changedFromLine(ON(3, 'phone', '2026-09-25T12:32:00.000Z'), now, 'en-GB', 'UTC'),
    'Changed from your phone at 12:32');
  eq('copy: changed-from, extension', changedFromLine(OFF(3, 'ext', '2026-09-25T12:32:00.000Z'), now, 'en-GB', 'UTC'),
    'Changed from the Chrome extension at 12:32');
  eq('copy: never-chose has no changed-from line', changedFromLine(R(), now), null);
  eq('copy: remote notice (§8)', remoteNoticeCopy({ value: 'off', updatedBy: 'phone', updatedAt: '2026-09-25T12:32:00.000Z', rev: 4 }, now, 'en-GB', 'UTC'),
    'Encrypted mode was turned off from your phone at 12:32');
  eq('copy: remote notice, website ON', remoteNoticeCopy({ value: 'on', updatedBy: 'web', updatedAt: '2026-09-25T12:32:00.000Z', rev: 4 }, now, 'en-GB', 'UTC'),
    'Encrypted mode was turned on from the website at 12:32');
}

// ───────────────────────────────────────────────────────────────────────────
// source pins — the binders node cannot import
// ───────────────────────────────────────────────────────────────────────────
{
  const bridge = read('hooks/usePhoneBridge.ts');
  check('pin: usePhoneBridge routes E2E_PREF to the store',
    /case 'E2E_PREF': \{\s*applyE2ePrefPush\(payload\);/.test(bridge));
  check('pin: E2E_PREF_REFUSED is NOT handled on the web (phone-only frame)', !/case 'E2E_PREF_REFUSED'/.test(bridge));
  check('pin: the 4010 close notes the room reset for "Reconnecting…"',
    /code === RESET_CLOSE_CODE \|\| reason === 'room_reset'\) \{[\s\S]{0,400}?noteRelayRoomReset\(\);/.test(bridge));
  check('pin: no setter for the advertised mode is exported', !/setE2eLocalMode/.test(bridge));

  const useE2e = read('hooks/useE2e.ts');
  check('pin: useE2e advertises the ACCOUNT value', /const localMode: LocalMode = advertisedMode\(accountPref\.mirror\);/.test(useE2e));
  check('pin: useE2e no longer reads or writes the email-keyed switch',
    !/readEncryptedMode|writeEncryptedMode/.test(useE2e));
  check('pin: the pairing block is still built from localMode (OR rule untouched)',
    /buildRequestBlock\(\{ localMode, webKey: key, sw: swRef\.current \}\)/.test(useE2e));
  const onSignOut = useE2e.slice(useE2e.indexOf('const onSignOut = useCallback'));
  check('pin: web sign-out (onSignOut) wipes the account mirror',
    /wipeAccountPrefOnSignOut\(\);/.test(onSignOut.slice(0, onSignOut.indexOf('}, []);') + 10)));

  const header = read('components/PhoneModeHeader.tsx');
  check('pin: extension menu sign-out wipes BEFORE handing to the shell',
    /wipeAccountPrefOnSignOut\(\);\s*requestSignOut\(\);/.test(header));
  const providers = read('app/extension/ExtensionProviders.tsx');
  check('pin: extension idle sign-out wipes before handing to the shell',
    /wipeAccountPrefOnSignOut\(\);\s*requestSignOut\(\);/.test(providers));

  const bg = read('chrome-extension/background.js');
  const w = bg.slice(bg.indexOf('async function writeE2ePref'), bg.indexOf('// ── Relay-ticket exchange'));
  check('pin: SW write sends the token in the Authorization header', /Authorization: `Bearer \$\{token\}`/.test(w));
  check('pin: SW write sends NO cookie (credentials omit)', /credentials: 'omit'/.test(w));
  check('pin: SW write never puts the token in a URL', !/\?token|token=/.test(w));
  check('pin: SW refuses the verb from outside this extension', /sender\.id !== chrome\.runtime\.id/.test(bg));

  const shell = read('chrome-extension/shell.js');
  const loginReturn = shell.indexOf("startPasswordWindowSignIn();\n    }\n    return;\n  }");
  const verb = shell.indexOf("data.type === 'e2e-pref-write'");
  check('pin: shell accepts e2e-pref-write ONLY from the app frame (after the login-frame return)',
    loginReturn > 0 && verb > loginReturn);
  check('pin: shell answers with the pinned targetOrigin',
    /type: 'e2e-pref-result', rid[\s\S]{0,120}?self\.CC\.WEBAPP_ORIGIN/.test(shell));

  const toggle = read('components/EncryptedModeToggle.tsx');
  check('pin: a tap opens the confirm, it never writes directly',
    /setConfirming\(mode === 'on' \? 'off' : 'on'\)/.test(toggle) && !/onClick=\{\(\) => requestAccountPrefChange/.test(toggle));
  const dialog = read('components/EncryptedModeConfirmDialog.tsx');
  check('pin: dialog is a modal with a label and description', /role="dialog"/.test(dialog) && /aria-modal="true"/.test(dialog)
    && /aria-labelledby=\{titleId\}/.test(dialog) && /aria-describedby=\{bodyId\}/.test(dialog));
  check('pin: Escape cancels (captured before the menu can see it)',
    /e\.key === 'Escape'[\s\S]{0,120}?onCancel\(\)/.test(dialog) && /addEventListener\('keydown', onKey, true\)/.test(dialog));
  check('pin: dialog traps Tab', /e\.key !== 'Tab'/.test(dialog) && /last\.focus\(\)/.test(dialog) && /first\.focus\(\)/.test(dialog));
}

const total = passed + failed;
console.log(`\ne2e-account-pref-web: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
