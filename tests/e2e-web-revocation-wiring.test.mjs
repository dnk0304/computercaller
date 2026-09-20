#!/usr/bin/env node
/**
 * tests/e2e-web-revocation-wiring.test.mjs — E2E-P2.3 (d).
 * GATE1 Addendum A5, F1 / MUST M-A5-1 (a): the revoking side tears itself down.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * P2.2 closed F1 on paper. It built `revokeLocalPair`, the sticky
 * `re-pair-needed`, `onSignOut`, and the re-check of (b) — and then shipped a
 * base on which NOTHING called the (a) side. `grep e2eRef.current.` in
 * hooks/usePhoneBridge.ts hit exactly three names, and none of them was
 * revokeLocalPair or onSignOut; `POST /api/devicekeys/revoke` had existed since
 * P1 with no web caller at all. So on the shipped web lane a sign-out left:
 *   - the SK alive in this browser,
 *   - the relay room alive, and
 *   - this browser's DeviceKey row LIVE on the server — which is precisely what
 *     the OTHER side's M-A5-1 (b) re-check reads as "healthy".
 * (b) was live and (a) was dead, and a fix that ships half of F1 is not F1.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS ASSERTABLE ────────────────────────────
 * The ORDER is the deliverable, so the order lives in a PURE function —
 * lib/e2e/signOutEverywhere.ts — and §1-§3 below drive it directly with
 * injected legs and injected faults. That is a real detector, not a pin: it
 * observes the sequence and it observes what happens when a leg throws.
 *
 * §4 drives lib/e2e/revokeWebKey.ts against a fake fetch: the payload is the
 * OWN id and nothing else, the id is resolved by PUBLIC-KEY match rather than
 * by "the web row", a failed lookup is not a pass, and an already-revoked row
 * is a SUCCESS (the route's own idempotency rule).
 *
 * §5 is source pins, and they are labelled as such. hooks/usePhoneBridge.ts and
 * the four .tsx callers cannot be imported into a node suite, so what is pinned
 * there is the one thing a pure test cannot see: that the four `/api/auth/logout`
 * call sites go through the helper at all, and that "Forget this computer" is a
 * different act from "Reset lobby". Every pin is a fact about the file that a
 * regression would have to delete, not a restatement of this file's own prose.
 *
 * Run: node tests/e2e-web-revocation-wiring.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runRevokingTeardown,
  TEARDOWN_STEPS,
} from '../lib/e2e/signOutEverywhere.ts';
import {
  revokeOwnWebDeviceKey,
  resolveOwnWebDeviceKeyId,
  rememberWebDeviceKeyId,
  forgetWebDeviceKeyId,
  peekWebDeviceKeyId,
} from '../lib/e2e/revokeWebKey.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function deep(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/**
 * Read a source file with its line endings NORMALISED.
 *
 * Not cosmetic: this repo is mixed — hooks/usePhoneBridge.ts and the four
 * callers are CRLF, lib/e2e/*.ts is LF — and a pin written with `\n` silently
 * matches nothing in a CRLF file. A pin that cannot fire is a comment.
 */
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** A recording set of teardown legs. `calls` is the observed ORDER. */
function legs(over = {}) {
  const calls = [];
  const deps = {
    revokeLocalPair: async (reason) => { calls.push(`revokeLocalPair:${reason}`); return true; },
    resetRoom: async () => { calls.push('resetRoom'); },
    onSignOut: () => { calls.push('onSignOut'); },
    revokeRemote: async () => { calls.push('revokeRemote'); return { ok: true, id: 'row-1' }; },
    warn: () => {},
    ...over,
  };
  return { deps, calls };
}

// ===========================================================================
console.log('\n§1 — the ORDER of a sign-out teardown (M-A5-1 (a))');
// ===========================================================================
{
  const { deps, calls } = legs();
  const trace = await runRevokingTeardown(deps, { reason: 'sign-out', signOut: true });

  deep('sign-out runs the four legs in the M-A5-1 (a) order',
    calls, ['revokeLocalPair:sign-out', 'resetRoom', 'onSignOut', 'revokeRemote']);
  deep('...and the trace reports the same order', trace.ran, [...TEARDOWN_STEPS]);
  deep('no leg failed on the happy path', trace.failed, []);

  // The one ordering fact the whole deliverable rests on. Stated as an INDEX
  // comparison rather than a whole-array pin so it keeps meaning if a fifth leg
  // is ever added between them.
  check('the LOCAL drop precedes the transport reset',
    calls.indexOf('revokeLocalPair:sign-out') < calls.indexOf('resetRoom'));
  check('the transport reset precedes onSignOut',
    calls.indexOf('resetRoom') < calls.indexOf('onSignOut'));
  check('the REMOTE revoke is last of the teardown',
    calls.indexOf('revokeRemote') === calls.length - 1);

  eq('the reason reaches revokeLocalPair verbatim', calls[0], 'revokeLocalPair:sign-out');
}

// ===========================================================================
console.log('§2 — "Forget this computer" is NOT a sign-out');
// ===========================================================================
{
  const { deps, calls } = legs();
  const trace = await runRevokingTeardown(deps, { reason: 'user-forget', signOut: false });

  deep('forget runs revokeLocalPair -> resetRoom -> revokeRemote',
    calls, ['revokeLocalPair:user-forget', 'resetRoom', 'revokeRemote']);
  check('forget does NOT call onSignOut — the user stays signed in',
    !calls.includes('onSignOut'));
  check('...and the trace does not claim it did', !trace.ran.includes('onSignOut'));
  eq('forget still carries its own reason', calls[0], 'revokeLocalPair:user-forget');
  check('forget STILL revokes the server-side row (brief (c): on (a) AND (b))',
    calls.includes('revokeRemote'));
}

// ===========================================================================
console.log('§3 — nothing blocks the logout (fault injection)');
// ===========================================================================
{
  // The case the brief names by hand: "Failure of resetRoom must NOT block the
  // logout — the SK is already gone locally".
  const { deps, calls } = legs({
    resetRoom: async () => { calls_push_marker(); throw new Error('relay down'); },
  });
  function calls_push_marker() { calls.push('resetRoom:threw'); }

  let threw = false;
  let trace;
  try {
    trace = await runRevokingTeardown(deps, { reason: 'sign-out', signOut: true });
  } catch {
    threw = true;
  }
  check('a throwing resetRoom does NOT reject the teardown', !threw);
  check('...onSignOut still runs after it', calls.includes('onSignOut'));
  check('...the remote revoke still runs after it', calls.includes('revokeRemote'));
  deep('...and the failure is RECORDED, not swallowed silently',
    trace?.failed, ['resetRoom']);

  // Every other leg, one at a time. Each must leave the rest running: the
  // caller's logout fetch is unconditional and this is what makes that safe.
  for (const bad of ['revokeLocalPair', 'onSignOut', 'revokeRemote']) {
    const { deps: d } = legs({
      [bad]: () => { throw new Error(`${bad} exploded`); },
    });
    let rejected = false;
    let t;
    try {
      t = await runRevokingTeardown(d, { reason: 'sign-out', signOut: true });
    } catch { rejected = true; }
    check(`a throwing ${bad} does not reject the teardown`, !rejected);
    check(`...${bad} is recorded as failed`, t?.failed.includes(bad), JSON.stringify(t?.failed));
    check(`...every later leg still ran after ${bad}`,
      t?.ran.length === 4, JSON.stringify(t?.ran));
  }

  // An UNSUCCESSFUL remote revoke (offline, 500, 401) is best-effort by design:
  // recorded, never fatal. This is the "fail-closed locally, best-effort
  // remotely" half of the rule, and it must not read as a pass.
  const { deps: d2 } = legs({
    revokeRemote: async () => ({ ok: false, reason: 'revoke-failed', status: 500 }),
  });
  const t2 = await runRevokingTeardown(d2, { reason: 'sign-out', signOut: true });
  check('a 500 from the revoke route is recorded as a failed leg',
    t2.failed.includes('revokeRemote'));
  eq('...and the result is carried in the trace, not discarded', t2.remote?.status, 500);
  check('...but the local legs still ran first', t2.ran[0] === 'revokeLocalPair');
}

// ===========================================================================
console.log('§4 — the revoke client: OWN row only');
// ===========================================================================
{
  const PUB_MINE = 'pub-mine-aaaa';
  const PUB_OTHER = 'pub-other-bbbb';
  const myKey = { pubB64Url: PUB_MINE };

  /** A fake fetch over a scripted ledger. Records every request it sees. */
  function rig({ rows = [], revokeStatus = 200, revokeBody = { alreadyRevoked: false },
                 listOk = true, listThrows = false } = {}) {
    const seen = [];
    const doFetch = async (url, init) => {
      seen.push({ url, init });
      if (String(url).includes('/api/devicekeys/list')) {
        if (listThrows) throw new Error('offline');
        if (!listOk) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ keys: rows }) };
      }
      return {
        ok: revokeStatus >= 200 && revokeStatus < 300,
        status: revokeStatus,
        json: async () => revokeBody,
      };
    };
    return { seen, opts: { fetch: doFetch, loadKey: async () => myKey } };
  }

  const row = (over = {}) => ({
    id: 'row-mine', kind: 'web', publicKey: PUB_MINE, revokedAt: null, ...over,
  });

  // --- resolution -------------------------------------------------------
  forgetWebDeviceKeyId();
  {
    const { opts } = rig({ rows: [row()] });
    const r = await resolveOwnWebDeviceKeyId(opts);
    eq('the id is resolved from a list row matching OUR public key', r.id, 'row-mine');
  }
  {
    // The bug this guards: "find the kind:'web' row". A user with two browsers
    // has two, and this would revoke the wrong one half the time.
    const { opts } = rig({
      rows: [row({ id: 'row-other-browser', publicKey: PUB_OTHER }), row()],
    });
    const r = await resolveOwnWebDeviceKeyId(opts);
    eq('a DIFFERENT browser\'s web row is never chosen', r.id, 'row-mine');
  }
  {
    const { opts } = rig({ rows: [row({ id: 'phone-row', kind: 'phone', publicKey: PUB_MINE })] });
    const r = await resolveOwnWebDeviceKeyId(opts);
    eq('a PHONE row is never chosen, even on a public-key collision', r.id, null);
    eq('...and it reports no live row', r.reason, 'no-live-row');
  }
  {
    const { opts } = rig({ rows: [row({ revokedAt: '2026-09-20T00:00:00Z' })] });
    eq('an already-revoked row is not re-resolved',
      (await resolveOwnWebDeviceKeyId(opts)).id, null);
  }
  {
    const { opts } = rig({ listOk: false });
    const r = await resolveOwnWebDeviceKeyId(opts);
    eq('a failed list lookup yields no id', r.id, null);
    eq('...and says lookup-failed, NOT "nothing of ours exists"', r.reason, 'lookup-failed');
  }
  {
    const { opts } = rig({ listThrows: true });
    eq('a THROWN list fetch is also lookup-failed, not a crash',
      (await resolveOwnWebDeviceKeyId(opts)).reason, 'lookup-failed');
  }
  {
    const { opts, seen } = rig({ rows: [row()] });
    const noKey = { ...opts, loadKey: async () => null };
    const r = await resolveOwnWebDeviceKeyId(noKey);
    eq('no key in this profile -> no-own-key', r.reason, 'no-own-key');
    eq('...and the list is never even requested', seen.length, 0);
  }

  // --- the remembered id ------------------------------------------------
  {
    forgetWebDeviceKeyId();
    eq('the cache starts empty', peekWebDeviceKeyId(), null);
    rememberWebDeviceKeyId('row-from-register');
    eq('the register echo is remembered', peekWebDeviceKeyId(), 'row-from-register');
    rememberWebDeviceKeyId(undefined);
    eq('a non-string never overwrites a good id', peekWebDeviceKeyId(), 'row-from-register');
    rememberWebDeviceKeyId('');
    eq('...nor does an empty string', peekWebDeviceKeyId(), 'row-from-register');

    const { opts, seen } = rig({ rows: [row()] });
    const r = await resolveOwnWebDeviceKeyId(opts);
    eq('the remembered id wins — no round-trip', r.id, 'row-from-register');
    eq('...and no list request was made', seen.length, 0);
    forgetWebDeviceKeyId();
  }

  // --- the POST ---------------------------------------------------------
  {
    forgetWebDeviceKeyId();
    const { opts, seen } = rig({ rows: [row()] });
    const res = await revokeOwnWebDeviceKey(opts);
    const post = seen.find((s) => String(s.url).includes('/revoke'));

    check('the revoke succeeded', res.ok === true, JSON.stringify(res));
    eq('it POSTs', post?.init?.method, 'POST');
    eq('it sends the session cookie (the route is same-origin + CSRF)',
      post?.init?.credentials, 'same-origin');
    // THE payload assertion: the whole body, not a subset. A body that grows a
    // `kind`, a `userId` or an `all` flag fails here, which is the point.
    deep('the payload is EXACTLY our own id', JSON.parse(post.init.body), { id: 'row-mine' });
    eq('the cache is cleared after a successful revoke — the id is now stale',
      peekWebDeviceKeyId(), null);
  }
  {
    forgetWebDeviceKeyId();
    const { opts } = rig({ rows: [row()], revokeBody: { alreadyRevoked: true } });
    const res = await revokeOwnWebDeviceKey(opts);
    check('an ALREADY-revoked row is a SUCCESS (the route\'s idempotency rule)',
      res.ok === true && res.alreadyRevoked === true, JSON.stringify(res));
  }
  {
    forgetWebDeviceKeyId();
    const { opts } = rig({ rows: [row()], revokeStatus: 401 });
    const res = await revokeOwnWebDeviceKey(opts);
    check('a 401 is a failure, not a silent pass', res.ok === false);
    eq('...with the status carried for the log', res.status, 401);
    eq('...and the reason is revoke-failed', res.reason, 'revoke-failed');
  }
  {
    forgetWebDeviceKeyId();
    const { opts, seen } = rig({ rows: [] });
    const res = await revokeOwnWebDeviceKey(opts);
    check('with no live row of ours, nothing is POSTed at all',
      !seen.some((s) => String(s.url).includes('/revoke')));
    eq('...and the caller is told why', res.reason, 'no-live-row');
  }
  {
    // Never throws — the whole helper chain is awaited on the sign-out path.
    forgetWebDeviceKeyId();
    const res = await revokeOwnWebDeviceKey({
      loadKey: async () => myKey,
      fetch: async () => { throw new Error('network gone'); },
    });
    check('a thrown fetch resolves to a result instead of rejecting', res.ok === false);
  }
  forgetWebDeviceKeyId();
}

// ===========================================================================
console.log('§5 — SOURCE PINS (the React/TSX wiring a node suite cannot import)');
// ===========================================================================
{
  // ---- the bridge -----------------------------------------------------
  const bridge = src('hooks/usePhoneBridge.ts');

  check('PIN: usePhoneBridge imports the pure teardown order',
    /import \{ runRevokingTeardown \} from '@\/lib\/e2e\/signOutEverywhere'/.test(bridge));
  check('PIN: signOutEverywhere runs the teardown with signOut TRUE',
    /signOutEverywhere = useCallback[\s\S]{0,500}?runRevokingTeardown\([\s\S]{0,500}?signOut: true/
      .test(bridge));
  check('PIN: forgetThisComputer runs it with signOut FALSE and reason user-forget',
    /forgetThisComputer = useCallback[\s\S]{0,500}?reason: 'user-forget', signOut: false/
      .test(bridge));
  check('PIN: both helpers are actually EXPORTED from the hook',
    /\n    signOutEverywhere,\n/.test(bridge) && /\n    forgetThisComputer,\n/.test(bridge));
  check('PIN: the bridge calls revokeLocalPair on e2eRef — the dead call site is alive',
    /e2eRef\.current\.revokeLocalPair\(/.test(bridge));
  check('PIN: ...and onSignOut too',
    /e2eRef\.current\.onSignOut\(\)/.test(bridge));

  // ---- the four logout callers ----------------------------------------
  // The defect was an ABSENCE, so the pin is a presence-and-position one: the
  // helper must appear, and it must appear BEFORE the logout fetch in the file.
  const callers = [
    ['components/ProfileMenu.tsx', /phone\.signOutEverywhere\(/],
    ['components/IdleTimeoutGuard.tsx', /signOutEverywhereRef\.current\?\.\(/],
    ['components/SubscribeLocked.tsx', /signOutEverywhere\('sign-out'\)/],
    ['app/app/settings/page.tsx', /phone\s*\n?\s*\.signOutEverywhere\(/],
  ];
  for (const [file, call] of callers) {
    const text = src(file);
    const logoutAt = text.indexOf("'/api/auth/logout'");
    check(`PIN: ${file} still has its logout fetch`, logoutAt > -1);
    const m = call.exec(text);
    check(`PIN: ${file} routes through signOutEverywhere`, Boolean(m), 'no call site found');
    if (m && logoutAt > -1) {
      check(`PIN: ${file} tears down BEFORE it logs out`, m.index < logoutAt,
        `helper at ${m.index}, logout at ${logoutAt}`);
    }
    // No caller may re-implement the order itself — that is what "ONE helper"
    // buys, and a caller that calls revokeLocalPair directly has forked it.
    check(`PIN: ${file} does not re-implement the teardown`,
      !/revokeLocalPair\(/.test(text));
  }

  // ---- ConnectionStatus ------------------------------------------------
  const cs = src('components/ConnectionStatus.tsx');

  // The confirm text is the brief's, VERBATIM. Pinned as a whole string
  // because the wording is the only thing distinguishing this control from
  // Reset lobby for a user standing in front of it.
  check('PIN: the Forget confirm text is the brief\'s, verbatim',
    cs.includes(
      'Forgets this pairing on this computer; the phone will ask you to pair again.',
    ));
  check('PIN: Forget calls forgetThisComputer', /void forgetThisComputer\(\)/.test(cs));
  check('PIN: Forget is rendered beside Reset in all three pill variants',
    (cs.match(/<ForgetComputerButton /g) ?? []).length === 3,
    String((cs.match(/<ForgetComputerButton /g) ?? []).length));

  // Reset lobby MUST stay a transport reset. This is the pin that stops a
  // future "tidy-up" from folding the two controls together.
  const resetHandler = cs.slice(cs.indexOf('const handleReset'), cs.indexOf('const onReset'));
  check('PIN: handleReset still calls ONLY resetRoom', /void resetRoom\(\)/.test(resetHandler));
  check('PIN: Reset lobby does NOT revoke — it keeps the pair',
    !/forgetThisComputer|revokeLocalPair/.test(resetHandler));
  check('PIN: Reset lobby keeps its own confirm text',
    cs.includes('Kicks your phone and this computer off'));

  // ---- the register echo ----------------------------------------------
  const wk = src('lib/e2e/webKey.ts');
  check('PIN: registerViaApi remembers the row id it is handed',
    /rememberWebDeviceKeyId\(id\)/.test(wk));
  check('PIN: ...and the id cache is the leaf module, not an import cycle',
    /from '\.\/webKeyId\.ts'/.test(wk));
}

// ===========================================================================
console.log('§6 — NEGATIVE CONTROL: the pins can actually fire');
// ===========================================================================
{
  // A pin that would pass against the PRE-P2.3 file is a comment. Reconstruct
  // the shipped base's caller (a bare logout fetch) and show the position pin
  // rejects it — otherwise every assertion in §5 is decoration.
  const preP23 = `
    const handleSignOut = async () => {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
      router.push('/');
    };
  `;
  const logoutAt = preP23.indexOf("'/api/auth/logout'");
  check('control: the pre-P2.3 caller HAS a logout fetch', logoutAt > -1);
  check('control: ...and NO signOutEverywhere call, so the §5 pin fails on it',
    !/signOutEverywhere\(/.test(preP23));

  // And the order function itself: a "teardown" that logged out first would
  // still call every leg, so leg-presence alone proves nothing — only the
  // INDEX comparisons in §1 do. Demonstrate by building the wrong order and
  // showing the §1 predicate rejects it.
  const wrong = ['resetRoom', 'revokeLocalPair:sign-out', 'onSignOut', 'revokeRemote'];
  check('control: a reversed order contains every leg...',
    TEARDOWN_STEPS.every((s) => wrong.some((w) => w.startsWith(s))));
  check('control: ...yet fails the "local precedes transport" assertion',
    !(wrong.indexOf('revokeLocalPair:sign-out') < wrong.indexOf('resetRoom')));
}

const total = passed + failed;
console.log(`\ne2e-web-revocation-wiring: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
