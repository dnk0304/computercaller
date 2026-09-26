#!/usr/bin/env node
/**
 * tests/e2e-pref-reconnect-mode.test.mjs — #18 Fix B (PHONE-STATUS-DIAG item 10).
 *
 * THE PROD DEFECT. 2026-09-26 08:21:19Z the phone turned Encrypted mode OFF
 * (SET_E2E_PREF rev 2), the relay reset the room, and the browser's NEXT
 * pairing request still asked for mode1; the codes were refused at 08:22:39
 * and only the second reconnect went mode0. The reverse (08:10:47Z, rev 1 ON)
 * reconnected in mode0. The rule this file holds: the pushed value is applied
 * BEFORE the next BROWSER_REQUEST_PAIRING block is built — both directions,
 * including a push that lands WHILE the block is being built.
 *
 * WHAT IS REAL HERE
 *   - lib/e2eAccountPref.ts: the REAL store (module singleton), driven through
 *     its public entry points exactly as usePhoneBridge drives it:
 *     applyE2ePrefPush (the E2E_PREF case), noteRelayRoomReset (close 4010),
 *     and currentAdvertisedMode (what useE2e's buildRequestE2e now reads).
 *     window/localStorage/fetch are node fakes; nothing in the store is stubbed.
 *   - hooks/phoneE2e.ts buildRequestBlock: the REAL block, so "carries mode0"
 *     is asserted on the object that goes on the wire.
 *   - the equal-rev rule is the REAL applyIncoming (DESIGN §4): a same-rev
 *     push with a different preference is dropped; a same-rev master-switch
 *     flip moves `effective`.
 * THE WIRING (source pins, because a React hook cannot run under node): the
 *   read happens after buildRequestE2e's last await, the block takes it, the
 *   closure's `localMode` is gone from both callbacks, and the Accept is
 *   decided against the mode that was advertised.
 *
 * CONTROL. §3 runs the race with the PRE-FIX read (the mode captured when the
 * build STARTS, which is what a render-time closure is) and requires the block
 * to come out in the OLD mode — the prod symptom. §4 plants the old closure
 * read back into the source and requires the pins to go red.
 *
 * Run: node tests/e2e-pref-reconnect-mode.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── node fakes for the browser surface the store touches ────────────────────
const mem = new Map();
const localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const win = { localStorage, addEventListener() {}, removeEventListener() {}, postMessage() {} };
win.parent = win; // an unframed /app page
globalThis.window = win;

let serverResolved = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u.endsWith('/api/auth/me') ? { user: { id: 'user-fix-b', email: 'b@example.com' } }
    : u.endsWith('/api/prefs/e2e') ? { resolved: serverResolved } : null;
  return { status: body ? 200 : 404, ok: !!body, json: async () => body };
};

const Store = await import('../lib/e2eAccountPref.ts');
const { buildRequestBlock } = await import('../hooks/phoneE2e.ts');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

const R = (rev, preference, effective = preference, pausedByServer = false) =>
  ({ preference, effective, pausedByServer, rev, updatedAt: '2026-09-26T08:21:19Z', updatedBy: 'phone' });

const b64u = (b) => Buffer.from([4, ...new Array(64).fill(b)]).toString('base64url');
const WEB_KEY = { deviceId: 'web-fixb-01', pubB64Url: b64u(0x22) };
const SW_ABSENT = { status: 'absent', recipient: null, pairingId: null };
/** The block exactly as buildRequestE2e now builds it: mode read at build time. */
const blockNow = () => buildRequestBlock({ localMode: Store.currentAdvertisedMode(), webKey: WEB_KEY, sw: SW_ABSENT });

// ── 1. the store: a push is visible to the next build, synchronously ────────
console.log('1. push -> reset -> next request block (both directions, equal-rev rule)');
serverResolved = R(1, 'on');
Store.ensureAccountPrefLoaded();
await flush();
eq('loaded: account ON (rev 1) -> request carries mode1', blockNow().mode, 1);

// OFF direction: the prod 08:21:19Z sequence. Push, then the relay's 4010.
Store.applyE2ePrefPush(R(2, 'off'));
Store.noteRelayRoomReset();
eq('push rev 2 OFF + room reset -> the NEXT request carries mode0 (no render in between)', blockNow().mode, 0);

// ON direction: the prod 08:10:47Z sequence.
Store.applyE2ePrefPush(R(3, 'on'));
Store.noteRelayRoomReset();
eq('push rev 3 ON + room reset -> the next request carries mode1', blockNow().mode, 1);

// The accepted protocol rule for equal / older revs (applyIncoming, DESIGN §4).
Store.applyE2ePrefPush(R(3, 'off'));
eq('equal-rev push with a DIFFERENT preference is dropped (still mode1)', blockNow().mode, 1);
Store.applyE2ePrefPush(R(2, 'off'));
eq('stale rev 2 is dropped (still mode1)', blockNow().mode, 1);
Store.applyE2ePrefPush(R(3, 'on', 'off', true));
eq('equal-rev MASTER-SWITCH flip (effective off, paused) applies -> mode0', blockNow().mode, 0);
Store.applyE2ePrefPush(R(3, 'on', 'on', false));
eq('...and back at the same rev -> mode1', blockNow().mode, 1);
Store.applyE2ePrefPush({ preference: 'off' });
eq('an unparseable push is ignored, never read as OFF', blockNow().mode, 1);

// ── 2. a push that lands before /api/auth/me answered (fresh page / re-sign-in)
console.log('2. push before the session userId is known');
Store.wipeAccountPrefOnSignOut();
eq('signed out: nothing known -> OFF (the account default)', Store.currentAdvertisedMode(), 'off');
Store.applyE2ePrefPush(R(7, 'on'));
eq('an on-connect push held for the userId still decides the next request (mode1)', blockNow().mode, 1);
serverResolved = R(7, 'on');
Store.ensureAccountPrefLoaded();
await flush();
eq('...and once the session loads, the same value persists (mode1)', blockNow().mode, 1);

// ── 3. the race: the push lands WHILE the block is being built ──────────────
console.log('3. mid-build race (the SW wait + device-key + DeviceKey-list awaits)');
async function buildRace({ push, preFix }) {
  let release;
  const awaited = new Promise((r) => { release = r; });
  const captured = Store.currentAdvertisedMode(); // what a render-time closure holds
  const building = (async () => {
    await awaited; // buildRequestE2e's awaits
    return buildRequestBlock({ localMode: preFix ? captured : Store.currentAdvertisedMode(), webKey: WEB_KEY, sw: SW_ABSENT });
  })();
  Store.applyE2ePrefPush(push);
  Store.noteRelayRoomReset();
  release();
  return (await building).mode;
}
eq('ON -> OFF push mid-build: block carries mode0', await buildRace({ push: R(8, 'off') }), 0);
eq('OFF -> ON push mid-build: block carries mode1', await buildRace({ push: R(9, 'on') }), 1);
eq('CONTROL pre-fix (closure) read, ON -> OFF mid-build: block still mode1 (prod symptom)',
  await buildRace({ push: R(10, 'off'), preFix: true }), 1);
eq('CONTROL pre-fix (closure) read, OFF -> ON mid-build: block still mode0',
  await buildRace({ push: R(11, 'on'), preFix: true }), 0);

// ── 4. the wiring in hooks/useE2e.ts ────────────────────────────────────────
console.log('4. useE2e wiring pins (+ planted regression)');
function pins(srcRaw) {
  const src = stripComments(srcRaw);
  const out = {};
  const b0 = src.indexOf('const buildRequestE2e = useCallback(');
  const b1 = src.indexOf('const onPairingActive = useCallback(');
  const build = b0 > 0 && b1 > b0 ? src.slice(b0, b1) : '';
  out.sliced = build.length > 500;
  const readAt = build.indexOf('currentAdvertisedMode()');
  const retAt = build.indexOf('return block;');
  // No await anywhere between reading the mode and handing the block back:
  // every await in the function precedes the read.
  out.readAfterLastAwait = readAt > 0 && retAt > readAt
    && build.lastIndexOf('await ') < readAt && readAt < build.indexOf('buildRequestBlock(');
  out.blockTakesRead = /buildRequestBlock\(\{ localMode: mode,/.test(build);
  out.noClosureInBuild = !/\blocalMode\b(?!:)/.test(build.replace(/localMode: mode/g, ''));
  out.depsNoLocalMode = /\}, \[fail, fetchDeviceKeyList\]\);/.test(build);
  out.recordsAdvert = /advertisedModeRef\.current = mode;/.test(build);
  const accept = src.slice(b1, src.indexOf('const onE2eUnavailable'));
  out.acceptUsesAdvert = /decideAccept\(\{\s*localMode: advertisedModeRef\.current \?\? currentAdvertisedMode\(\),/.test(accept);
  out.acceptNoClosureDep = /\}, \[fail, fetchRevocationVerdict\]\);/.test(accept);
  return out;
}
const real = pins(read('hooks/useE2e.ts'));
check('buildRequestE2e sliced', real.sliced);
check('the mode is read AFTER the last await in buildRequestE2e (none between read and send)', real.readAfterLastAwait);
check('buildRequestBlock takes the read (`localMode: mode`)', real.blockTakesRead);
check('no render-time `localMode` left inside buildRequestE2e', real.noClosureInBuild);
check('buildRequestE2e no longer depends on `localMode`', real.depsNoLocalMode);
check('the advertised mode is recorded for the Accept', real.recordsAdvert);
check('the Accept is decided against the ADVERTISED mode (live value only as a resume fallback)', real.acceptUsesAdvert);
check('onPairingActive no longer depends on `localMode`', real.acceptNoClosureDep);
const bridge = stripComments(read('hooks/usePhoneBridge.ts'));
check('usePhoneBridge still routes E2E_PREF to the store and 4010 to noteRelayRoomReset',
  /case 'E2E_PREF': \{\s*applyE2ePrefPush\(payload\);/.test(bridge) && /noteRelayRoomReset\(\);/.test(bridge));
check('the request is built by buildRequestE2e at send time (not precomputed)',
  /void e2eRef\.current\.buildRequestE2e\(\)\.then\(\(e2e\) => \{/.test(bridge));

const planted = read('hooks/useE2e.ts')
  .replace('const mode: LocalMode = currentAdvertisedMode();', 'const mode: LocalMode = localMode;')
  .replace('}, [fail, fetchDeviceKeyList]);', '}, [fail, localMode, fetchDeviceKeyList]);');
const p = pins(planted);
check('CONTROL planted closure read: the pins go red',
  p.readAfterLastAwait === false && p.noClosureInBuild === false && p.depsNoLocalMode === false);
{
  const before = failed;
  check('self-test (DELIBERATE - the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-pref-reconnect-mode: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
