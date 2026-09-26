/**
 * tests/e2e-conn-truth.test.mjs — #18 CONN-STATUS (Pixel).
 *
 * Drives the REAL lib/connectionTruth.ts: the four states, the rule that the
 * preference can never produce an "Encrypted" word, the settle rule, the
 * switch tracker's start/end edges, idempotency, and the SAS-screen gate.
 * Plus source pins that the three surfaces actually read the selector.
 *
 * Run: node tests/e2e-conn-truth.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONN_TRUTH_LABELS,
  SWITCH_MAX_MS,
  connectionTruth,
  initialSwitchTrack,
  nextSwitchTrack,
  pairTruth,
  prefSignature,
  sameTrack,
  sasScreenApplies,
} from '../lib/connectionTruth.ts';
import { sasIsBlocking, SETTING_DESCRIPTION } from '../lib/encryptedModeCopy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── views as hooks/useE2e.ts publishes them ─────────────────────────────────
const V = (o = {}) => ({
  mode: 'off', effective: 'off', state: 'unencrypted',
  sas: { digits: null, confirmed: false }, ...o,
});
const MODE0 = () => V();                                                      // no block: legacy phone
const M1_OFF = () => V({ mode: 'on', effective: 'off', state: 'encrypted-unverified', sas: { digits: '31644', confirmed: false } });
const M1_ON_PENDING = () => V({ mode: 'on', effective: 'on', state: 'encrypted-verified', sas: { digits: '31644', confirmed: false } });
const M1_ON_CONFIRMED = () => V({ mode: 'on', effective: 'on', state: 'encrypted-verified', sas: { digits: '31644', confirmed: true } });
const ERR = () => V({ mode: 'on', effective: 'on', state: 'error', sas: { digits: null, confirmed: false } });
const SETTLED = { switching: false, settled: true };

// ── 1. the four labels ──────────────────────────────────────────────────────
eq('label: codes checked', CONN_TRUTH_LABELS['codes-checked'], 'Encrypted, codes checked');
eq('label: no code check', CONN_TRUTH_LABELS['no-code-check'], 'Encrypted, no code check');
eq('label: standard', CONN_TRUTH_LABELS.standard, 'Standard (TLS)');
eq('label: switching', CONN_TRUTH_LABELS.switching, 'Switching… reconnecting');

// ── 2. each state from the live pair ────────────────────────────────────────
eq('state 1: sealed + confirmed -> codes-checked', connectionTruth(SETTLED, M1_ON_CONFIRMED(), true)?.key, 'codes-checked');
eq('state 1: auto-confirmed (known digits) counts', pairTruth({ ...M1_ON_PENDING(), sas: { digits: '31644', confirmed: true } }, true, true), 'codes-checked');
eq('state 2: sealed, switch OFF -> no-code-check', connectionTruth(SETTLED, M1_OFF(), true)?.key, 'no-code-check');
eq('state 2: sealed, code not yet answered -> no-code-check', connectionTruth(SETTLED, M1_ON_PENDING(), true)?.key, 'no-code-check');
eq('state 3: unsealed pair -> standard', connectionTruth(SETTLED, MODE0(), true)?.key, 'standard');
eq('state 4: switching wins over any pair', connectionTruth({ switching: true, settled: true }, M1_ON_CONFIRMED(), true)?.key, 'switching');
eq('state 4: switching while disconnected', connectionTruth({ switching: true, settled: true }, MODE0(), false)?.key, 'switching');
check('lock only on the two sealed states',
  connectionTruth(SETTLED, M1_ON_CONFIRMED(), true).lock && connectionTruth(SETTLED, M1_OFF(), true).lock
  && !connectionTruth(SETTLED, MODE0(), true).lock && !connectionTruth({ switching: true, settled: true }, MODE0(), true).lock);

// ── 3. not ours to say ──────────────────────────────────────────────────────
eq('no pair -> null (existing disconnected copy stays)', connectionTruth(SETTLED, M1_ON_CONFIRMED(), false), null);
eq('e2e error -> null (the banner owns it)', connectionTruth(SETTLED, ERR(), true), null);
eq('unsettled pair -> null (old view not trusted)', connectionTruth({ switching: false, settled: false }, M1_ON_CONFIRMED(), true), null);
eq('mode on but state unencrypted is NOT sealed', pairTruth(V({ mode: 'on', state: 'unencrypted' }), true, true), 'standard');

// ── 4. pref ON + pair mode0 never reads "Encrypted" ─────────────────────────
// The decision takes no preference at all; prove it by driving the tracker
// with an ON preference and an unsealed pair through every phase.
{
  let t = initialSwitchTrack();
  const words = [];
  const pairView = MODE0();
  const steps = [
    { prefSig: '1|off|0', writePhase: 'idle', pairActive: true, view: pairView },
    { prefSig: '1|off|0', writePhase: 'saving', pairActive: true, view: pairView },
    { prefSig: '2|on|0', writePhase: 'saving', pairActive: true, view: pairView },
    { prefSig: '2|on|0', writePhase: 'reconnecting', pairActive: false, view: pairView },
    { prefSig: '2|on|0', writePhase: 'reconnecting', pairActive: true, view: pairView },
    { prefSig: '2|on|0', writePhase: 'reconnecting', pairActive: true, view: MODE0() },
    { prefSig: '2|on|0', writePhase: 'idle', pairActive: true, view: MODE0() },
  ];
  steps.forEach((s, i) => {
    t = nextSwitchTrack(t, { ...s, now: 1000 + i });
    const truth = connectionTruth(t, s.view, s.pairActive);
    words.push(truth ? truth.label : '(none)');
  });
  check('pref ON + mode0: no step reads "Encrypted"', words.every((w) => !/^Encrypted/.test(w)), words.join(' | '));
  eq('pref ON + mode0: walk = Standard, Switching x3, (unsettled), Standard, Standard',
    words, ['Standard (TLS)', 'Switching… reconnecting', 'Switching… reconnecting', 'Switching… reconnecting',
      'Switching… reconnecting', 'Standard (TLS)', 'Standard (TLS)']);
}

// ── 5. the full toggle walk OFF -> ON on a sealed pair ──────────────────────
{
  let t = initialSwitchTrack();
  let now = 0;
  const step = (s) => { t = nextSwitchTrack(t, { ...s, now: (now += 10) }); return connectionTruth(t, s.view, s.pairActive)?.key ?? null; };
  const oldPair = M1_OFF();
  eq('walk: baseline no-code-check', step({ prefSig: '3|off|0', writePhase: 'idle', pairActive: true, view: oldPair }), 'no-code-check');
  eq('walk: write sent -> switching', step({ prefSig: '3|off|0', writePhase: 'saving', pairActive: true, view: oldPair }), 'switching');
  eq('walk: 4010 drop -> switching', step({ prefSig: '4|on|0', writePhase: 'reconnecting', pairActive: false, view: oldPair }), 'switching');
  eq('walk: lobby active, accept not landed (stale view) -> switching', step({ prefSig: '4|on|0', writePhase: 'reconnecting', pairActive: true, view: oldPair }), 'switching');
  const newPair = M1_ON_PENDING();
  eq('walk: accept lands, code pending -> no-code-check', step({ prefSig: '4|on|0', writePhase: 'reconnecting', pairActive: true, view: newPair }), 'no-code-check');
  eq('walk: code confirmed -> codes-checked', step({ prefSig: '4|on|0', writePhase: 'idle', pairActive: true, view: M1_ON_CONFIRMED() }), 'codes-checked');
}

// ── 6. a change RECEIVED from another device (push, new rev) ────────────────
{
  let t = initialSwitchTrack();
  const pair = M1_ON_CONFIRMED();
  t = nextSwitchTrack(t, { prefSig: '5|on|0', writePhase: 'idle', pairActive: true, view: pair, now: 1 });
  t = nextSwitchTrack(t, { prefSig: '6|off|0', writePhase: 'idle', pairActive: true, view: pair, now: 2 });
  eq('push new rev on a live pair -> switching', connectionTruth(t, pair, true)?.key, 'switching');
  t = nextSwitchTrack(t, { prefSig: '6|off|0', writePhase: 'idle', pairActive: true, view: pair, now: 3 });
  eq('...and it waits for the drop (no drop yet)', connectionTruth(t, pair, true)?.key, 'switching');
  t = nextSwitchTrack(t, { prefSig: '6|off|0', writePhase: 'idle', pairActive: false, view: pair, now: 4 });
  const fresh = M1_OFF();
  t = nextSwitchTrack(t, { prefSig: '6|off|0', writePhase: 'idle', pairActive: true, view: fresh, now: 5 });
  eq('next pair (accept in the same render as the edge) resolves', connectionTruth(t, fresh, true)?.key, 'no-code-check');
  // same-rev push on every connect is NOT a switch
  const t2 = nextSwitchTrack(t, { prefSig: '6|off|0', writePhase: 'idle', pairActive: true, view: fresh, now: 6 });
  check('same-rev push is not a switch', !t2.switching);
  // first authoritative answer is a baseline, not a change
  let t3 = initialSwitchTrack();
  t3 = nextSwitchTrack(t3, { prefSig: null, writePhase: 'idle', pairActive: false, view: fresh, now: 1 });
  t3 = nextSwitchTrack(t3, { prefSig: '9|on|0', writePhase: 'idle', pairActive: false, view: fresh, now: 2 });
  check('first authoritative value after load is a baseline, not a switch', !t3.switching);
  eq('prefSignature is null until authoritative', prefSignature(false, { rev: 1, effective: 'on', pausedByServer: false }), null);
  eq('prefSignature carries rev + master fields', prefSignature(true, { rev: 7, effective: 'off', pausedByServer: true }), '7|off|1');
}

// ── 7. switch ends: failed write, timeout ───────────────────────────────────
{
  let t = initialSwitchTrack();
  const pair = M1_OFF();
  t = nextSwitchTrack(t, { prefSig: '1|off|0', writePhase: 'idle', pairActive: true, view: pair, now: 1 });
  t = nextSwitchTrack(t, { prefSig: '1|off|0', writePhase: 'saving', pairActive: true, view: pair, now: 2 });
  check('write in flight -> switching', t.switching);
  t = nextSwitchTrack(t, { prefSig: '1|off|0', writePhase: 'idle', pairActive: true, view: pair, now: 3 });
  check('write refused (no rev change, no drop) -> back to the pair truth', !t.switching);
  eq('...which is the unchanged pair', connectionTruth(t, pair, true)?.key, 'no-code-check');

  let u = initialSwitchTrack();
  u = nextSwitchTrack(u, { prefSig: '1|off|0', writePhase: 'idle', pairActive: false, view: pair, now: 0 });
  u = nextSwitchTrack(u, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: pair, now: 10 });
  check('change while disconnected -> switching', u.switching);
  u = nextSwitchTrack(u, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: pair, now: 10 + SWITCH_MAX_MS - 1 });
  check('...still switching just before the cap', u.switching);
  u = nextSwitchTrack(u, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: pair, now: 10 + SWITCH_MAX_MS + 1 });
  check('...and never past the cap (no phone ever came back)', !u.switching);
  const r = nextSwitchTrack(u, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: pair, now: 0 });
  check('render-time now:0 never expires or restarts a switch', !r.switching);
}

// ── 8. idempotency (several components feed the same input) ─────────────────
{
  const inputs = [
    { prefSig: '1|off|0', writePhase: 'idle', pairActive: false, view: MODE0() },
    { prefSig: '1|off|0', writePhase: 'saving', pairActive: false, view: MODE0() },
    { prefSig: '2|on|0', writePhase: 'reconnecting', pairActive: true, view: MODE0() },
    { prefSig: '2|on|0', writePhase: 'reconnecting', pairActive: true, view: M1_ON_PENDING() },
  ];
  let t = initialSwitchTrack();
  let allIdem = true;
  inputs.forEach((inp, i) => {
    const once = nextSwitchTrack(t, { ...inp, now: i + 1 });
    const twice = nextSwitchTrack(once, { ...inp, now: i + 1 });
    if (!sameTrack(once, twice)) allIdem = false;
    t = once;
  });
  check('nextSwitchTrack is idempotent at every edge', allIdem);
}

// ── 9. SAS screen gating ────────────────────────────────────────────────────
{
  const pend = M1_ON_PENDING();
  check('SAS: sealed + pending + effective ON -> applies', sasScreenApplies(SETTLED, pend, true, sasIsBlocking(pend)));
  check('SAS: never on a mode0 pair', !sasScreenApplies(SETTLED, V({ effective: 'on', sas: { digits: '31644', confirmed: false } }), true, true));
  check('SAS: never once confirmed', !sasScreenApplies(SETTLED, M1_ON_CONFIRMED(), true, sasIsBlocking(M1_ON_CONFIRMED())));
  check('SAS: never when effective OFF (sasIsBlocking false)', !sasScreenApplies(SETTLED, M1_OFF(), true, sasIsBlocking(M1_OFF())));
  check('SAS: dismissed when the pair drops', !sasScreenApplies(SETTLED, pend, false, true));
  check('SAS: dismissed while reconnecting (stale view, unsettled)', !sasScreenApplies({ switching: false, settled: false }, pend, true, true));
  check('SAS: dismissed while switching', !sasScreenApplies({ switching: true, settled: true }, pend, true, true));
  // the stale-digits case end to end through the tracker
  let t = initialSwitchTrack();
  t = nextSwitchTrack(t, { prefSig: '1|on|0', writePhase: 'idle', pairActive: true, view: pend, now: 1 });
  t = nextSwitchTrack(t, { prefSig: '1|on|0', writePhase: 'idle', pairActive: false, view: pend, now: 2 });
  t = nextSwitchTrack(t, { prefSig: '1|on|0', writePhase: 'idle', pairActive: true, view: pend, now: 3 });
  check('SAS: reconnect with the old view still on screen -> hidden', !sasScreenApplies(t, pend, true, true));
  const next = M1_ON_PENDING();
  t = nextSwitchTrack(t, { prefSig: '1|on|0', writePhase: 'idle', pairActive: true, view: next, now: 4 });
  check('SAS: ...shown again once the new accept publishes', sasScreenApplies(t, next, true, true));
  let first = initialSwitchTrack();
  first = nextSwitchTrack(first, { prefSig: null, writePhase: 'idle', pairActive: true, view: pend, now: 1 });
  check('SAS: a surface mounted mid-pair is not stuck hidden (primed settled)', sasScreenApplies(first, pend, true, true));
}

// ── 9b. Forge's arm-18 sequence (deploy/18 gate, 2026-09-26) ────────────────
// Sealed mode-0 pair -> E2E_PREF push rev2 on the LIVE pair -> PAIRING_TERMINATED
// (onPairEnded publishes a fresh initial view) -> PAIRING_ACTIVE for the next
// pair (lobby active before the async accept) -> accept publishes. The gate's
// red was NOT this tracker: its second pair reused pairEpoch 1n, useE2e's
// epoch floor refused it (e2e-epoch-replayed), no pair ever came up, and
// "Switching…" was the truth. These vectors pin both outcomes.
{
  const walk = (acceptView) => {
    let t = initialSwitchTrack();
    const out = [];
    const oldPair = M1_OFF();
    const initAfterEnd = MODE0();
    const seq = [
      { prefSig: '1|off|0', writePhase: 'idle', pairActive: true, view: oldPair },
      { prefSig: '2|on|0', writePhase: 'idle', pairActive: true, view: oldPair },
      { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: initAfterEnd },
      { prefSig: '2|on|0', writePhase: 'idle', pairActive: true, view: initAfterEnd },
      { prefSig: '2|on|0', writePhase: 'idle', pairActive: true, view: acceptView },
    ];
    let idem = true;
    seq.forEach((inp, i) => {
      const once = nextSwitchTrack(t, { ...inp, now: 1000 + i });
      if (!sameTrack(once, nextSwitchTrack(once, { ...inp, now: 1000 + i }))) idem = false;
      t = once;
      out.push({ key: connectionTruth(t, inp.view, inp.pairActive)?.key ?? null, sas: sasScreenApplies(t, inp.view, inp.pairActive, sasIsBlocking(inp.view)) });
    });
    return { t, out, idem };
  };
  const on = walk(M1_ON_PENDING());
  eq('arm18 mode=1: no-code-check, switching x3, then the new pair label',
    on.out.map((o) => o.key), ['no-code-check', 'switching', 'switching', 'switching', 'no-code-check']);
  check('arm18 mode=1: SAS screen applies once the new sealed pair publishes', on.out[4].sas);
  check('arm18 mode=1: SAS never applies while switching', on.out.slice(1, 4).every((o) => !o.sas));
  check('arm18 mode=1: switch ended, track idempotent at every step', !on.t.switching && on.idem);
  const off = walk(MODE0());
  eq('arm18 mode=0: the new unsealed pair resolves to "Standard (TLS)"', off.out[4].key, 'standard');
  check('arm18 mode=0: no SAS screen on an unsealed pair', !off.out[4].sas);
  check('arm18 mode=0: idempotent', off.idem);

  // The gate's actual run: the replayed-epoch pair is refused. The lobby may
  // blink active, the accept fails with state:error, the pair is abandoned.
  let t = initialSwitchTrack();
  const oldPair = M1_OFF();
  const init = MODE0();
  t = nextSwitchTrack(t, { prefSig: '1|off|0', writePhase: 'idle', pairActive: true, view: oldPair, now: 0 });
  t = nextSwitchTrack(t, { prefSig: '2|on|0', writePhase: 'idle', pairActive: true, view: oldPair, now: 10 });
  t = nextSwitchTrack(t, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: init, now: 20 });
  const refused = ERR();
  t = nextSwitchTrack(t, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: refused, now: 30 });
  eq('refused next pair (epoch replay): still "Switching…" - no new pair exists', connectionTruth(t, refused, false)?.key, 'switching');
  check('refused next pair: no SAS screen', !sasScreenApplies(t, refused, false, true));
  t = nextSwitchTrack(t, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: refused, now: 10 + SWITCH_MAX_MS - 1 });
  check('refused next pair: switching until just before the 30 s cap', t.switching);
  t = nextSwitchTrack(t, { prefSig: '2|on|0', writePhase: 'idle', pairActive: false, view: refused, now: 10 + SWITCH_MAX_MS + 1 });
  check('refused next pair: the 30 s give-up still fires', !t.switching);
  eq('...and then it is not ours to say (no pair)', connectionTruth(t, refused, false), null);
}

// ── 10. copy + wiring pins ──────────────────────────────────────────────────
check('setting description: no longer "Scrambles"', !/Scrambl/i.test(SETTING_DESCRIPTION), SETTING_DESCRIPTION);
check('setting description: phone row_encrypted_mode_sub verbatim', SETTING_DESCRIPTION === "Always encrypted. Turn on to also match a code on both screens, so you know it's really your computer.", SETTING_DESCRIPTION);
const chipSrc = read('components/EncryptionStatus.tsx');
check('chip reads useConnectionTruth', /useConnectionTruth\(\)/.test(chipSrc));
check('chip is aria-live polite', /aria-live="polite"\s+aria-atomic="true"/.test(chipSrc));
const toggleSrc = read('components/EncryptedModeToggle.tsx');
check('settings row reads useConnectionTruth', /useConnectionTruth\(\)/.test(toggleSrc) && /data-cc-conn-truth=\{truth\.key\}/.test(toggleSrc));
const dialogSrc = read('components/SasConfirmDialog.tsx');
check('SAS dialog opens only when sasApplies', /blocking && sasApplies && decision === 'pending'/.test(dialogSrc));
const libSrc = read('lib/connectionTruth.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('the decision never reads the preference VALUE', !/preference/.test(libSrc));
// CONTROL: a planted pref-driven label would be caught by section 4's walk.
{
  const planted = (view, pairActive, prefOn) => (prefOn ? 'codes-checked' : pairTruth(view, pairActive, true));
  check('CONTROL: a pref-driven label WOULD read "Encrypted" on a mode0 pair',
    /^Encrypted/.test(CONN_TRUTH_LABELS[planted(MODE0(), true, true)]));
}
{
  const before = failed;
  check('self-test (DELIBERATE - the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-conn-truth: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
