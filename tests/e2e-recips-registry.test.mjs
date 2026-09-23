/**
 * tests/e2e-recips-registry.test.mjs — INC-0923 B-1.
 *
 * THE PROPERTY. The computer must never advertise, in the `recips` of
 * BROWSER_REQUEST_PAIRING, a device key that has no live row in the §13.6 pin
 * registry.
 *
 * WHY THAT IS A HARD RULE AND NOT A PREFERENCE. The phone's `E2eKeyPin.verify`
 * returns `Verdict.Mismatch` — not "unverified" — for an advertised key the
 * registry does not know, in BOTH modes, because from the phone's side an
 * unregistered key in a recipient list is indistinguishable from a substituted
 * one. The phone then declines, and `e2eDowngradeLatch` is in-memory and
 * process-lifetime, so every SUBSEQUENT pairing is aborted in 1-2 s until the
 * app is force-stopped. One missing row therefore does not degrade a pairing,
 * it ends pairing for that phone. That is the whole of INC-0923.
 *
 * The extension's own contract said the opposite — background.js's comment read
 * "pair will be UNVERIFIED" — and each side was correct to its own spec. This
 * file pins the side that had to move.
 *
 * WHAT IS ASSERTED, AND WHERE IT LIVES
 *   1. The pure filter (hooks/phoneE2e.ts). Real functions, real inputs.
 *   2. The extension's own half, on the SOURCE of background.js: a key is
 *      advertised over the page bridge only when it is registered. Source
 *      assertions because there is no way to boot an MV3 worker from node, and
 *      the thing a refactor breaks is the wiring, not the arithmetic.
 *   3. The web backstop is actually WIRED into buildRequestE2e — an unwired
 *      pure function is a function that proves nothing.
 *
 * Run: node tests/e2e-recips-registry.test.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRequestBlock,
  filterRecipsToLiveRows,
  liveRegisteredDeviceIds,
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

/**
 * A 65-byte 0x04 SEC1 point, base64url — the ONLY shape `isPinned` accepts, and
 * buildRequestBlock throws on anything else. Built rather than pasted so the
 * fixture cannot drift out of the pinned shape without this file noticing.
 */
function pinnedPub(fill) {
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  for (let i = 1; i < 65; i += 1) raw[i] = (fill + i) & 0xff;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return Buffer.from(s, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const WEB = { kind: 'web', deviceId: 'web-aaaaaaaaaaaaaaaaaaaaaa', pub: pinnedPub(1) };
const EXT = { kind: 'extension', deviceId: 'ext-bbbbbbbbbbbbbbbbbbbbbb', pub: pinnedPub(2) };

// ── 1. liveRegisteredDeviceIds: null is NOT an empty set ────────────────────
{
  // The distinction this whole section exists for. An unreadable payload must
  // answer "I do not know" and NOT "the registry knows nobody" — collapsing the
  // two would make a failed fetch strip every recipient, including our own.
  check('null payload -> null', liveRegisteredDeviceIds(null) === null);
  check('non-object -> null', liveRegisteredDeviceIds('nope') === null);
  check('array -> null', liveRegisteredDeviceIds([]) === null);
  check('object with no keys[] -> null', liveRegisteredDeviceIds({ userId: 'u1' }) === null);

  const empty = liveRegisteredDeviceIds({ keys: [] });
  check('empty keys[] -> an EMPTY SET, not null', empty instanceof Set && empty.size === 0);

  const live = liveRegisteredDeviceIds({
    keys: [
      { deviceId: WEB.deviceId, kind: 'web', revokedAt: null },
      { deviceId: EXT.deviceId, kind: 'extension', revokedAt: '2026-09-22T00:00:00.000Z' },
      { deviceId: 'phone-1', kind: 'phone' },
      { deviceId: '', kind: 'web', revokedAt: null },
      null,
    ],
  });
  check('a revokedAt:null row is live', live.has(WEB.deviceId));
  check('a revoked row is NOT live', !live.has(EXT.deviceId));
  check('an ABSENT revokedAt is live (the API omits it)', live.has('phone-1'));
  check('an empty deviceId is never admitted', !live.has(''));
  eq('exactly the live rows', [...live].sort(), ['phone-1', WEB.deviceId].sort());

  // Fail-closed on a truthy non-string revokedAt, matching readRevocationVerdict.
  const weird = liveRegisteredDeviceIds({ keys: [{ deviceId: 'd1', revokedAt: 0 }] });
  check('revokedAt:0 is NOT treated as live (fail closed)', !weird.has('d1'));
}

// ── 2. filterRecipsToLiveRows ───────────────────────────────────────────────
{
  const both = [WEB, EXT];

  const allLive = filterRecipsToLiveRows(both, new Set([WEB.deviceId, EXT.deviceId]), WEB.deviceId);
  eq('both registered -> both kept', allLive.recips.map((r) => r.deviceId), [WEB.deviceId, EXT.deviceId]);
  eq('nothing dropped', allLive.dropped, []);
  check('web row present -> webRowMissing false', allLive.webRowMissing === false);

  // THE INCIDENT, exactly: web has a row, the extension does not.
  const extMissing = filterRecipsToLiveRows(both, new Set([WEB.deviceId]), WEB.deviceId);
  eq('unregistered extension is DROPPED', extMissing.recips.map((r) => r.deviceId), [WEB.deviceId]);
  eq('and reported', extMissing.dropped.map((r) => r.deviceId), [EXT.deviceId]);

  // The one recipient that is never dropped, whatever the registry says.
  const noRows = filterRecipsToLiveRows(both, new Set(), WEB.deviceId);
  eq('our own web key survives an empty registry', noRows.recips.map((r) => r.deviceId), [WEB.deviceId]);
  check('and the missing web row is REPORTED, not swallowed', noRows.webRowMissing === true);

  // live === null: we could not read the registry. Everything unprovable goes.
  const unknown = filterRecipsToLiveRows(both, null, WEB.deviceId);
  eq('unreadable registry -> only our own key is advertised',
    unknown.recips.map((r) => r.deviceId), [WEB.deviceId]);
  check('an unreadable registry is NOT reported as a missing web row',
    unknown.webRowMissing === false);

  // The filter must not mutate its input — buildRequestBlock's caller reuses it.
  eq('input list untouched', both.map((r) => r.deviceId), [WEB.deviceId, EXT.deviceId]);

  // And the survivor is still a legal block.
  const block = buildRequestBlock({
    localMode: 'off',
    webKey: { deviceId: WEB.deviceId, pubB64Url: WEB.pub },
    sw: { status: 'absent', recipient: null, pairingId: null },
  });
  eq('a web-only advert is recips1', block.recips.length, 1);
}

// ── 3. the extension half, on the source ────────────────────────────────────
{
  const bg = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
  const swKey = readFileSync(join(ROOT, 'chrome-extension', 'e2e', 'sw-key.js'), 'utf8');

  check('publicIdentity reports `registered`', /registered:\s*isRegistered\(rec\)/.test(swKey));
  check('the flag is persisted on the record, not in worker memory',
    /markDeviceKeyRegistered/.test(swKey) && /registeredAt:\s*Date\.now\(\)/.test(swKey));
  check('the mark is GUARDED on the deviceId that was registered',
    /rec\.deviceId\s*!==\s*deviceId/.test(swKey));
  check('a 200 marks the key registered before the caller is told ok',
    /await markDeviceKeyRegistered\(identity\.deviceId\);[\s\S]{0,120}return \{ ok: true/.test(swKey));
  check('the non-2xx result carries the status, so 409 is distinguishable',
    /status:\s*res\.status/.test(swKey));

  // The load-bearing one: the bridge withholds an unregistered key.
  check('the bridge advert is gated on swRegistered',
    /const advertise = !!swPubKey && swRegistered;/.test(bg));
  check('and BOTH deviceId and pub are withheld together',
    /deviceId: advertise \? swDeviceId : null,\s*\n\s*pub: advertise \? swPubKey : null,/.test(bg));
  check('both arms of the e2e-pubkey-get reply use the one helper',
    (bg.match(/\.\.\.bridgeIdentityFields\(\)/g) || []).length === 2);
  check('no arm of that reply still spells the raw key fields',
    !/ok: true, v: 1, deviceId: swDeviceId, pub: swPubKey/.test(bg));
  check("the withheld case has its own machine-readable token",
    /return 'not-registered';/.test(bg));
  check('sign-out drops the registration claim', /clearDeviceKeyRegistered\(\)/.test(bg));
  check('registration retries with a BOUNDED backoff ladder',
    /const REGISTER_BACKOFF_MS = \[[\d, ]+\];/.test(bg));
  check('the ladder is single-flight', /if \(registerInFlight\) return registerInFlight;/.test(bg));
  check('a missing token is a retryable reason, not a silent return',
    /retryable: true/.test(bg) && !/if \(!token\) return;/.test(bg));
  check('every trigger uses the retrying entry point',
    (bg.match(/registerDeviceKeyWithRetry\('/g) || []).length >= 3);
  check('the status travels on the presence PORT, not a one-shot sendMessage',
    /for \(const port of presencePorts\) \{\s*\n\s*try \{ port\.postMessage\(msg\); \}/.test(bg));
  check('a surface opening gets the state on its first paint',
    /port\.postMessage\(e2eStatusMessage\(\)\)/.test(bg));
  check('the header copy is the one the brief specifies',
    /extension not verified — sign out and back in/.test(bg));
  check('a 409 pairing_in_flight is NOT surfaced to the user as a fault',
    /deviceKeyRegisterError === 'signed-out'/.test(bg) && /r\.status === 409/.test(bg));
}

// ── 4. the web backstop is WIRED, not merely written ────────────────────────
{
  const hook = readFileSync(join(ROOT, 'hooks', 'useE2e.ts'), 'utf8');
  check('buildRequestE2e reads the live list', /liveRegisteredDeviceIds\(await fetchDeviceKeyList\(\)\)/.test(hook));
  check('and filters the block it is about to send',
    /filterRecipsToLiveRows\(block\.recips, live, key\.deviceId\)/.test(hook));
  check('the filtered list REPLACES the advertised one',
    /block\.recips = filtered\.recips;/.test(hook));
  // Ordering is the property a refactor breaks: a filter applied after the send
  // is a filter that does nothing.
  const build = hook.slice(hook.indexOf('const buildRequestE2e'));
  const filterAt = build.indexOf('filterRecipsToLiveRows');
  const returnAt = build.indexOf('return block;');
  check('the filter runs BEFORE the block is returned to the sender',
    filterAt > 0 && returnAt > 0 && filterAt < returnAt,
    `filter@${filterAt} return@${returnAt}`);

  const relay = readFileSync(join(ROOT, 'server.js'), 'utf8');
  check('the relay LOGS an unregistered recipient', /UNREGISTERED-RECIPIENT/.test(relay));
  check('and does not refuse on it — the log call is not awaited',
    /\n\s*logUnregisteredRecipients\(room, pairingId, e2eBlock\);/.test(relay)
    && !/await logUnregisteredRecipients/.test(relay));

  const auth = readFileSync(join(ROOT, 'lib', 'deviceKeyAuth.ts'), 'utf8');
  check('the extension can authenticate as itself (the CAUSE)',
    /via: 'ext-token'/.test(auth) && /verifyExtensionSessionToken\(bearerToken\)/.test(auth));
  check('and its sessionVersion is re-checked, so sign-out-elsewhere revokes it',
    /tokenVer === user\.sessionVersion/.test(auth));

  const reg = readFileSync(join(ROOT, 'app', 'api', 'devicekeys', 'register', 'route.ts'), 'utf8');
  check("CSRF still applies to the COOKIE path and only the cookie path",
    /caller\.via === 'session'/.test(reg));
}

console.log(`\ne2e-recips-registry: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
