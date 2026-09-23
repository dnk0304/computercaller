/**
 * tests/e2e-web-sw-advert.test.mjs — E2E-P6.1c (2b).
 *
 * A6-P61B-5: EVERY P6.1b pairing advertised `e2e=v1/mode1/recips1` while the
 * extension service worker was present as a relay listener, and the finding sat
 * UNATTRIBUTED for a whole lane — driver artefact or product fault, nobody
 * could tell — because the page held no record of what the A4.1 bridge had
 * said by the time it froze the recipient set.
 *
 * Two things are pinned here:
 *
 *  1. THE ORDER. BROWSER_REQUEST_PAIRING must not leave before the bridge has
 *     answered. `buildRequestE2e` is where the recipient set is frozen and
 *     usePhoneBridge awaits it before sending, so the order is a property of
 *     that await — asserted on the source, because it is the thing a
 *     well-meaning refactor breaks.
 *
 *  2. THE ANSWER IS RECORDED. `SwKeyStatus` has three values and one of them,
 *     `unknown`, covers two different situations: not framed by the extension
 *     (no bridge exists, recips1 is correct) and framed but silent (a fault).
 *     `swBridgeAnswer()` separates them, and the pair
 *     {advertisedRecipients, swBridge} goes on the debug surface so the next
 *     live run attributes itself.
 *
 * And the coverage half of the brief: when the SW key is unavailable, a surface
 * must be able to render `coversSw: false`. That is `sasCoverage`'s job and it
 * is exercised here against the exact shapes this lane produces, because the
 * defect being guarded against is a page inferring coverage from a key COUNT.
 *
 * Run: node tests/e2e-web-sw-advert.test.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  E2E_VIEW_INITIAL,
  buildRequestBlock,
  readSwKey,
  sasCoverage,
  swBridgeAnswer,
} from '../hooks/phoneE2e.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let total = 0;
const failures = [];
function check(name, ok, detail) {
  total += 1;
  if (ok) { passed += 1; return; }
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** See tests/e2e-web-sas-confirm.test.mjs — every file here is CRLF. */
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '');
}
{
  const crlf = 'a\r\n// swBridgeAnswer\r\nb\r\n';
  check('stripComments removes a line comment from CRLF source',
    !stripComments(crlf).includes('swBridgeAnswer'), JSON.stringify(stripComments(crlf)));
}

const B64_32 = 'A'.repeat(43);
/** A relay-legal 65-byte SEC1 point in base64url — the pinned shape. */
const PUB_WEB = `BA${'A'.repeat(84)}Q`;
const PUB_SW = `BB${'B'.repeat(84)}Q`;
const WEB_KEY = { deviceId: 'web-aaaaaaaaaaaa', pubB64Url: PUB_WEB };

// ── 1. swBridgeAnswer separates the two `unknown`s ──────────────────────────
const UNKNOWN = { status: 'unknown', recipient: null, pairingId: null };
const ABSENT = { status: 'absent', recipient: null, pairingId: null };
const PRESENT = {
  status: 'present',
  recipient: { kind: 'extension', deviceId: 'ext-bbbbbbbbbbbb', pub: PUB_SW },
  pairingId: null,
};

eq('a key is a key, framed', swBridgeAnswer(PRESENT, true), 'key');
eq('a key is a key, unframed too (a cached key survives)', swBridgeAnswer(PRESENT, false), 'key');
eq('an explicit no-key reading is `none`, not a timeout', swBridgeAnswer(ABSENT, true), 'none');
eq('an explicit no-key reading is `none` unframed as well', swBridgeAnswer(ABSENT, false), 'none');
/**
 * THE SPLIT. These two lines are the whole finding: the same SwKeyStatus, two
 * different answers, and only one of them is a fault worth chasing.
 */
eq('framed and silent is a TIMEOUT — a fault', swBridgeAnswer(UNKNOWN, true), 'timeout');
eq('unframed is NO BRIDGE — not a fault', swBridgeAnswer(UNKNOWN, false), 'no-extension-frame');

// readSwKey's own outputs must flow through it without a translation layer.
eq('a malformed bridge message reads as `none`, not a timeout',
  swBridgeAnswer(readSwKey({ v: 1, deviceId: 'nope!', pub: null }), true), 'none');
eq('an explicit null/null bridge message reads as `none`',
  swBridgeAnswer(readSwKey({ v: 1, deviceId: null, pub: null }), true), 'none');
eq('a message we never got reads as a timeout when framed',
  swBridgeAnswer(readSwKey(null), true), 'timeout');
eq('an unknown protocol version is NOT an answer',
  swBridgeAnswer(readSwKey({ v: 2, deviceId: 'ext-bbbbbbbbbbbb', pub: PUB_SW }), true), 'timeout');

// ── 2. what each answer actually advertises ─────────────────────────────────
for (const [label, sw, want] of [
  ['no bridge', UNKNOWN, 1],
  ['bridge said none', ABSENT, 1],
  ['bridge gave a key', PRESENT, 2],
]) {
  const block = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw });
  eq(`advert recipient count (${label})`, block.recips.length, want);
  eq(`the web key is always recipient 0 (${label})`, block.recips[0].kind, 'web');
}
{
  const block = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw: UNKNOWN });
  check('an unanswered bridge never puts a guessed key on the wire',
    !JSON.stringify(block).includes(PUB_SW));
  /**
   * The STATUS is the gate, not the presence of a recipient object. readSwKey
   * never produces this shape — a recipient alongside a non-`present` status —
   * and that is exactly why it is tested here: the guard that keeps the two in
   * step is one `&&` in buildRequestBlock, and a refactor that reads the
   * recipient alone would put an unconfirmed key in the SAS transcript while
   * every other assertion in this file stayed green.
   */
  const LIAR = { status: 'unknown', recipient: PRESENT.recipient, pairingId: null };
  const lied = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw: LIAR });
  eq('a recipient without a `present` status is NOT advertised', lied.recips.length, 1);
  check('...and its key is nowhere on the wire', !JSON.stringify(lied).includes(PUB_SW));
  const LIAR2 = { status: 'absent', recipient: PRESENT.recipient, pairingId: null };
  eq('an `absent` reading with a stale recipient advertises one key',
    buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw: LIAR2 }).recips.length, 1);
}

// ── 3. coversSw is COMPUTED, never inferred from the count ──────────────────
function acceptBlock(keys) {
  return { kid: 'kkkkkkkk', epk: B64_32, recipKeys: keys, wraps: [] };
}
{
  // recips1, no SW key anywhere: the honest rendering is coversSw false.
  const cov = sasCoverage(acceptBlock([PUB_WEB]), { ourPub: PUB_WEB, phonePub: null, sw: UNKNOWN });
  eq('recips1 with no bridge: coversSw is false', cov.coversSw, false);
  eq('recips1 with no bridge: keyCount is 1', cov.keyCount, 1);
  eq('recips1 with no bridge: the swStatus is carried for the surface', cov.swStatus, 'unknown');
  check('recips1 with no bridge is not a STALE key (nothing was advertised)', !cov.staleSwKey);
}
{
  const cov = sasCoverage(acceptBlock([PUB_WEB]), { ourPub: PUB_WEB, phonePub: null, sw: ABSENT });
  eq('recips1 with an explicit no-key: coversSw is false', cov.coversSw, false);
  eq('recips1 with an explicit no-key: swStatus absent', cov.swStatus, 'absent');
}
{
  const cov = sasCoverage(acceptBlock([PUB_WEB, PUB_SW]),
    { ourPub: PUB_WEB, phonePub: null, sw: PRESENT });
  eq('recips2 with the live key: coversSw is true', cov.coversSw, true);
}
{
  /**
   * THE ONE THAT MATTERS. Two keys in the transcript and the SW does not hold
   * the second one. A page that inferred coverage from `keyCount === 2` would
   * claim the extension leg is verified by the digits. It is not.
   */
  const cov = sasCoverage(acceptBlock([PUB_WEB, PUB_SW]),
    { ourPub: PUB_WEB, phonePub: null, sw: UNKNOWN });
  eq('a 2-key transcript we cannot attribute does NOT cover the SW', cov.coversSw, false);
  eq('...and it is 2 keys, so a count would have said yes', cov.keyCount, 2);
}

// ── 4. the view carries the record ──────────────────────────────────────────
eq('the initial view has advertised nothing yet',
  E2E_VIEW_INITIAL.debug.advertisedRecipients, null);
eq('the initial view has heard nothing yet', E2E_VIEW_INITIAL.debug.swBridge, null);

// ── 5. THE WIRING ───────────────────────────────────────────────────────────
const useE2e = stripComments(readFileSync(join(ROOT, 'hooks', 'useE2e.ts'), 'utf8'));
const bridge = stripComments(readFileSync(join(ROOT, 'hooks', 'usePhoneBridge.ts'), 'utf8'));

{
  const i = useE2e.indexOf('const buildRequestE2e = useCallback');
  check('buildRequestE2e exists', i > 0);
  const body = useE2e.slice(i, useE2e.indexOf('const onPairingActive = useCallback'));

  check('the SW wait is still awaited inside the request builder',
    /await new Promise<void>\(\(resolve\) => \{/.test(body));
  check('the wait is bounded by SW_KEY_WAIT_MS', body.includes('SW_KEY_WAIT_MS'));
  check('the wait only runs while the answer is still unknown',
    /if \(swRef\.current\.status === 'unknown' && framed\)/.test(body));
  check('the framed test is computed once, by name',
    /const framed = typeof window !== 'undefined' && window\.parent !== window;/.test(body));

  check('the answer is computed from the bridge state and the framing',
    /const answer = swBridgeAnswer\(swRef\.current, framed\);/.test(body));
  /**
   * ORDER. The answer must be computed AFTER the wait, or a framed page that
   * replies in 40 ms would still be recorded as a timeout.
   */
  check('the answer is computed AFTER the wait, not before',
    body.indexOf('await new Promise') < body.indexOf('const answer ='));
  check('the record is published on the debug surface',
    /debug: \{ \.\.\.v\.debug, advertisedRecipients, swBridge: answer \}/.test(body));
  check('the count comes from the block that is actually returned',
    /const advertisedRecipients = block\.recips\.length;/.test(body));
  check('the advert is logged, because the finding was raised from a page console',
    /console\.log\(\s*`\[e2e\] advert recipients=/.test(body));
  check('the record is written BEFORE the block is returned',
    body.indexOf('swBridge: answer') < body.indexOf('return block;'));
}

{
  const i = bridge.indexOf('const requestPairing = useCallback');
  check('requestPairing exists', i > 0);
  const body = bridge.slice(i, i + 4000);
  /**
   * The order this whole letter is about: the frame is sent INSIDE the
   * continuation of buildRequestE2e, so there is no path on which
   * BROWSER_REQUEST_PAIRING leaves before the bridge has answered.
   */
  const build = body.indexOf('e2eRef.current.buildRequestE2e()');
  const send = body.indexOf('BROWSER_REQUEST_PAIRING:');
  check('requestPairing builds the block before sending', build > 0 && send > build);
  check('the send is inside the builder continuation, not beside it',
    /buildRequestE2e\(\)\.then\(\(e2e\) => \{[\s\S]*?BROWSER_REQUEST_PAIRING:/.test(body));
  check('nothing sends BROWSER_REQUEST_PAIRING outside that continuation',
    (bridge.match(/BROWSER_REQUEST_PAIRING:/g) || []).length === 1);
}

// ────────────────────────────────────────────────────────────────────────────
// T-SW-KEY-STALE-AFTER-REGISTER — the SW key that arrives AFTER the page asked
// (RESUME-PROTOCOL RULE 30 contract; live 7b finding 1 on 3e466fd)
//
// THE DEFECT. The page posts `e2e-pubkey-request` ONCE on mount
// (hooks/useE2e.ts). background.js withholds `pub` until `swRegistered`
// (INC-0923 B-1, correct and KEPT), and registration lands seconds after the
// mount — 11:25:07 mount, 11:25:10 registered. So the one answer the page ever
// got was the honest `{deviceId:null, pub:null}` = `absent`, the first
// BROWSER_REQUEST_PAIRING went out `swBridge=none`, and only closing and
// reopening the panel produced `swBridge=key`. Pairing worked either way; the
// extension was simply absent from that pair's transcript, so a notification
// body with the panel closed was not decryptable until a re-pair.
//
// TWO halves, and this section asserts BOTH: a PUSH on the extension side
// (shell.js turns the registration edge into an unsolicited `e2e-pubkey`) and
// a PULL on the page side (buildRequestE2e re-asks at pairing start when it
// does not hold a key).
// ────────────────────────────────────────────────────────────────────────────

const shell = stripComments(readFileSync(join(ROOT, 'chrome-extension', 'shell.js'), 'utf8'));

// ── behaviour: the REAL reducer, over the two real reply shapes ─────────────
{
  // Mount. The worker is up but unregistered, so B-1 withholds the key.
  const onMount = readSwKey({ v: 1, deviceId: null, pub: null, pairingId: null });
  eq('mount: the withheld-key reply reads as `absent`, not `unknown`', onMount.status, 'absent');
  eq('mount: and the advert would have said `none`', swBridgeAnswer(onMount, true), 'none');
  check('mount: nothing is guessed onto the wire', onMount.recipient === null);

  // The push after registration. Unsolicited: NO `rid`, because nothing asked.
  const afterRegister = readSwKey({
    v: 1, deviceId: 'ext-bbbbbbbbbbbb', pub: PUB_SW, pairingId: null,
  });
  eq('after registration: the same page state becomes `present`', afterRegister.status, 'present');
  eq('after registration: the advert now says `key`', swBridgeAnswer(afterRegister, true), 'key');
  eq('after registration: it is the SW key, not the web one', afterRegister.recipient.pub, PUB_SW);
  check('after registration: the recipient is the extension',
    afterRegister.recipient.kind === 'extension');
  // The whole point: the second reading came from a MESSAGE, not from a new
  // mount. `readSwKey` holds no state, so a reply is sufficient on its own —
  // which is what makes an unsolicited push a complete fix.
  check('the transition needs no second mount: the reducer is pure',
    readSwKey({ v: 1, deviceId: null, pub: null, pairingId: null }).status === 'absent'
    && readSwKey({ v: 1, deviceId: 'ext-bbbbbbbbbbbb', pub: PUB_SW, pairingId: null }).status === 'present');
  // The control. If the page ever started REQUIRING a `rid` to accept a reply,
  // the unsolicited push would be dropped and this section would be measuring
  // nothing — so the page-side gate is asserted by source below.
  eq('an unsolicited emission carries no rid and is still a valid key',
    readSwKey({ v: 1, deviceId: 'ext-bbbbbbbbbbbb', pub: PUB_SW, pairingId: null }).status,
    'present');
}

// ── push half: shell.js turns the registration EDGE into a key ──────────────
{
  const i = shell.indexOf('presencePort.onMessage.addListener');
  check('the presence-port listener exists', i > 0);
  const body = shell.slice(i, shell.indexOf('presencePort.onDisconnect'));
  check('the presence listener handles e2e-status at all',
    /msg\.type === 'e2e-status'/.test(body), body);
  check('the push is on the false->true EDGE, not on every broadcast',
    /const was = swRegisteredSeen;/.test(body) && /was !== true/.test(body), body);
  check('the edge pushes a FRESH key, unsolicited (no rid argument)',
    /if \(swRegisteredSeen && was !== true\) sendE2ePubKey\(\);/.test(body), body);
  check('the seen-flag is a THIRD state, so "never heard" cannot push',
    /^let swRegisteredSeen;$/m.test(shell));
  // Scope: the push must reach the APP frame only. `sendE2ePubKey` posts to
  // `frame`, never to `loginFrame` — the login verb set stays disjoint.
  const send = shell.slice(shell.indexOf('async function sendE2ePubKey'));
  check('sendE2ePubKey posts to the app frame only',
    /frame\.contentWindow\.postMessage\(/.test(send)
    && !/loginFrame\.contentWindow\.postMessage/.test(shell));
  check('and still pins the target origin', /self\.CC\.WEBAPP_ORIGIN,/.test(send));
}

// ── pull half: the page re-asks at pairing start when it holds no key ───────
{
  const i = useE2e.indexOf('const buildRequestE2e = useCallback');
  const body = useE2e.slice(i, useE2e.indexOf('const onPairingActive = useCallback'));
  check('pairing start re-requests the key when we do not hold one',
    /if \(framed && swRef\.current\.status !== 'present'\) \{/.test(body), body);
  check('the re-request is a real e2e-pubkey-request on the bridge',
    /type: 'e2e-pubkey-request'/.test(body));
  check('it carries a rid, so the reply can be told from an unsolicited push',
    /rid: `sw-requery-/.test(body));
  check('it is pinned to the extension origin', /CC_EXTENSION_ORIGIN,/.test(body));
  check('the re-query wait is BOUNDED by its own constant', body.includes('SW_KEY_REQUERY_MS'));
  check('and that constant is short — a pairing must not stall on it',
    /export const SW_KEY_REQUERY_MS = 300;/.test(useE2e));
  /**
   * ORDER, the same rule the section above pins for the 1 s wait: the answer is
   * computed AFTER the re-query, or a key that arrived in 40 ms is still
   * recorded as `none` and the transcript still goes out without it.
   */
  check('the re-query happens BEFORE the answer is computed',
    body.indexOf("status !== 'present'") < body.indexOf('const answer ='));
  // The guard, stated as a NEGATIVE that was proven capable of firing: dropping
  // the `status !== 'present'` half makes every pairing re-ask even when the
  // key is already in hand. The `try {` is in the pattern because comment
  // stripping leaves it directly under the `if` — a pattern written without it
  // matches nothing and passes for free.
  check('a key we ALREADY hold is not re-requested',
    !/if \(framed\) \{\s*try \{\s*window\.parent\.postMessage/.test(body));
  // INC-0923 B-1 must survive: the fix is a re-ASK, never a relaxation of the
  // rule that an unregistered key is withheld at the source.
  const bg = stripComments(readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8'));
  const getArm = bg.slice(bg.indexOf("'e2e-pubkey-get'"), bg.indexOf("'e2e-pubkey-get'") + 4000);
  check('B-1 still holds: the worker withholds `pub` until it is registered',
    /swRegistered/.test(getArm), getArm.slice(0, 200));
}

console.log(`\ne2e-web-sw-advert: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
