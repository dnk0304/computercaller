/**
 * tests/gate-child-exit.test.mjs — E2E-P5a (f).
 *
 * ── WHAT THE P5A GATE ACTUALLY SHOWED, AND WHAT IT DID NOT ──────────────────
 * Three harnesses were recorded `exit 124` in gate-P5A-f4d104e.json, and their
 * kept attempt-1 logs (a (d1) change) each END WITH A COMPLETE SUMMARY:
 * "43/43 passed", "20/20 checks passed", and sw-lifetime's final WARN line.
 *
 * My first reading was "they finish and then hang on exit". That reading is
 * WRONG, and the control arm below is what disproved it — recorded here rather
 * than quietly deleted, because the wrong theory is the one the next person
 * will also reach for:
 *
 *   - `ext-shell-theme-proof` takes 409s STANDALONE on an idle box against a
 *     480s per-harness budget. Under 8-way parallelism it simply overruns. It
 *     was never hung; it was still working.
 *   - A synthetic child that exits while a grandchild holds the inherited pipe
 *     is seen as closed in ~179ms on Windows, so `'close'` vs `'exit'` is NOT
 *     the mechanism either. (The gate now waits on `'exit'` anyway — it is
 *     strictly more robust and costs nothing — but it is NOT the fix, and the
 *     commit does not claim it is.)
 *
 * THE ACTUAL DEFECT, pinned below: `child.kill()` on a step spawned with
 * `shell: true` signals **cmd.exe only**. The real harness — and its Chromium —
 * survives. So the gate declared a timeout, left the work running, and started
 * the retry ON TOP of it, doubling the load that caused the overrun. The
 * orphan kept writing into the still-open pipe, which is exactly why a step the
 * gate called a timeout has a complete summary in its log.
 *
 * Fix: kill the PID TREE (taskkill /T, by PID only — WORKTREE_STANDARD r12),
 * plus a concurrency cap of 6 so the overrun stops happening in the first place.
 *
 * Run: node tests/gate-child-exit.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'cc-gate-exit-'));
const marker = join(dir, 'still-alive.txt');
const child = join(dir, 'child.mjs');

// A stand-in for a harness that is STILL RUNNING when the budget expires: it
// keeps working, and it proves it by writing a marker after the kill lands.
writeFileSync(child, `
import { writeFileSync } from 'node:fs';
setTimeout(() => { try { writeFileSync(${JSON.stringify(marker)}, 'survived'); } catch {} }, 2500);
setTimeout(() => process.exit(0), 6000);
`);


function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

/** Spawn the way the gate does, wait `ms`, then kill with `killer`. */
async function runAndKill(killer) {
  rmSync(marker, { force: true });
  const c = spawn(`node "${child}"`, { shell: true });
  await new Promise((r) => setTimeout(r, 1000));
  killer(c);
  // Longer than the marker's 2.5s: if the work was really stopped, the marker
  // never appears.
  await new Promise((r) => setTimeout(r, 3000));
  const survived = existsSync(marker);
  killTree(c.pid);
  return survived;
}

// CONTROL — the old behaviour. This MUST show the work surviving, or the test
// has stopped testing anything.
const survivedOld = await runAndKill((c) => { try { c.kill(); } catch { /* gone */ } });
check('CONTROL: child.kill() on a shell:true step does NOT stop the real work (defect reproduced)',
  survivedOld === true, survivedOld ? 'marker written after the kill' : 'work stopped — control no longer reproduces');

// FIXED — kill the tree by PID.
const survivedNew = await runAndKill((c) => killTree(c.pid));
check('FIXED: killing the PID TREE actually stops the work',
  survivedNew === false, survivedNew ? 'marker STILL written — tree kill failed' : 'no marker');

check('the two arms disagree, so the fix is pinned rather than assumed',
  survivedOld === true && survivedNew === false);

rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
