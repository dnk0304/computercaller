/**
 * auto-sync-proof — dispatch FORGE-U (2026-09-17).
 *
 * Proves the auto-sync-on-connect behaviour on BOTH surfaces:
 *   (a) a fresh PAIRING_ACTIVE issues EXACTLY three GET_* frames, `since` = the
 *       30-day default clamped by the tier;
 *   (b) a resume the relay held (survivorHeld=true) issues ZERO;
 *   (c) a reconnect inside the same pair epoch issues ZERO, a new epoch three;
 *   (d) the 7 / 90 day setting moves `since`, and an over-cap option is locked;
 *   (e) a contactSync:false tier issues TWO frames, not three;
 *   (f) the progress bar is raised while the run is pending and lowered after;
 *   (g) the connect flow no longer opens SyncSetupPanel, and "Sync now" is
 *       present in BOTH settings surfaces.
 *
 * (a)–(e) call lib/autoSync.ts directly — that module IS the decision, so this
 * is the behaviour, not a model of it. (f) and (g) are wiring facts that live
 * in the hook and two components, so they are asserted against SOURCE with
 * every comment stripped first: a grep that can be satisfied by the prose
 * describing the invariant proves nothing about the code.
 *
 * Run: bun scripts/auto-sync-proof.mjs     (bun resolves the TS + the @/ alias)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decideAutoSync,
  DEFAULT_SYNC_RANGE_DAYS,
  isRangeOptionLocked,
  SYNC_RANGE_DAY_OPTIONS,
  tierMaxSyncDays,
} from '../lib/autoSync.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_758_000_000_000; // fixed clock — `since` must be exact, not approximate

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Strip comments so an assertion can never be satisfied by the sentence that
 * describes it. Block comments, line comments and JSX `{/* … *\/}` blocks all
 * go; string literals containing "//" are rare enough in these files that the
 * naive line-comment strip is safe, and it errs toward LESS text, not more.
 */
function code(relPath) {
  const raw = readFileSync(join(ROOT, relPath), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

// Tier limit fixtures, copied in shape from lib/tiers-core.js TIER_LIMITS.
const PLUS = { syncRangeMax: '3mo', contactSync: true };   // 90 d cap
const TRIAL = { syncRangeMax: '3d', contactSync: true };   //  3 d cap
const LEGACY_SOLO = { syncRangeMax: '30d', contactSync: false }; // 30 d, no contacts

const base = { epochKey: 'pixel#0', lastEpochKey: null, nowMs: NOW };

console.log('\n(a) fresh PAIRING_ACTIVE → three frames at the 30-day default');
{
  const d = decideAutoSync({ ...base, limits: PLUS, userDays: DEFAULT_SYNC_RANGE_DAYS });
  check('runs', d.run === true);
  check('exactly three frames', d.run && d.frames.length === 3, d.run && `got ${d.frames.length}`);
  check(
    'frames are GET_CONTACTS, GET_MESSAGES, GET_CALL_LOGS in that order',
    d.run &&
      d.frames[0] === 'GET_CONTACTS:{}' &&
      d.frames[1].startsWith('GET_MESSAGES:') &&
      d.frames[2].startsWith('GET_CALL_LOGS:'),
  );
  check('default window is 30 days', d.run && d.days === 30);
  check('since = now − 30d exactly', d.run && d.since === NOW - 30 * DAY, d.run && String(d.since));
  check(
    'both history frames carry the same since',
    d.run &&
      JSON.parse(d.frames[1].slice('GET_MESSAGES:'.length)).since === NOW - 30 * DAY &&
      JSON.parse(d.frames[2].slice('GET_CALL_LOGS:'.length)).since === NOW - 30 * DAY,
  );
  check('not reported as plan-clamped on a 90-day tier', d.run && d.clampedByPlan === false);
}

console.log('\n(a2) the tier clamps the default down when it is narrower');
{
  const d = decideAutoSync({ ...base, limits: TRIAL, userDays: DEFAULT_SYNC_RANGE_DAYS });
  check('trial tier caps at 3 days', tierMaxSyncDays(TRIAL) === 3);
  check('since = now − 3d, not 30d', d.run && d.since === NOW - 3 * DAY);
  check('reported as plan-clamped', d.run && d.clampedByPlan === true);
  check('still three frames', d.run && d.frames.length === 3);
}

console.log('\n(b) survivorHeld=true resume → zero frames');
{
  const d = decideAutoSync({ ...base, resumed: true, held: true, limits: PLUS, userDays: 30 });
  check('does not run', d.run === false);
  check('reason is survivor-held', d.run === false && d.reason === 'survivor-held');

  const dFalse = decideAutoSync({ ...base, resumed: true, held: false, limits: PLUS, userDays: 30 });
  check('survivorHeld=false resume DOES run (data was not held)', dFalse.run === true);
  check('…with the full three frames', dFalse.run && dFalse.frames.length === 3);

  const dUnknown = decideAutoSync({ ...base, resumed: true, limits: PLUS, userDays: 30 });
  check('resume with `held` absent is treated as held (no surprise full sync)', dUnknown.run === false);
}

console.log('\n(c) idempotent per (pair, epoch)');
{
  const same = decideAutoSync({ ...base, lastEpochKey: 'pixel#0', limits: PLUS, userDays: 30 });
  check('same epoch key → zero frames', same.run === false);
  check('reason is already-synced-this-epoch', same.run === false && same.reason === 'already-synced-this-epoch');

  const next = decideAutoSync({ ...base, epochKey: 'pixel#1', lastEpochKey: 'pixel#0', limits: PLUS, userDays: 30 });
  check('new epoch → three frames', next.run && next.frames.length === 3);

  const otherPhone = decideAutoSync({ ...base, epochKey: 'iphone#0', lastEpochKey: 'pixel#0', limits: PLUS, userDays: 30 });
  check('a different phone in the same epoch counter → three frames', otherPhone.run && otherPhone.frames.length === 3);
}

console.log('\n(d) the Sync range setting moves `since`; over-cap options lock');
{
  check('options are exactly 7 / 30 / 90', SYNC_RANGE_DAY_OPTIONS.join(',') === '7,30,90');
  const d7 = decideAutoSync({ ...base, limits: PLUS, userDays: 7 });
  const d90 = decideAutoSync({ ...base, limits: PLUS, userDays: 90 });
  check('7-day setting → since = now − 7d', d7.run && d7.since === NOW - 7 * DAY);
  check('90-day setting → since = now − 90d on a 90-day tier', d90.run && d90.since === NOW - 90 * DAY);
  check('90 is NOT locked on a 3mo tier', isRangeOptionLocked(90, PLUS) === false);
  check('90 IS locked on a 30d tier', isRangeOptionLocked(90, LEGACY_SOLO) === true);
  check('30 is NOT locked on a 30d tier', isRangeOptionLocked(30, LEGACY_SOLO) === false);
  check('even the narrowest option locks on a 3-day trial tier', isRangeOptionLocked(7, TRIAL) === true);
  const d90solo = decideAutoSync({ ...base, limits: LEGACY_SOLO, userDays: 90 });
  check('picking a locked option still cannot out-ask the tier', d90solo.run && d90solo.since === NOW - 30 * DAY);
}

console.log('\n(e) contactSync:false tier → two frames');
{
  const d = decideAutoSync({ ...base, limits: LEGACY_SOLO, userDays: 30 });
  check('exactly two frames', d.run && d.frames.length === 2, d.run && String(d.frames.length));
  check('no GET_CONTACTS', d.run && !d.frames.some((f) => f.startsWith('GET_CONTACTS')));
  check('messages + call logs still go', d.run && d.frames[0].startsWith('GET_MESSAGES:') && d.frames[1].startsWith('GET_CALL_LOGS:'));

  const unknown = decideAutoSync({ ...base, limits: null, userDays: 30 });
  check('unknown limits still ASK for contacts (the relay decides)', unknown.run && unknown.frames.length === 3);
  check('unknown limits fail closed to a 30-day window', unknown.run && unknown.since === NOW - 30 * DAY);
}

console.log('\n(f) the progress bar is raised during the run and lowered after');
{
  const hook = code('hooks/usePhoneBridge.ts');
  const bar = code('components/SyncProgressBar.tsx');
  check('the auto-sync run raises the quiet bar', /setQuietSyncing\(true\)/.test(hook));
  check('the run teardown lowers it', /endAutoSyncRun\s*=\s*useCallback\([\s\S]{0,600}?setQuietSyncing\(false\)/.test(hook));
  check('teardown also clears the plan-limited line', /endAutoSyncRun\s*=\s*useCallback\([\s\S]{0,600}?setSyncLimitedByPlan\(false\)/.test(hook));
  check('the bar renders its quiet state off quietSyncing', /showQuiet\s*=[^;]*quietSyncing/.test(bar));
  check('the bar can show the plan-limited line', /SYNC_LIMITED_BY_PLAN/.test(bar));
  check('"Sync now" tears down through the same teardown', /syncNow[\s\S]{0,1400}?endAutoSyncRun\(\)/.test(hook));
}

console.log('\n(g) no SyncSetupPanel in the connect flow; "Sync now" in Settings');
{
  const hook = code('hooks/usePhoneBridge.ts');
  check(
    'nothing opens the sync panel on the lobby→active edge any more',
    !/lobbyState\s*===\s*'active'[\s\S]{0,200}setShowSyncPanel\(true\)/.test(hook),
  );
  check(
    'setShowSyncPanel(true) survives ONLY behind the explicit openSyncPanel action',
    (hook.match(/setShowSyncPanel\(true\)/g) || []).length === 1 &&
      /openSyncPanel\s*=\s*useCallback\(\(\)\s*=>\s*setShowSyncPanel\(true\)/.test(hook),
  );
  check('the hook exposes syncNow', /\bsyncNow,/.test(hook) && /const syncNow = useCallback/.test(hook));

  const appSettings = code('app/app/settings/page.tsx');
  const extHeader = code('components/PhoneModeHeader.tsx');
  const control = code('components/SyncRangeSetting.tsx');
  check('/app settings mounts SyncRangeSetting', /<SyncRangeSetting\b/.test(appSettings));
  check('the extension account menu mounts SyncRangeSetting', /<SyncRangeSetting\b/.test(extHeader));
  check('both surfaces render the SAME component', /from '@\/components\/SyncRangeSetting'/.test(appSettings) && /from '@\/components\/SyncRangeSetting'/.test(extHeader));
  check('the control offers a "Sync now" action', /Sync now/.test(control) && /phone\?\.syncNow\?\.\(\)/.test(control));
  check('its labels come from the shared option list', /SYNC_RANGE_DAY_OPTIONS\.map/.test(control));
  check('an over-cap option is rendered disabled', /disabled=\{locked\}/.test(control));
  check('the lock reason is pricing copy, not new copy', /syncWords\(/.test(control));
  check('changing the range does NOT refetch', !/choose[\s\S]{0,200}syncNow/.test(control));
  check(
    'the shared control survives a surface with no PhoneProvider',
    /usePhoneOptional\(\)/.test(control) && !/usePhone\(\)/.test(control),
  );
}

console.log('\n(h) the relay is untouched and still the authority');
{
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
  check('gateBrowserSyncFrame still present', /function gateBrowserSyncFrame\(/.test(server));
  check('it still clamps `since` from the admitted limits', /syncSinceFloorMsFromLimits\(limits\)/.test(server));
  check('it still drops GET_CONTACTS without contactSync', /limits\.contactSync[\s\S]{0,120}contact_sync_not_in_tier/.test(server));
}

const total = passed + failed;
console.log(`\n${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
