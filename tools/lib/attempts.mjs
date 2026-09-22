/**
 * T-GATE-REAP-ATTEMPT — the attempt loop, with the leak census scoped to the
 * ATTEMPT rather than to the step.
 *
 * THE DEFECT THIS EXISTS TO REMOVE (three false reds on 2026-09-22: EXT-HIST
 * 4a141a8, SMSMP-2, EXT-UI-5b 77c4fbd 112/113):
 *
 *   beforeStep = census()          <- ONCE, before attempt 1
 *   run(step)                      <- attempt 1 fails, leaves an orphan
 *                                     attempt 2 runs and PASSES
 *   assertNoLeaks(step, beforeStep) <- sees attempt 1's orphan
 *
 * The step is green and its `reap:` twin is red, so a gate that is working
 * correctly (the harness passed) reports a FAIL. Worse, the orphan is left
 * RUNNING under the retry — the same doubled load that made attempt 1 fail.
 *
 * The rule here: each attempt gets its own `before` census, taken immediately
 * before its spawn. When an attempt fails and another will follow, the orphans
 * that appeared DURING that attempt are found and killed BEFORE the next spawn.
 * The `reap:` assertion that follows the loop is then handed the census of the
 * WINNING attempt, so it measures the attempt the verdict came from — nothing
 * else.
 *
 * Rule 12 holds throughout: `findLeaks` is PID-based, excludes explorer.exe's
 * tree transitively, and only returns processes that (a) appeared during this
 * attempt, (b) are browser/node by name, and (c) are orphaned or sit inside the
 * gate's own tree — i.e. processes THIS step started. Nothing is ever matched
 * or killed by image name. This is the same criterion P5a (f) already uses when
 * it kills a timed-out child's PID tree.
 *
 * Everything in this file is pure with respect to the machine: `census`,
 * `findLeaks` and `kill` are injected, which is what makes the behaviour
 * testable without spawning a browser (tests/gate-reap-attempt.test.mjs).
 */

/**
 * The per-attempt census/reap bookkeeping, as a tiny synchronous state machine.
 *
 * It is a tracker rather than a loop so that BOTH callers can use the identical
 * code: `run()` is synchronous (spawnSync) and `runAsyncStep()` is not, and a
 * single loop function would have to be async and so could not serve `run()`.
 * Every operation here (census, findLeaks, taskkill) is synchronous, so the
 * tracker slots into either shape.
 *
 * @param {object} deps
 * @param {() => Array<{pid:number,ppid:number,name:string}>} deps.census
 * @param {(before:Array) => {leaked:number,pids:Array}} deps.findLeaks
 * @param {(pid:number) => void} deps.kill
 * @param {number} deps.attempts   total attempts this step may use
 * @param {boolean} [deps.wantCensus] take a census even at attempts === 1
 *        (the caller wants the winner's census for its own reap: step)
 * @param {(attempt:number, pids:Array) => void} [deps.onReap] reporting hook
 */
export function createAttemptTracker({
  census, findLeaks, kill, attempts = 1, wantCensus = false, onReap = null,
}) {
  const total = Math.max(1, attempts);
  // A census is a PowerShell spawn. Steps that neither retry nor want the
  // winner's census (the node suites, the build, gradle) must not pay for it.
  const enabled = total > 1 || wantCensus;
  const leakedAttempts = [];
  let beforeWinner = null;
  let index = -1;

  return {
    /** Call immediately BEFORE the spawn of attempt `i` (0-based). */
    begin(i) {
      index = i;
      beforeWinner = enabled ? census() : null;
      return beforeWinner;
    },
    /**
     * Call immediately AFTER the spawn of attempt `i` returns, with its exit
     * code. When the attempt failed and another will run, this is where the
     * orphans it left are reaped — BEFORE the next spawn, which is the whole
     * point. Returns the number of orphans found (0 when nothing to do).
     */
    end(exit) {
      const isLast = index >= total - 1;
      // A passing attempt is the winner; its census stays as beforeWinner and
      // its survivors are the reap: step's business, not ours.
      if (exit === 0 || isLast || !enabled) return 0;
      const { leaked, pids } = findLeaks(beforeWinner);
      leakedAttempts.push(leaked);
      if (leaked) {
        for (const p of pids) kill(p.pid);
        if (onReap) onReap(index + 1, pids);
      }
      return leaked;
    },
    /** The winning attempt's census — what the `reap:` step must measure. */
    winnerCensus() { return beforeWinner; },
    /**
     * Counts to fold into the step's record. `leakedAttempt1` is a NUMBER
     * whenever the step could retry (Ken greps for it); at attempts === 1 it is
     * absent, so single-attempt steps keep the shape they have always had.
     */
    counts() {
      if (total <= 1) return {};
      const out = { leakedAttempt1: leakedAttempts[0] ?? 0 };
      if (leakedAttempts.length > 1) out.leakedAttempts = [...leakedAttempts];
      return out;
    },
  };
}

/**
 * The synchronous driver `run()` uses: the attempt loop expressed once, with
 * the tracker wired in at the two points that matter.
 *
 * `spawn(i)` runs attempt `i` and returns `{ exit, ... }`; everything else it
 * returns is passed through untouched, so the caller keeps ownership of output
 * parsing, retained logs and the timeout/summary special cases.
 *
 * @returns {{exit:number, used:number, beforeWinner:Array|null,
 *            attemptCounts:object, ...rest}}
 */
export function runWithAttempts({
  spawn, census, findLeaks, kill, attempts = 1, wantCensus = false, onReap = null, afterAttempt = null,
}) {
  const total = Math.max(1, attempts);
  const tracker = createAttemptTracker({ census, findLeaks, kill, attempts: total, wantCensus, onReap });
  let result = { exit: 1 };
  let used = 0;
  for (let i = 0; i < total; i++) {
    used = i + 1;
    tracker.begin(i);
    result = spawn(i) || { exit: 1 };
    // The caller's own per-attempt bookkeeping (keepFailedAttempt) runs here,
    // before the reap, so a retained attempt log is written even if the reap
    // throws.
    if (afterAttempt) afterAttempt(i, result);
    tracker.end(result.exit);
    if (result.exit === 0) break;
  }
  return {
    ...result,
    used,
    beforeWinner: tracker.winnerCensus(),
    attemptCounts: tracker.counts(),
  };
}
