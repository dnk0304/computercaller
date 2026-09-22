/**
 * tests/gate-reap-attempt.test.mjs — GATE-TOOLING-1 (1), T-GATE-REAP-ATTEMPT.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The gate took ONE leak census per STEP, before attempt 1, and asserted
 * against it after the LAST attempt:
 *
 *   beforeStep = census()
 *   run(step)            // attempts: 2 — attempt 1 fails, attempt 2 PASSES
 *   assertNoLeaks(beforeStep)
 *
 * So an orphan left by a FAILING attempt 1 was charged to the step that PASSED
 * on attempt 2. Three false reds on 2026-09-22 (EXT-HIST 4a141a8, SMSMP-2,
 * EXT-UI-5b 77c4fbd 112/113) came from that one line, and defc585 itself was
 * merged PASS-BY-RULING on it. Worse than the red: the orphan was left RUNNING
 * under the retry — the doubled load that made attempt 1 fail in the first
 * place.
 *
 * Fix, pinned below: a census per ATTEMPT, a reap of that attempt's orphans
 * BEFORE the next spawn, and a `reap:` assertion handed the WINNING attempt's
 * census.
 *
 * ── WHY THIS SUITE IS NOT A TAUTOLOGY ───────────────────────────────────────
 * A test that drives the fixed code with fakes and finds it fixed proves
 * nothing on its own. So the behavioural claims carry CONTROL arms that replay
 * the OLD shape (one census before attempt 1, assertion after the last attempt)
 * over the SAME fakes and must reach the OPPOSITE verdict. If a future edit
 * makes the fakes toothless, the controls stop reproducing and this file goes
 * red on the control, not on the claim.
 *
 * Run: node tests/gate-reap-attempt.test.mjs
 */
import { runWithAttempts, createAttemptTracker } from '../tools/lib/attempts.mjs';

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass: Boolean(pass), detail }); };

/**
 * A fake machine. Processes are plain rows; a "spawn" can strand orphans.
 * findLeaks mirrors the real predicate closely enough for ordering and
 * arithmetic: anything live now that was absent from `before`.
 */
function makeWorld() {
  const live = new Map();           // pid -> image name
  const events = [];                // ordered trace of everything that happened
  let nextPid = 1000;
  return {
    events,
    live,
    census: () => {
      events.push('census');
      return [...live.entries()].map(([pid, name]) => ({ pid, name, ppid: 1 }));
    },
    findLeaks: (before) => {
      events.push('findLeaks');
      const had = new Set(before.map((p) => p.pid));
      const pids = [...live.entries()]
        .filter(([pid]) => !had.has(pid))
        .map(([pid, name]) => ({ pid, ppid: 1, name, why: 'parent-dead' }));
      return { leaked: pids.length, pids };
    },
    kill: (pid) => { events.push('kill:' + pid); live.delete(pid); },
    /** A spawn that optionally strands `orphans` processes. */
    spawner: (plan) => (i) => {
      events.push('spawn:' + (i + 1));
      for (let k = 0; k < (plan[i] ? plan[i].orphans || 0 : 0); k++) {
        live.set(nextPid++, 'chrome.exe');
      }
      return { exit: plan[i] ? plan[i].exit : 0 };
    },
  };
}

/** The OLD shape, replayed for the control arms: one census, assert at the end. */
function legacyRun(w, plan, attempts) {
  const beforeStep = w.census();
  const spawn = w.spawner(plan);
  let exit = 1;
  for (let i = 0; i < attempts; i++) { exit = spawn(i).exit; if (exit === 0) break; }
  return { exit, finalLeaked: w.findLeaks(beforeStep).leaked };
}

// ── (a)(b)(c) attempt-1 orphan reaped before attempt 2; winner census clean ──
{
  const w = makeWorld();
  const plan = [{ exit: 1, orphans: 1 }, { exit: 0, orphans: 0 }];
  const r = runWithAttempts({
    spawn: w.spawner(plan), census: w.census, findLeaks: w.findLeaks, kill: w.kill,
    attempts: 2, wantCensus: true,
  });
  const trace = w.events.join(' ');
  const killIdx = w.events.findIndex((e) => e.startsWith('kill:'));
  const spawn2Idx = w.events.indexOf('spawn:2');
  check('(a) the attempt-1 orphan is killed BEFORE attempt 2 is spawned',
    killIdx !== -1 && spawn2Idx !== -1 && killIdx < spawn2Idx, 'trace: ' + trace);

  check('(b) leakedAttempt1 === 1',
    r.attemptCounts.leakedAttempt1 === 1, JSON.stringify(r.attemptCounts));

  const finalLeaked = w.findLeaks(r.beforeWinner).leaked;
  check('(c) the reap: step, handed the WINNING attempt census, sees leaked === 0',
    finalLeaked === 0, 'leaked ' + finalLeaked);
  check('(c) and the step itself passed, so the old red was a FALSE red', r.exit === 0);

  // CONTROL: the old shape over the same plan must reproduce the false red.
  const w2 = makeWorld();
  const legacy = legacyRun(w2, plan, 2);
  check('CONTROL (a-c): the OLD one-census-per-step shape reports leaked 1 on a PASSING step',
    legacy.exit === 0 && legacy.finalLeaked === 1,
    'exit ' + legacy.exit + ', leaked ' + legacy.finalLeaked + ' — control no longer reproduces');
}

// ── (d) attempts: 1 changes nothing and records no leakedAttempt1 ───────────
{
  const w = makeWorld();
  const r = runWithAttempts({
    spawn: w.spawner([{ exit: 0, orphans: 0 }]),
    census: w.census, findLeaks: w.findLeaks, kill: w.kill, attempts: 1,
  });
  check('(d) attempts: 1 records NO leakedAttempt1 key',
    !('leakedAttempt1' in r.attemptCounts), JSON.stringify(r.attemptCounts));
  check('(d) attempts: 1 never calls findLeaks and never kills',
    !w.events.includes('findLeaks') && !w.events.some((e) => e.startsWith('kill:')), w.events.join(' '));
  check('(d) attempts: 1 with no census wanted takes NO census (a census is a PowerShell spawn)',
    !w.events.includes('census'), w.events.join(' '));

  // CONTROL: asking for the census must actually produce one, or the claim
  // above is satisfied by a path that can never take a census at all.
  const w2 = makeWorld();
  const r2 = runWithAttempts({
    spawn: w2.spawner([{ exit: 0, orphans: 0 }]),
    census: w2.census, findLeaks: w2.findLeaks, kill: w2.kill, attempts: 1, wantCensus: true,
  });
  check('CONTROL (d): wantCensus: true DOES take a census and returns it',
    w2.events.includes('census') && Array.isArray(r2.beforeWinner), w2.events.join(' '));
}

// ── (e) an orphan that SURVIVES the kill is still counted ──────────────────
{
  const w = makeWorld();
  const plan = [{ exit: 1, orphans: 1 }, { exit: 0, orphans: 0 }];
  const stubbornKill = (pid) => { w.events.push('kill-failed:' + pid); /* refuses to die */ };
  const r = runWithAttempts({
    spawn: w.spawner(plan), census: w.census, findLeaks: w.findLeaks, kill: stubbornKill,
    attempts: 2, wantCensus: true,
  });
  check('(e) a survivor of the kill is still COUNTED in leakedAttempt1',
    r.attemptCounts.leakedAttempt1 === 1, JSON.stringify(r.attemptCounts));
  check('(e) it survived — so the count is not an artefact of the kill working',
    w.live.size === 1, 'live ' + w.live.size);
}

// ── two failing attempts: per-attempt censuses, the array is kept ──────────
{
  const w = makeWorld();
  const plan = [{ exit: 1, orphans: 1 }, { exit: 1, orphans: 2 }, { exit: 0, orphans: 0 }];
  const r = runWithAttempts({
    spawn: w.spawner(plan), census: w.census, findLeaks: w.findLeaks, kill: w.kill,
    attempts: 3, wantCensus: true,
  });
  check('multi-retry: leakedAttempt1 is attempt 1 ALONE, not the running total',
    r.attemptCounts.leakedAttempt1 === 1, JSON.stringify(r.attemptCounts));
  check('multi-retry: leakedAttempts records every inter-attempt reap',
    JSON.stringify(r.attemptCounts.leakedAttempts) === '[1,2]', JSON.stringify(r.attemptCounts));
  check('multi-retry: used === 3', r.used === 3, 'used ' + r.used);
  check('multi-retry: the winning attempt census is clean', w.findLeaks(r.beforeWinner).leaked === 0);
}

// ── a LAST attempt that fails is NOT reaped by the loop ────────────────────
// The reap: step judges it; reaping here would hide the very survivor the gate
// exists to fail on.
{
  const w = makeWorld();
  const r = runWithAttempts({
    spawn: w.spawner([{ exit: 1, orphans: 1 }, { exit: 1, orphans: 1 }]),
    census: w.census, findLeaks: w.findLeaks, kill: w.kill, attempts: 2, wantCensus: true,
  });
  check('a failing LAST attempt is left for the reap: step to judge (not silently killed)',
    w.live.size === 1 && w.findLeaks(r.beforeWinner).leaked === 1, 'live ' + w.live.size);
  check('leakedAttempt1 still reports attempt 1, which WAS reaped',
    r.attemptCounts.leakedAttempt1 === 1, JSON.stringify(r.attemptCounts));
}

// ── the tracker stands alone (runAsyncStep drives it directly) ─────────────
{
  const w = makeWorld();
  const t = createAttemptTracker({ census: w.census, findLeaks: w.findLeaks, kill: w.kill, attempts: 2 });
  t.begin(0);
  w.live.set(7777, 'node.exe');
  const leaked = t.end(1);
  check('tracker: end() on a failing non-final attempt reaps and returns the count',
    leaked === 1, String(leaked));
  t.begin(1);
  check('tracker: begin() re-censuses, so the winner census excludes the reaped orphan',
    w.findLeaks(t.winnerCensus()).leaked === 0);
  check('tracker: a passing final attempt adds nothing further', t.end(0) === 0);
  check('tracker: counts() exposes leakedAttempt1 as a NUMBER (Ken greps for it)',
    typeof t.counts().leakedAttempt1 === 'number' && t.counts().leakedAttempt1 === 1,
    JSON.stringify(t.counts()));
}

// ── PROPERTY: the loop never kills anything findLeaks did not return ───────
{
  const w = makeWorld();
  const preexisting = 4242;
  w.live.set(preexisting, 'chrome.exe');   // another lane's browser, predates the step
  runWithAttempts({
    spawn: w.spawner([{ exit: 1, orphans: 1 }, { exit: 0, orphans: 0 }]),
    census: w.census, findLeaks: w.findLeaks, kill: w.kill, attempts: 2,
  });
  check('rule 12: a process that PREDATES the attempt is never killed',
    w.live.has(preexisting), 'the pre-existing PID was killed');
}

const failed = results.filter((r) => !r.pass);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
for (const f of failed) console.log('  FAIL ' + f.name + ' ' + f.detail);
process.exit(failed.length ? 1 : 0);
