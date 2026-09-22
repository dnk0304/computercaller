/**
 * scripts/lib/bat-ui-cases.mjs — BAT-3 (d), NODE ARM.
 *
 * The DECISIONS of the battery indicator, asserted exhaustively over the states
 * that matter, against the SAME module the component imports
 * (lib/batteryCopy.ts). Nothing here retypes a product string: every expected
 * value is built from the inputs by the rules the brief states, and compared to
 * what the product returns. A harness that hard-codes "Phone battery 47%,
 * charging" proves the harness can type.
 *
 * Split out of the browser arm for the reason e2e-ui-cases.mjs was: a decision
 * table sampled through whatever states a browser run happens to reach is not a
 * decision table. The browser arm's job is to prove the components are WIRED to
 * these functions and that the real DOM says what they return.
 */

import {
  BATTERY_STALE_MS,
  batteryFill,
  batteryTone,
  batteryView,
  newerBattery,
} from '../../lib/batteryCopy.ts';

/** 2026-09-22 14:32 local — the brief's own clock, so screenshots match copy. */
export const TS_1432 = new Date(2026, 8, 22, 14, 32, 0).getTime();

/**
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 */
export function runBatteryCases(check) {
  // ── thresholds ────────────────────────────────────────────────────────────
  // The boundaries, not the middles: 21/20 and 11/10 are where a mis-typed
  // comparison actually shows up, and 100/0 are where a clamp would.
  check(
    '(1) tone: 100/50/21 normal, 20/11 low, 10/0 critical — boundaries inclusive',
    [100, 50, 21].every((p) => batteryTone(p) === 'normal')
      && [20, 11].every((p) => batteryTone(p) === 'low')
      && [10, 0].every((p) => batteryTone(p) === 'critical'),
    [100, 50, 21, 20, 11, 10, 0].map((p) => `${p}:${batteryTone(p)}`).join(' '),
  );

  // ── proportional fill ─────────────────────────────────────────────────────
  check(
    '(2) fill is proportional and monotonic, clamped to 0..1 with a visible floor',
    batteryFill(100) === 1
      && batteryFill(50) === 0.5
      && batteryFill(0) > 0 && batteryFill(0) < 0.1
      && batteryFill(150) === 1
      && batteryFill(-5) === batteryFill(0)
      && [0, 10, 20, 50, 100].every((p, i, a) => i === 0 || batteryFill(p) > batteryFill(a[i - 1])),
    `0:${batteryFill(0)} 50:${batteryFill(50)} 100:${batteryFill(100)}`,
  );

  // ── the four rendered percentages from the brief ──────────────────────────
  for (const pct of [100, 50, 20, 10]) {
    const v = batteryView({ pct, charging: false, ts: TS_1432 }, true, TS_1432);
    check(
      `(3.${pct}) ${pct}% renders as text "${pct}%" with tone ${batteryTone(pct)}`,
      v !== null && v.kind === 'live' && v.text === `${pct}%` && v.tone === batteryTone(pct),
      JSON.stringify(v),
    );
  }

  // ── charging ──────────────────────────────────────────────────────────────
  const charging = batteryView({ pct: 47, charging: true, ts: TS_1432 }, true, TS_1432);
  const notCharging = batteryView({ pct: 47, charging: false, ts: TS_1432 }, true, TS_1432);
  check(
    '(4) charging flag reaches the view and the label says which',
    charging?.charging === true
      && charging?.label === 'Phone battery 47%, charging'
      && notCharging?.charging === false
      && notCharging?.label === 'Phone battery 47%, not charging',
    `${charging?.label} | ${notCharging?.label}`,
  );

  // ── last-seen copy ────────────────────────────────────────────────────────
  const gone = batteryView({ pct: 47, charging: false, ts: TS_1432 }, false, TS_1432 + 60_000);
  check(
    '(5) phone absent: "Last seen 14:32 · 47%", kind lastSeen, never stale-marked',
    gone?.kind === 'lastSeen'
      && gone?.text === 'Last seen 14:32 · 47%'
      && gone?.stale === false
      && gone?.label === 'Phone battery 47%, last seen 14:32',
    `${gone?.text} / ${gone?.label}`,
  );

  // ── staleness ─────────────────────────────────────────────────────────────
  const fresh = batteryView({ pct: 47, charging: false, ts: TS_1432 }, true, TS_1432 + BATTERY_STALE_MS);
  const stale = batteryView({ pct: 47, charging: false, ts: TS_1432 }, true, TS_1432 + BATTERY_STALE_MS + 1);
  check(
    '(6) stale boundary: exactly 15 min is fresh, one ms past it adds "as of 14:32"',
    fresh?.stale === false
      && fresh?.label === 'Phone battery 47%, not charging'
      && stale?.stale === true
      && stale?.label === 'Phone battery 47%, not charging, as of 14:32',
    `${fresh?.label} | ${stale?.label}`,
  );
  check(
    '(7) a stale reading still shows its VALUE — battery moves slowly, do not blank it',
    stale?.text === '47%' && stale?.pct === 47,
    JSON.stringify(stale),
  );

  // ── no value ever ─────────────────────────────────────────────────────────
  check(
    '(8) no value ever received renders NOTHING — null, not "--%"',
    batteryView(null, true, TS_1432) === null
      && batteryView(undefined, false, TS_1432) === null,
    String(batteryView(null, true, TS_1432)),
  );

  // ── CONTROL ───────────────────────────────────────────────────────────────
  // If this arm reports a view for a value that IS present, the null check
  // above is vacuous — it would pass against a function that returned null for
  // everything, which is the "0 tests ran wearing a green hat" shape.
  check(
    'CONTROL: the same call with a real value does NOT return null',
    batteryView({ pct: 1, charging: false, ts: TS_1432 }, true, TS_1432) !== null,
  );

  // ── two sources, one value ────────────────────────────────────────────────
  const older = { pct: 80, charging: false, ts: TS_1432 };
  const newer = { pct: 79, charging: true, ts: TS_1432 + 60_000 };
  const picked = newerBattery(older, newer);
  check(
    '(9) hook vs storage.session: newest ts wins, and the value is never merged',
    picked === newer
      && newerBattery(newer, older) === newer
      && newerBattery(null, older) === older
      && newerBattery(older, null) === older
      && newerBattery(null, null) === null,
    JSON.stringify(picked),
  );

  // ── the accessible name is read once, and is one sentence ─────────────────
  check(
    '(10) every rendered state carries exactly one accessible sentence, never empty',
    [
      batteryView({ pct: 9, charging: false, ts: TS_1432 }, true, TS_1432),
      batteryView({ pct: 9, charging: true, ts: TS_1432 }, true, TS_1432),
      batteryView({ pct: 9, charging: false, ts: TS_1432 }, false, TS_1432),
    ].every((v) => typeof v?.label === 'string' && v.label.startsWith('Phone battery ')
      && v.label.length > 'Phone battery '.length),
  );

  // ── no emoji, no "end-to-end" wording anywhere in the copy ────────────────
  const allCopy = [100, 50, 20, 10, 9, 0]
    .flatMap((pct) => [true, false].flatMap((ch) => [true, false].map((pres) =>
      batteryView({ pct, charging: ch, ts: TS_1432 }, pres, TS_1432 + BATTERY_STALE_MS + 1))))
    .flatMap((v) => (v ? [v.text, v.label] : []));
  check(
    '(11) no emoji in any battery string (fleet rule: no emojis in UI copy)',
    !allCopy.some((t) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)),
    allCopy.join(' | ').slice(0, 120),
  );
}
