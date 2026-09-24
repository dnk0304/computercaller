/**
 * tests/e2e-setting-availability.test.mjs — T-EXT-E2E-ROW-STANDBY-COPY,
 * T-EXT-E2E-ROW-COPY-WRAP (coherence half) and
 * T-WEB-HEADER-VERIFIED-BEFORE-CONFIRM.
 *
 * ## Why this file exists at all
 *
 * `settingAvailability()` decides whether the Encrypted mode switch can be
 * operated and, when it cannot, which sentence the user is given. It shipped
 * with NO test. Dennis's 2026-09-24 standby screenshot is what a decision
 * function with no test looks like: the phone was sitting in the lobby having
 * said nothing about its capability, and the row asserted "Your phone app needs
 * v58 or newer" — a version verdict, stated as fact, on no evidence. The
 * function's own comment already forbade exactly that ("needs v58 would be a
 * guess presented as a fact"); what was missing was a shape that could hold the
 * difference between a `no` and a silence, and anything that would notice.
 *
 * ## What is driven
 *
 * The REAL `settingAvailability`, `encryptionIndicator` and the REAL copy
 * constants from lib/encryptedModeCopy.ts — never a retyped sentence. Rows come
 * from tests/e2e-setting-availability-vectors.json.
 *
 * The coherence rows additionally drive the SHIPPED predicates of
 * components/EncryptedModeToggle.tsx, sliced out of the component source rather
 * than restated here, so "the switch mirrors the pref, not the effective mode"
 * is proved against the code that renders and not against this file's opinion
 * of it.
 *
 * Run: node tests/e2e-setting-availability.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SETTING_BLOCKED_REASONS,
  SETTING_REPAIR_NOTICE,
  ENCRYPTED_PENDING_LABEL,
  ENCRYPTED_PENDING_DETAIL,
  UPDATE_PHONE,
  settingAvailability,
  encryptionIndicator,
} from '../lib/encryptedModeCopy.ts';
import { E2E_VIEW_INITIAL, viewAfterPairEnded, viewAfterPairEndedDuringSas } from '../hooks/phoneE2e.ts';

const require = createRequire(import.meta.url);
const V = require('./e2e-setting-availability-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** CRLF-safe: .gitattributes pins lib/ and components/ to LF, a fresh checkout may not. */
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// ───────────────────────────────────────────────────────────────────────────
// (a) settingAvailability over the vector rows
// ───────────────────────────────────────────────────────────────────────────
check('vectors: the availability set is non-empty', V.availability.length >= 8,
  `${V.availability.length} rows`);

for (const row of V.availability) {
  const got = settingAvailability(
    { supports: row.peerSupports },
    row.phonePresent,
    row.error,
  );
  eq(`availability ${row.name}: enabled`, got.enabled, row.expect.enabled);
  eq(`availability ${row.name}: reasonKey`, got.reasonKey, row.expect.reasonKey);
  // The SENTENCE is asserted against the exported constant, never a retyped
  // string: a copy edit that this file agreed with in its own words would be
  // a test agreeing with itself.
  eq(`availability ${row.name}: reason is the exported constant`,
    got.reason,
    row.expect.reasonKey === null ? null : SETTING_BLOCKED_REASONS[row.expect.reasonKey]);
}

// The named defect, stated once as a property rather than only as a row: no
// input in which the phone has not answered may produce a version verdict.
for (const phonePresent of [true, false]) {
  const r = settingAvailability({ supports: 'unknown' }, phonePresent);
  check(`'unknown' never yields peerTooOld (phonePresent=${phonePresent})`,
    r.reasonKey !== 'peerTooOld', `got ${r.reasonKey}`);
  check(`'unknown' never claims a version (phonePresent=${phonePresent})`,
    !r.reason.includes('v58'), r.reason);
}
// …and the converse, or the rule above would be satisfied by deleting
// peerTooOld altogether.
eq('an ANSWERED no still yields peerTooOld',
  settingAvailability({ supports: false }, true).reasonKey, 'peerTooOld');
check('peerTooOld is still the sentence that names the version',
  SETTING_BLOCKED_REASONS.peerTooOld.includes('v58'), SETTING_BLOCKED_REASONS.peerTooOld);

// CONTROL: the comparator can go red. Without this the two loops above pass on
// a settingAvailability that returned undefined for everything.
check('CONTROL: a wrong expectation is detected',
  settingAvailability({ supports: true }, true).reasonKey !== 'peerUnknown');
check('CONTROL: peerUnknown and peerTooOld are DIFFERENT sentences',
  SETTING_BLOCKED_REASONS.peerUnknown !== SETTING_BLOCKED_REASONS.peerTooOld);
check('CONTROL: peerUnknown and noPhone are DIFFERENT sentences',
  SETTING_BLOCKED_REASONS.peerUnknown !== SETTING_BLOCKED_REASONS.noPhone);

// ───────────────────────────────────────────────────────────────────────────
// (b) the SEEDS. This is where the defect actually lived: not in the branch,
//     in the value that reached it. Driven against the shipped hook module.
// ───────────────────────────────────────────────────────────────────────────
eq('seed: E2E_VIEW_INITIAL.peer.supports is unknown', E2E_VIEW_INITIAL.peer.supports, 'unknown');
eq('seed: the seeded view in standby reads peerUnknown',
  settingAvailability(E2E_VIEW_INITIAL.peer, true).reasonKey, 'peerUnknown');

const ended = viewAfterPairEnded({
  ...E2E_VIEW_INITIAL, mode: 'on', effective: 'on', state: 'encrypted-verified',
  peer: { supports: true, kind: 'ready' },
});
eq('teardown: a pair that ended returns to unknown, not to a version verdict',
  ended.peer.supports, 'unknown');
eq('teardown: and the row says peerUnknown while the phone is still in the lobby',
  settingAvailability(ended.peer, true).reasonKey, 'peerUnknown');

const endedErr = viewAfterPairEnded({
  ...E2E_VIEW_INITIAL, mode: 'on', effective: 'on', state: 'error', error: 'e2e-key-mismatch',
  peer: { supports: true, kind: 'ready' },
});
eq('teardown (error preserved): supports is unknown', endedErr.peer.supports, 'unknown');
eq('teardown (error preserved): keyChanged still outranks it',
  settingAvailability(endedErr.peer, true, endedErr.error).reasonKey, 'keyChanged');

const endedSas = viewAfterPairEndedDuringSas({
  ...E2E_VIEW_INITIAL, mode: 'on', effective: 'on', state: 'encrypted-verified',
  peer: { supports: true, kind: 'ready' },
});
eq('teardown during SAS: supports is unknown', endedSas.peer.supports, 'unknown');
eq('teardown during SAS: the error is the INC-0924 one', endedSas.error, 'e2e-sas-unconfirmed');

// The one place `false` is still published is a real answer, and the hook says
// so at the call site. Read out of the shipped source, not assumed.
const useE2eSrc = read('hooks/useE2e.ts');
check('hooks/useE2e.ts publishes supports:false on exactly ONE path',
  (useE2eSrc.match(/supports: false/g) || []).length === 1,
  String((useE2eSrc.match(/supports: false/g) || []).length));
check('hooks/useE2e.ts publishes supports:true on exactly ONE path',
  (useE2eSrc.match(/supports: true/g) || []).length === 1,
  String((useE2eSrc.match(/supports: true/g) || []).length));
check('hooks/phoneE2e.ts seeds no boolean supports any more',
  !/supports: false/.test(read('hooks/phoneE2e.ts')));

// ───────────────────────────────────────────────────────────────────────────
// (c) coherence — the switch is the PREF, the notice is the latched pair
//     (§12.2). The predicates are SLICED from the shipped component.
// ───────────────────────────────────────────────────────────────────────────
const toggleSrc = read('components/EncryptedModeToggle.tsx');

// `showRepairNotice` and the two `aria-checked` expressions, taken verbatim.
const noticeLine = toggleSrc.match(/const showRepairNotice = ([^;]+);/);
check('sliced: showRepairNotice found in the component', Boolean(noticeLine));
const showRepairNotice = new Function('mode', 'phone',
  `return (${noticeLine[1]});`);

check('sliced: showRepairNotice reads the LOCAL pref, not view.effective',
  /mode === 'on'/.test(noticeLine[1]) && !/effective/.test(noticeLine[1]), noticeLine[1]);
check('sliced: showRepairNotice reads the LOBBY fact for the latched pair',
  /lobbyState === 'active'/.test(noticeLine[1]), noticeLine[1]);

// Both variants render aria-checked off `mode === 'on'` and NOTHING else. If a
// future edit mirrors view.effective on one surface only, that is the exact
// drift the single-component design exists to prevent.
const ariaChecked = toggleSrc.match(/aria-checked=\{([^}]+)\}/g) || [];
eq('sliced: two surfaces declare aria-checked', ariaChecked.length, 2);
check('sliced: BOTH aria-checked read the pref',
  ariaChecked.every((a) => a.includes("mode === 'on'")), ariaChecked.join(' | '));
check('sliced: NEITHER aria-checked reads view.effective',
  ariaChecked.every((a) => !a.includes('effective')), ariaChecked.join(' | '));

// Both variants publish the SAME decision outward, so a harness (and a user)
// reading one surface is reading the other.
const reasonAttrs = toggleSrc.match(/data-cc-e2e-reason=\{[^}]+\}/g) || [];
eq('sliced: two surfaces publish data-cc-e2e-reason', reasonAttrs.length, 2);
check('sliced: both publish availability.reasonKey and nothing else',
  reasonAttrs.every((a) => a.includes('availability.reasonKey')), reasonAttrs.join(' | '));
const enabledAttrs = toggleSrc.match(/data-cc-e2e-enabled=\{[^}]+\}/g) || [];
eq('sliced: two surfaces publish data-cc-e2e-enabled', enabledAttrs.length, 2);
check('sliced: both publish availability.enabled',
  enabledAttrs.every((a) => a.includes('availability.enabled')), enabledAttrs.join(' | '));

for (const row of V.coherence) {
  const availability = settingAvailability({ supports: row.peerSupports }, row.lobbyState !== 'idle' ? true : true);
  const notice = showRepairNotice(row.mode, { lobbyState: row.lobbyState });
  eq(`coherence ${row.name}: switch reflects the pref`, row.mode === 'on', row.expect.switchChecked);
  eq(`coherence ${row.name}: repair notice`, Boolean(notice), row.expect.repairNotice);
  eq(`coherence ${row.name}: enabled`, availability.enabled, row.expect.enabled);
  if (row.expect.reasonKey !== undefined) {
    eq(`coherence ${row.name}: reasonKey`, availability.reasonKey, row.expect.reasonKey);
  }
  if (row.expect.repairNotice) {
    check(`coherence ${row.name}: the notice is the exported constant`,
      SETTING_REPAIR_NOTICE.length > 0 && toggleSrc.includes('SETTING_REPAIR_NOTICE'));
  }
}
// CONTROL on the slice: the predicate must be able to answer false, or every
// `repairNotice: false` row above is passing on a function that never fires.
check('CONTROL: sliced showRepairNotice fires for on+active',
  showRepairNotice('on', { lobbyState: 'active' }) === true);
check('CONTROL: sliced showRepairNotice does NOT fire for off+active',
  showRepairNotice('off', { lobbyState: 'active' }) === false);

// ───────────────────────────────────────────────────────────────────────────
// (d) the header's verification claim — T-WEB-HEADER-VERIFIED-BEFORE-CONFIRM
// ───────────────────────────────────────────────────────────────────────────
for (const row of V.indicator) {
  const ind = encryptionIndicator({
    state: row.state,
    error: row.error,
    peer: { supports: row.peerSupports },
    ...(row.sas ? { sas: row.sas } : {}),
  });
  eq(`indicator ${row.name}: label`, ind.label, row.expect.label);
  eq(`indicator ${row.name}: lock`, ind.lock, row.expect.lock);
  eq(`indicator ${row.name}: banner`, ind.banner, row.expect.banner);
  if (row.expect.detailMustInclude === 'Update your phone app') {
    // The vector names the sentence; the module owns it. Assert they are the
    // same string rather than letting the row carry a retyped copy.
    eq(`indicator ${row.name}: the vector's phrase IS the exported constant`,
      row.expect.detailMustInclude, UPDATE_PHONE);
  }
  if (row.expect.detailMustInclude) {
    check(`indicator ${row.name}: detail includes "${row.expect.detailMustInclude}"`,
      ind.detail.includes(row.expect.detailMustInclude), ind.detail);
  }
  if (row.expect.detailMustNotInclude) {
    check(`indicator ${row.name}: detail does NOT include "${row.expect.detailMustNotInclude}"`,
      !ind.detail.includes(row.expect.detailMustNotInclude), ind.detail);
  }
}

// Stated as a property: no unconfirmed view, at any error value, may claim the
// user confirmed anything.
for (const confirmed of [false, true]) {
  const ind = encryptionIndicator({
    state: 'encrypted-verified', peer: { supports: true }, sas: { confirmed },
  });
  eq(`SAS confirmed=${confirmed}: claims confirmation only when confirmed`,
    ind.detail.includes('you confirmed'), confirmed);
}
eq('the pending label reuses the existing unverified word',
  ENCRYPTED_PENDING_LABEL, 'Encrypted, unverified');
check('the pending detail still says the traffic IS encrypted',
  ENCRYPTED_PENDING_DETAIL.startsWith('Encrypted'), ENCRYPTED_PENDING_DETAIL);
check('the pending detail names the next act',
  /confirm/i.test(ENCRYPTED_PENDING_DETAIL), ENCRYPTED_PENDING_DETAIL);

// The status component must actually HAND the SAS answer to the copy function,
// or the branch above is dead code on the real surface.
const statusSrc = read('components/EncryptionStatus.tsx');
check('EncryptionStatus carries sas on the view it passes to encryptionIndicator',
  /sas\?:\s*\{\s*confirmed: boolean\s*\}/.test(statusSrc) && /encryptionIndicator\(view\)/.test(statusSrc),
  'E2eLike must declare sas and the whole view must be forwarded');

// CONTROL: the detail strings of the two verified branches differ, or the
// include/exclude arms above would both pass on one string.
check('CONTROL: confirmed and pending details differ',
  encryptionIndicator({ state: 'encrypted-verified', peer: { supports: true }, sas: { confirmed: true } }).detail
  !== ENCRYPTED_PENDING_DETAIL);

// ───────────────────────────────────────────────────────────────────────────
// (e) the CSS half of T-EXT-E2E-ROW-COPY-WRAP, pinned at its source.
//     The clip was a cascade fact, not a component fact: the account menu is a
//     DESCENDANT of .cc-ext-header, whose `*` rule forced white-space: nowrap
//     on everything inside it, and overflow-wrap cannot break a line nowrap
//     forbids. Asserted here because the Playwright proof only runs in the
//     harness lane and this rule is one edit away from coming back.
// ───────────────────────────────────────────────────────────────────────────
const css = read('app/extension/extension.css');
const headerNowrap = css.match(/\.cc-ext \.cc-ext-header \*[^{]*\{ white-space: nowrap; \}/);
check('css: the AC-1 header nowrap rule is still there', Boolean(headerNowrap));
check('css: and it no longer reaches the account menu',
  Boolean(headerNowrap) && headerNowrap[0].includes(':not(.cc-menu, .cc-menu *)'),
  headerNowrap ? headerNowrap[0] : 'rule not found');
check('css: the segmented control keeps its OWN nowrap',
  /\.cc-ext \.cc-menu \[role="menuitemradio"\] \{ white-space: nowrap; \}/.test(css));
check('css: nothing re-declares a nowrap over the whole menu subtree',
  !/\.cc-menu \*\s*\{[^}]*white-space:\s*nowrap/.test(css));
check('component: both helper spans can still wrap',
  (toggleSrc.match(/block break-words/g) || []).length === 2,
  String((toggleSrc.match(/block break-words/g) || []).length));
check('component: the menu flex child has min-w-0 so the text column can shrink',
  /className="min-w-0 flex-1"/.test(toggleSrc));
// CONTROL: the regex above can fail. Without it, a rename of the class makes
// every css arm pass vacuously on a `null` match.
check('CONTROL: the css matcher returns null for a rule that is not there',
  css.match(/\.cc-ext \.cc-not-a-real-class \* \{ white-space: nowrap; \}/) === null);

console.log(`\n${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
