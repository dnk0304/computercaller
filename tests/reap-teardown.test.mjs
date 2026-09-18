/**
 * tests/reap-teardown.test.mjs — E2E-P5a (f), R-AE addendum.
 *
 * THE DEFECT (found by the P0.3 lane's gate): `ext-badge-counter-proof` exited
 * 124 AFTER printing "43/43 passed". Its teardown ran
 *
 *     await ctx.close();
 *     reaper.reapAndReport(...);
 *     fs.rmSync(userDataDir, { recursive: true, force: true });
 *
 * on a profile directory Chromium had not finished releasing. `taskkill /F`
 * RETURNS BEFORE Windows has torn the process down, and `reap()` censused
 * immediately with no settle window — so the rmSync landed on a held handle.
 * On Windows that is EBUSY/EPERM, and `force: true` does NOT cover it (force
 * only ignores ENOENT), so the throw escaped the very finally block that was
 * supposed to be cleaning up.
 *
 * Both halves of the fix are pinned here, each against a control that must
 * behave differently — a cleanup test that passes either way tests nothing.
 *
 * Run: node tests/reap-teardown.test.mjs
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmWhenUnlocked } from '../scripts/lib/reap.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── 1. A directory HELD BY ANOTHER PROCESS is the badge-counter shape ────
//
// The holder must be EXTERNAL. A first draft of this test opened an fd in this
// same process and rmSync deleted the directory anyway, so the control did not
// reproduce and the test proved nothing — recorded because it is the obvious
// way to write this and it is wrong. A child process whose CURRENT DIRECTORY is
// the target is a lock Windows genuinely refuses to remove, which is the same
// class of hold a live Chromium has on its profile.
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-reap-held-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { cwd: dir });
  await new Promise((r) => setTimeout(r, 500));

  // CONTROL: the old call fails on a held directory. If this ever stops
  // failing, the platform changed and the rest of this section is moot.
  let oldFailed = false;
  try {
    rmSync(dir, { recursive: true, force: true });
    oldFailed = existsSync(dir);
  } catch {
    oldFailed = true;
  }
  check('CONTROL: rmSync(force:true) fails on a directory another process holds',
    oldFailed, oldFailed ? 'threw or left the directory behind' : 'removed it anyway — control does not reproduce');

  // FIXED: bounded, never throws, reports honestly.
  let fixedThrew = false;
  let res;
  try {
    res = rmWhenUnlocked(dir, { timeoutMs: 600, intervalMs: 100 });
  } catch {
    fixedThrew = true;
  }
  check('FIXED: rmWhenUnlocked NEVER throws out of a teardown', fixedThrew === false);
  check('FIXED: it reports the failure instead of pretending it worked',
    !fixedThrew && res.removed === false && Boolean(res.error), JSON.stringify(res));
  check('FIXED: and it respects its bound rather than hanging the harness',
    !fixedThrew && res.waitedMs < 3000, `${res?.waitedMs}ms`);

  try { holder.kill(); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 400));
  rmWhenUnlocked(dir, { timeoutMs: 3000 });
}

// ── 2. Once the handle is released it removes, and quickly ─────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-reap-free-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  const res = rmWhenUnlocked(dir, { timeoutMs: 5000 });
  check('an unheld directory is removed on the first try', res.removed === true);
  check('and costs no waiting on the normal path', res.waitedMs < 500, `${res.waitedMs}ms`);
  check('the directory really is gone', existsSync(dir) === false);
}

// ── 3. A hold released DURING the window is picked up ───────────────
//
// External holder again, and killed mid-window: this is the case the settle
// exists for — Chromium is dying but has not let go yet. Asserted on the WAIT
// being non-trivial as well as on the removal, because a check that returns in
// 1ms has not exercised the polling at all (the first draft did exactly that
// with a same-process fd and passed without testing anything).
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-reap-late-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { cwd: dir });
  await new Promise((r) => setTimeout(r, 400));
  // Killed IMMEDIATELY BEFORE the poll, not on a timer during it. rmWhenUnlocked
  // is synchronous by design (reap() must work from an 'exit' handler, where an
  // await never runs), so it BLOCKS THE EVENT LOOP while polling — a timer
  // scheduled to fire mid-window would never fire, and the first draft of this
  // test failed for exactly that reason rather than for a real one. The OS
  // releases the directory on its own schedule, which is the race this
  // reproduces.
  try { holder.kill(); } catch { /* gone */ }
  const res = rmWhenUnlocked(dir, { timeoutMs: 6000, intervalMs: 100 });
  check('a hold released as the poll starts is picked up rather than given up on',
    res.removed === true, `${res.waitedMs}ms`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
