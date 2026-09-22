/**
 * GATE-TOOLING-1 (2) — the `gradlew --stop` step's two decisions, kept pure.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES INLINE: both decisions are exactly
 * the kind that can only be exercised on a box that is in the wrong state. A
 * count of live JVMs and a "does a surviving JVM fail the step?" rule tested by
 * running the real gradlew would be tested once, by hand, and never again.
 *
 * RULE 12, in both directions. `countJava` matches BY IMAGE NAME, which is
 * exactly what rule 12 forbids feeding to a killer — so it returns a NUMBER and
 * the record it produces carries no pid, ever. A surviving `java.exe` may be
 * Dennis's IDE or another lane's daemon; the gate reports it and does not touch
 * it. That is why `warn` exists and `exit` does not move.
 */

/**
 * How many `java.exe` are live, from a read-only census (`rssCensus()` rows:
 * `{ name, rssBytes }`). Anchored on both ends so `javaw.exe` and
 * `java.exe.bak` are not counted; case-insensitive because Windows is.
 *
 * A malformed or absent census counts 0 rather than throwing: a census the gate
 * could not read is a missing convenience, never a reason to change a verdict.
 */
export function countJava(census) {
  const rows = Array.isArray(census) ? census : [];
  return rows.filter((p) => p && typeof p.name === 'string' && /^java\.exe$/i.test(p.name)).length;
}

/**
 * The step's record, from the command's exit status and the two counts.
 *
 * `javaAfter > 0` is a WARN and NEVER a FAIL — see the rule-12 note above. The
 * only thing that can fail this step is `gradlew --stop` itself failing.
 *
 * @param {object} o
 * @param {number|null} o.exit  spawnSync's `status` (null = killed/timeout)
 * @param {number} o.javaBefore
 * @param {number} o.javaAfter
 * @returns {{exit:number, counts:{javaBefore:number,javaAfter:number}, warn:boolean}}
 */
export function gradleStopRecord({ exit, javaBefore = 0, javaAfter = 0 } = {}) {
  return {
    exit: exit === null || exit === undefined ? 124 : Number(exit),
    // No `pid` key, and nothing that could become one. Pinned by a property
    // test in tests/gate-headroom.test.mjs.
    counts: { javaBefore, javaAfter },
    warn: javaAfter > 0,
  };
}
