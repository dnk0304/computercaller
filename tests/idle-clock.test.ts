/**
 * tests/idle-clock.test.ts — the 4-hour boundary, on a fake clock.
 *
 * WHY THIS FILE EXISTS. Until now the only way to know where the idle cutoff
 * actually fell was to read IdleTimeoutGuard's tick and believe it: the
 * arithmetic lived inside a 1 s setInterval inside a React effect, so the only
 * honest test of it was to wait four hours. lib/idleClock.ts pulls the verdict
 * out as a pure function; this file pins every cell of it.
 *
 * NO LITERALS. Every case is expressed against IDLE_TIMEOUT_MS and
 * IDLE_WARN_BEFORE_MS. A test that hard-coded 14400000 would keep passing after
 * someone shortened the window and would be asserting the old product.
 */

import { idleVerdict, idleRemainingMs } from '../lib/idleClock.ts';
import {
  IDLE_TIMEOUT_MS,
  IDLE_WARN_BEFORE_MS,
  IDLE_WARN_ENABLED,
} from '../lib/idleTimeout.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// A fixed "now" — the clock is fake precisely so none of this depends on when
// the suite runs. lastActivity is derived backwards from it per case.
const NOW = 1_800_000_000_000;
const at = (
  elapsed: number,
  opts: { keepAlive?: boolean; warnEnabled?: boolean } = {},
) => idleVerdict({
  now: NOW,
  lastActivity: NOW - elapsed,
  keepAlive: opts.keepAlive ?? false,
  warnEnabled: opts.warnEnabled ?? true,
});

// ── the constants are the ones the product ships ────────────────────────────
eq('IDLE_TIMEOUT_MS is four hours', IDLE_TIMEOUT_MS, 4 * 60 * 60 * 1000);
eq('IDLE_WARN_BEFORE_MS is sixty seconds', IDLE_WARN_BEFORE_MS, 60 * 1000);
check('the warn modal ships enabled', IDLE_WARN_ENABLED === true);

// ── the boundary, cell by cell ──────────────────────────────────────────────
eq('4h − 61s → ok (one second before the modal is due)',
  at(IDLE_TIMEOUT_MS - IDLE_WARN_BEFORE_MS - 1000), 'ok');
eq('4h − 60s → warn (the modal is due exactly here, inclusive)',
  at(IDLE_TIMEOUT_MS - IDLE_WARN_BEFORE_MS), 'warn');
eq('4h − 1ms → warn (still inside the window, by a millisecond)',
  at(IDLE_TIMEOUT_MS - 1), 'warn');
eq('exactly 4h → logout (the stated window is inclusive of its own end)',
  at(IDLE_TIMEOUT_MS), 'logout');
eq('4h + 1ms → logout', at(IDLE_TIMEOUT_MS + 1), 'logout');
eq('long past the window → logout (a laptop that slept through it)',
  at(IDLE_TIMEOUT_MS * 10), 'logout');
eq('zero elapsed → ok', at(0), 'ok');

// ── keepAlive outranks the clock ────────────────────────────────────────────
eq('a live call at 4h + 1ms → ok (a call in progress is not idleness)',
  at(IDLE_TIMEOUT_MS + 1, { keepAlive: true }), 'ok');
eq('a live call deep past the window → ok',
  at(IDLE_TIMEOUT_MS * 10, { keepAlive: true }), 'ok');
eq('a live call inside the warn band → ok, no modal over a call',
  at(IDLE_TIMEOUT_MS - 1, { keepAlive: true }), 'ok');

// ── warnEnabled=false suppresses the modal, never the logout ────────────────
eq('warn disabled at 4h − 1ms → ok (no modal)',
  at(IDLE_TIMEOUT_MS - 1, { warnEnabled: false }), 'ok');
eq('warn disabled at 4h − 60s → ok',
  at(IDLE_TIMEOUT_MS - IDLE_WARN_BEFORE_MS, { warnEnabled: false }), 'ok');
// THE ONE THAT MATTERS: turning the warning off must not turn the timeout off.
eq('warn disabled at exactly 4h → STILL logout',
  at(IDLE_TIMEOUT_MS, { warnEnabled: false }), 'logout');
eq('warn disabled past 4h → STILL logout',
  at(IDLE_TIMEOUT_MS + 5000, { warnEnabled: false }), 'logout');

// ── the countdown the modal renders ─────────────────────────────────────────
eq('remaining at the top of the warn band is the full warn window',
  idleRemainingMs(NOW, NOW - (IDLE_TIMEOUT_MS - IDLE_WARN_BEFORE_MS)), IDLE_WARN_BEFORE_MS);
eq('remaining never goes negative (it is rendered)',
  idleRemainingMs(NOW, NOW - IDLE_TIMEOUT_MS * 3), 0);
eq('remaining at the cutoff is exactly 0',
  idleRemainingMs(NOW, NOW - IDLE_TIMEOUT_MS), 0);

// ── monotonicity: the verdict may never go backwards as time passes ─────────
// A boundary written with the wrong comparison typically shows up as a cell
// that returns 'ok' again after having returned 'warn'. Walk the last two
// minutes in one-second steps and assert the sequence only ever advances.
{
  const rank: Record<string, number> = { ok: 0, warn: 1, logout: 2 };
  let worst = 0;
  let regressed = false;
  for (let e = IDLE_TIMEOUT_MS - 120_000; e <= IDLE_TIMEOUT_MS + 5_000; e += 1000) {
    const r = rank[at(e)];
    if (r < worst) regressed = true;
    worst = Math.max(worst, r);
  }
  check('the verdict never relaxes as elapsed time grows', !regressed);
  eq('...and it ends at logout', worst, 2);
}

console.log(`\nidle-clock: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
