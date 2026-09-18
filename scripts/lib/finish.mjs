/**
 * scripts/lib/finish.mjs — E2E-P5a (f). Print the summary, say what is still
 * holding the process open, and EXIT.
 *
 * ── WHY (R-AE), AND WHAT THE EVIDENCE ACTUALLY SAYS ─────────────────────────
 * In the P5A gate run at f4d104e, THREE harnesses were recorded `exit 124`
 * (the 8-minute budget) and their kept attempt-1 logs each END WITH A COMPLETE
 * SUMMARY — "43/43 passed", "20/20 checks passed", sw-lifetime's final WARN.
 *
 * That looks like "finished, then hung". It is not, and the wrong reading is
 * recorded here because it is the one the next reader will also reach for:
 * `child.kill()` on a `shell: true` step signals cmd.exe only, so the gate's
 * timeout never stopped the harness. It kept running and kept writing into the
 * still-open pipe. The summary in a "timed-out" log is the orphan's, not a
 * hang's. Pinned in tests/gate-child-exit.test.mjs; fixed by killTree() plus a
 * concurrency cap (ext-shell-theme-proof needs 409s of a 480s budget standalone,
 * so 8-way parallelism overran it regardless).
 *
 * None of that makes an explicit exit wrong — a harness should end when its
 * work ends rather than depend on the loop draining — so (f) still adds one
 * everywhere, and makes it REPORT what was still open rather than paper over
 * it. The first run of this diagnostic immediately earned its place: it printed
 * "still held open by: TCPServerWrap" for ext-shell-theme-proof, whose
 * `server.close()` was never awaited.
 *
 * ── THE HANDLE AUDIT (do the close, then the exit — not the exit instead) ───
 * `process.exit()` on its own hides leaks rather than fixing them, so the
 * concrete holders were found first:
 *
 *   ext-shell-theme-proof  `server.close()` was fire-and-forget AND did not
 *                          drop established keep-alive sockets. Now
 *                          closeAllConnections() + an AWAITED close.
 *   ext-sw-lifetime-proof  a 15s `setInterval` sampler whose clearInterval only
 *                          ran on the next tick after the socket closed, so it
 *                          stayed armed on every early return. Now unref'd and
 *                          cleared on 'close'.
 *
 * The exit below is the BACKSTOP for whatever the next audit misses, and it is
 * a backstop that reports itself: when handles remain it names them, so the
 * next leak arrives as a line in the log instead of a timeout to re-diagnose.
 *
 * ── WHY A FLUSH BEFORE exit() ───────────────────────────────────────────────
 * On Windows, stdout to a pipe (which is exactly how the gate spawns these) is
 * ASYNCHRONOUS. `process.exit()` does not drain it, so the summary line the
 * gate parses can be lost — turning a passing harness into "reported NO count
 * at all". The write callback below is what guarantees the line is out before
 * the process dies.
 */

/** Handles still keeping the event loop alive, as coarse type names. */
export function activeHandles() {
  try {
    const info = typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo()
      : [];
    // Node always lists its own stdio and the loop's internals; those are not
    // leaks and naming them would bury the one that is.
    const ignore = new Set(['TTYWrap', 'PipeWrap', 'FileHandle', 'Immediate', 'TickObject']);
    return info.filter((h) => !ignore.has(h));
  } catch {
    return [];
  }
}

/**
 * Print the standard summary, then exit with the right code.
 *
 * `results` is the harness's own [{name, pass, detail}] array. The output shape
 * is deliberately byte-identical to what these harnesses already print — the
 * gate's passLine() parses it, and (f) is an exit fix, not a reporting change.
 */
export function finish(name, results, { minChecks = 0, extraFail = false } = {}) {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail ?? ''}`);

  let code = failed.length || extraFail ? 1 : 0;
  if (minChecks && results.length < minChecks) {
    console.log(`  FAIL minChecks — declared ${minChecks}, ran ${results.length}`);
    code = 1;
  }

  const held = activeHandles();
  if (held.length) {
    // Not a failure: the process is about to be gone either way. It is a
    // BREADCRUMB, so the next person gets a handle name instead of a timeout.
    console.log(`  NOTE ${name} still held open by: ${held.join(', ')} — exiting anyway (P5a f)`);
  }
  exitAfterFlush(code);
}

/** `process.exit` that does not truncate the summary on a Windows pipe. */
export function exitAfterFlush(code) {
  try {
    process.stdout.write('', () => process.exit(code));
    // If stdout is already closed the callback never fires; do not hang on it.
    setTimeout(() => process.exit(code), 2000).unref();
  } catch {
    process.exit(code);
  }
}
