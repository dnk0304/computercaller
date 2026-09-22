#!/usr/bin/env node
/**
 * tests/bat-web-hook.test.mjs — BAT-2 (c): the web app's BATTERY state.
 *
 * `usePhoneBridge.ts` is a 5,000-line React hook that cannot be imported into
 * node, so the DECISION was extracted into `hooks/phoneTypes.ts` as a pure
 * reducer and the hook calls it. That is the same move `inboundDisposition`
 * made on the extension side, for the same reason: a rule that can only be
 * checked by driving a browser is a rule that stops being checked.
 *
 * What this suite asserts:
 *   1. the reducer — set / older-ts ignored / equal-ts ignored / relay-mark
 *      rejected (MUST-2) / shape guards (MUST-3) / unknown keys tolerated but
 *      never stored;
 *   2. PARITY with the service worker's own predicate over one shared table,
 *      because the web and the SW hold two separate implementations of MUST-3
 *      and two implementations drift;
 *   3. the WIRING, read out of the shipped hook: the value is KEPT on
 *      disconnect and nulled on unpair / reset — a claim about placement, so it
 *      is checked against the source, with the ws.onclose branch sliced out and
 *      required to contain no clear;
 *   4. DISPLAY-ONLY — the reducer is given no mode, pairing, tier, quota or
 *      session state, so it cannot touch any of them; asserted on its arity and
 *      on the hook's BATTERY case body.
 *
 * Run: node tests/bat-web-hook.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { reduceBattery, isValidBatteryPayload, carriesRelayMark } from '../hooks/phoneTypes.ts';
import { isValidBatteryPayload as swIsValid } from '../chrome-extension/e2e/sw-session.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = readFileSync(join(ROOT, 'hooks', 'usePhoneBridge.ts'), 'utf8').replace(/\r\n?/g, '\n');
const TYPES = readFileSync(join(ROOT, 'hooks', 'phoneTypes.ts'), 'utf8').replace(/\r\n?/g, '\n');

/** Strip comments so prose describing a rule can never satisfy the rule. */
function stripComments(src) {
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1'))
    .join('\n');
}
const CODE = stripComments(HOOK);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const GOOD = { pct: 47, charging: false, ts: 1_758_531_600_000 };
const STORED = { pct: 47, charging: false, ts: GOOD.ts };

console.log('\ntests/bat-web-hook.test.mjs — BAT-2 (c): the web hook`s BATTERY state\n');

// ── 1. the reducer ─────────────────────────────────────────────────────────

eq('(1) set: the first good frame becomes the value',
  reduceBattery(null, GOOD), { next: STORED, drop: null });

eq('(1) set: a NEWER ts replaces it',
  reduceBattery(STORED, { pct: 46, charging: true, ts: GOOD.ts + 60_000 }),
  { next: { pct: 46, charging: true, ts: GOOD.ts + 60_000 }, drop: null });

eq('(1) an OLDER ts is ignored and the previous value is returned UNCHANGED',
  reduceBattery(STORED, { pct: 99, charging: true, ts: GOOD.ts - 1 }),
  { next: STORED, drop: 'stale' });

eq('(1) an EQUAL ts is ignored (a duplicate is not news)',
  reduceBattery(STORED, { pct: 99, charging: true, ts: GOOD.ts }),
  { next: STORED, drop: 'stale' });

check('(1) the ignored frame returns the SAME object, so the caller can skip setState',
  reduceBattery(STORED, { ...GOOD, pct: 99 }).next === STORED);

eq('(1) MUST-2: a top-level `relay` key is REJECTED, not stripped',
  reduceBattery(null, { ...GOOD, relay: true }), { next: null, drop: 'relay-mark' });

{
  // …and the payload itself is never rewritten.
  const marked = { ...GOOD, relay: true };
  reduceBattery(STORED, marked);
  check('(1) MUST-2: the frame object is left intact (rejected, never stripped)',
    Object.prototype.hasOwnProperty.call(marked, 'relay') && marked.relay === true);
  // Every falsy/odd mark shape, not just `true` — a forged mark is not obliged
  // to look like an honest one.
  for (const mark of [false, null, 0, '', 'x', {}]) {
    eq(`(1) MUST-2: relay:${JSON.stringify(mark)} rejected`,
      reduceBattery(null, { ...GOOD, relay: mark }).drop, 'relay-mark');
  }
  check('(1) MUST-2: an INHERITED `relay` is not a marked frame',
    reduceBattery(null, Object.assign(Object.create({ relay: true }), GOOD)).drop === null);
  check('(1) carriesRelayMark is hasOwnProperty-based',
    carriesRelayMark({ relay: undefined }) === true
    && carriesRelayMark(Object.create({ relay: true })) === false);
}

// MUST-3 — the shape table. Shared with the parity cell below.
const SHAPE_TABLE = [
  [true, 'the frozen shape', GOOD],
  [true, 'pct 0', { pct: 0, charging: true, ts: 1 }],
  [true, 'pct 100', { pct: 100, charging: false, ts: 1 }],
  [true, 'ts 0', { pct: 5, charging: false, ts: 0 }],
  [true, 'a negative ts (a clock before the epoch is still a number)', { pct: 5, charging: false, ts: -1 }],
  [true, 'an unknown extra key', { ...GOOD, temp: 31 }],
  [false, 'pct 47.5', { ...GOOD, pct: 47.5 }],
  [false, 'pct -1', { ...GOOD, pct: -1 }],
  [false, 'pct 101', { ...GOOD, pct: 101 }],
  [false, 'pct "47"', { ...GOOD, pct: '47' }],
  [false, 'pct NaN', { ...GOOD, pct: NaN }],
  [false, 'pct absent', { charging: false, ts: 1 }],
  [false, 'charging 1', { ...GOOD, charging: 1 }],
  [false, 'charging 0', { ...GOOD, charging: 0 }],
  [false, 'charging "true"', { ...GOOD, charging: 'true' }],
  [false, 'charging null', { ...GOOD, charging: null }],
  [false, 'charging absent', { pct: 1, ts: 1 }],
  [false, 'ts "1"', { ...GOOD, ts: '1' }],
  [false, 'ts NaN', { ...GOOD, ts: NaN }],
  [false, 'ts Infinity', { ...GOOD, ts: Infinity }],
  [false, 'ts absent', { pct: 1, charging: false }],
  [false, 'null', null],
  [false, 'undefined', undefined],
  [false, 'an array', [47, false, 1]],
  [false, 'a string', '47'],
  [false, 'a number', 47],
  [false, 'an empty object', {}],
];

for (const [want, label, data] of SHAPE_TABLE) {
  eq(`(1) MUST-3: ${label} -> ${want ? 'valid' : 'refused'}`, isValidBatteryPayload(data), want);
  if (!want) {
    eq(`(1) MUST-3: ${label} -> the reducer drops it on shape`,
      reduceBattery(null, data), { next: null, drop: 'shape' });
  }
}

eq('(1) MUST-3: an unknown extra key is tolerated but NEVER stored',
  reduceBattery(null, { ...GOOD, temp: 31, relayish: 'x' }).next, STORED);

// ── 2. parity with the service worker's predicate ──────────────────────────
{
  // Two separate implementations of one MUST, so they are run over ONE table
  // and required to agree. A difference here is the shape of bug nobody notices
  // until a header renders `"47"%` on one surface and nothing on the other.
  let agree = 0;
  for (const [, label, data] of SHAPE_TABLE) {
    const w = isValidBatteryPayload(data);
    const s = swIsValid(data);
    check(`(2) parity web==SW for ${label}`, w === s, `web=${w} sw=${s}`);
    if (w === s) agree++;
  }
  eq('(2) every row in the table agreed', agree, SHAPE_TABLE.length);
  check('(2) the parity cell is not vacuous — the table has both verdicts',
    SHAPE_TABLE.some(([w]) => w) && SHAPE_TABLE.some(([w]) => !w));
}

// ── 3. the wiring, read out of the shipped hook ────────────────────────────

check('(3) the hook declares the battery state', /const \[battery, setBattery\] = useState<PhoneBattery \| null>\(null\)/.test(CODE));
check('(3) the frame union carries BATTERY', /\|\s*'BATTERY'/.test(stripComments(TYPES)));
check('(3) the hook handles case BATTERY through the pure reducer',
  /case 'BATTERY':[\s\S]{0,400}?reduceBattery\(prev, payload\)/.test(CODE));
check('(3) the hook exposes `battery` beside phoneName',
  /isConnected,\s*\n\s*isBridgeConnected,\s*\n\s*phoneName,\s*\n\s*battery,/.test(CODE));

{
  // KEEP on disconnect. The claim is about ONE branch, so that branch is sliced
  // out and required to contain no clear — a file-wide grep would be satisfied
  // by the three legitimate clears elsewhere and could never go red.
  const at = CODE.indexOf('ws.onclose = (event: CloseEvent) => {');
  check('(3) the ws.onclose branch was found', at > 0);
  // Walk to the end of the handler by brace balance, so the slice is the whole
  // branch rather than a fixed window that a later edit could outgrow.
  let depth = 0, end = -1;
  for (let j = CODE.indexOf('{', at); j < CODE.length; j++) {
    if (CODE[j] === '{') depth++;
    else if (CODE[j] === '}' && --depth === 0) { end = j; break; }
  }
  check('(3) the ws.onclose branch is brace-balanced', end > at);
  const onclose = CODE.slice(at, end);
  check('(3) DISCONNECT KEEPS the value — no clear in the ws.onclose branch',
    !/setBattery\(/.test(onclose), 'a setBattery call is present in ws.onclose');
  // The control: that branch really is the disconnect path, and it really does
  // clear the neighbouring state. Without this, an extractor that sliced an
  // empty region would satisfy the assertion above for free.
  check('(3) control: the sliced branch IS the disconnect path',
    /setPhoneName\(null\)/.test(onclose) && /setIsBridgeConnected\(false\)/.test(onclose));
}

{
  // NULL on unpair / reset. Three sites, named: the PAIRING_TERMINATED frame,
  // the explicit leaveActive() unpair, and resetRoom().
  const clears = [...CODE.matchAll(/setBattery\(null\)/g)].length;
  eq('(3) exactly three clear sites', clears, 3);
  const site = (anchor, window = 1400) => {
    const at = CODE.indexOf(anchor);
    return at > 0 && CODE.slice(at, at + window).includes('setBattery(null)');
  };
  check('(3) UNPAIR: the PAIRING_TERMINATED branch clears it', site("case 'PAIRING_TERMINATED': {"));
  check('(3) UNPAIR: leaveActive() clears it', site('const leaveActive = useCallback('));
  check('(3) RESET: resetRoom() clears it', site('const resetRoom = useCallback(', 2200));
}

// ── 4. display-only ────────────────────────────────────────────────────────

eq('(4) the reducer takes exactly (prev, data) — it is given no other state',
  reduceBattery.length, 2);

{
  const at = CODE.indexOf("case 'BATTERY': {");
  check('(4) the BATTERY case was found', at > 0);
  const body = CODE.slice(at, CODE.indexOf('break;', at));
  check('(4) the BATTERY case touches nothing but its own state',
    !/setLobbyState|setIsConnected|setPhoneName|setPermissionsStatus|setTier|setQuota|e2eRef|setPairing/.test(body),
    `case body: ${body.trim()}`);
  check('(4) …and it uses the FUNCTIONAL setState form, so a batch cannot lose the newest',
    /setBattery\(\(prev\) =>/.test(body));
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\nbat-web-hook: ${pass}/${pass + fail} checks passed`);
if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
