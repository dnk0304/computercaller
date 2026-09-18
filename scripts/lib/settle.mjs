/**
 * scripts/lib/settle.mjs — the missing barrier behind the `attempts: 2` on
 * app-in-call-shots, ext-in-call-shots and ext-templates-scroll-call-message-proof.
 *
 * ── THE DEFECT, STATED ──────────────────────────────────────────────────────
 * Those three harnesses are exactly the three that gate their assertions on
 * UNCONDITIONAL sleeps. Counted at the merged tip 3c2d204:
 *
 *   app-in-call-shots                       31 waitForTimeout,  1 condition wait
 *   ext-in-call-shots                       31 waitForTimeout,  0 condition waits
 *   ext-templates-scroll-call-message-proof 15 waitForTimeout,  0 condition waits
 *   ---- the four that need no retry ----
 *   ext-layering-shots                      13 waitForTimeout
 *   ext-shell-theme-proof                    3 waitForTimeout
 *   ext-badge-counter-proof                  0 waitForTimeout
 *   ext-sw-lifetime-proof                    0 waitForTimeout
 *
 * The ranking of the flake and the ranking of the sleep density are the same
 * list. A `waitForTimeout(400)` after driving a socket frame is a BET that the
 * relay round-trip, the React re-render and the paint all finish inside 400 ms.
 * On an idle box they finish in tens of milliseconds and the bet always wins.
 * Under seven concurrent headful Chromiums — and it was FOURTEEN during the
 * window these three were measured, because two `--parallel-harnesses` gates
 * ran at once, which is why rule R-AA now exists — they do not, the assertion
 * reads the PREVIOUS frame, and the harness fails on a product that is fine.
 *
 * It is NOT the token race. P5a slice 1 fixed that (armIndicator/cc-keepalive
 * repainting "signed-out"), and none of these three carries that signature:
 * they never assert an auth indicator, and two of them never touch the DB.
 * Reproduced on an idle box at 3c2d204, all seven harnesses in parallel: every
 * one passed first try. A defect that only appears under load is a defect in
 * how the harness waits, and this file is the fix for it.
 *
 * ── WHY QUIESCENCE IS ADDED AND THE SLEEP IS NOT REMOVED ────────────────────
 * The obvious fix — replace each sleep with a wait for the condition being
 * asserted — is the right shape and the wrong risk. Some of these sleeps are
 * waiting on a PRODUCT timer (the 2400 ms ringing auto-open, banner dwell), not
 * on a render, and a condition wait would return early and silently change what
 * the harness measures. The brief's constraint is explicit: no assertion
 * changes, minChecks unchanged.
 *
 * So `settle()` keeps the original delay as a FLOOR and adds the barrier on
 * top as a CEILING. It can never return earlier than today's code, so no
 * product-timer semantic moves; it waits longer, up to a generous ceiling, when
 * the box is busy, which is the only case that was ever failing. Cost on an
 * idle box is one quiet window per call (~120 ms), or about 3.7 s across the
 * 31 calls in a 220 s harness.
 */

/**
 * Wait for the DOM to stop changing.
 *
 * `quiet` ms with no mutation and no pending animation frame is the signal that
 * React has flushed and the compositor has caught up. The ceiling is a real
 * bound rather than a hang: if something on the page mutates forever (a
 * spinner, a clock), we stop waiting and let the assertion speak — a harness
 * that hangs teaches nothing, and this barrier is an improvement on a sleep,
 * not a correctness oracle.
 *
 * Returns how long it actually waited, so a caller can report load.
 */
export async function waitForQuiet(page, { quiet = 120, ceiling = 6000 } = {}) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      ({ quiet: q }) => {
        const w = /** @type {any} */ (window);
        if (!w.__ccSettle) {
          // One observer per page, installed lazily on first use and left in
          // place. Re-installing per call would reset `last` to "now" and make
          // every call return after exactly one quiet window regardless of what
          // the page was doing.
          w.__ccSettle = { last: performance.now() };
          const bump = () => { w.__ccSettle.last = performance.now(); };
          new MutationObserver(bump).observe(document, {
            subtree: true, childList: true, attributes: true, characterData: true,
          });
          return false;
        }
        return performance.now() - w.__ccSettle.last >= q;
      },
      { quiet },
      { timeout: ceiling, polling: 50 },
    );
  } catch {
    // Ceiling hit. Deliberately silent and deliberately not a failure: the
    // caller's own assertion is the thing that decides whether the page is in
    // the expected state.
  }
  return Date.now() - t0;
}

/**
 * Drop-in for `await page.waitForTimeout(ms)`.
 *
 * FLOOR = ms (unchanged behaviour, so product timers are preserved exactly),
 * then quiescence on top. Use this everywhere a sleep precedes an assertion or
 * a screenshot.
 */
export async function settle(page, ms, opts = {}) {
  if (ms > 0) await page.waitForTimeout(ms);
  return waitForQuiet(page, opts);
}
