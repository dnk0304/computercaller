/**
 * tools/lib/headroom.mjs — GATE-PREFLIGHT: is there enough memory to run the
 * browser harnesses at all?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Three consecutive `--phase P6.1C --lane all` runs were OOM-killed by the box,
 * each at the FIRST browser harness, having recorded 6, 77 and 80 steps with
 * **0 FAIL and 0 WARN** (P6.1c STOP-2). The node and android lanes had all
 * passed; the run simply stopped existing.
 *
 * The danger is not the OOM. It is that a run which dies with zero failures
 * looks, in every artefact it leaves behind, exactly like a run that was going
 * to pass — and a partial run is not evidence. So the gate asks the question
 * BEFORE it launches a browser, and when the answer is no it refuses in a way
 * that cannot be mistaken for a verdict about the code:
 *
 *   - a distinct outcome, `ENV-NONRUN`, which is neither FAIL nor WARN;
 *   - exit code 3, which is neither 0 (pass), 1 (fail) nor 2 (refuse-to-run);
 *   - and NO gate JSON written at all.
 *
 * The last one is the point. A JSON is a claim about the tree; there is no
 * honest claim to make about steps that never ran.
 *
 * ── PURE ───────────────────────────────────────────────────────────────────
 * Nothing here reads the real machine. `freeBytes` is injected, which is what
 * lets tests/gate-headroom.test.mjs drive every branch with a mocked value —
 * including the boundary, which is the only part anyone ever gets wrong.
 */

/** GiB in bytes. */
export const GIB = 1024 ** 3;

/** The floor, in GiB. Overridable with `--headroom-gib N`. */
export const DEFAULT_HEADROOM_GIB = 6;

/**
 * Classify the machine's free memory.
 *
 * The comparison is `free < required` — STRICTLY less. Exactly 6.00 GiB with a
 * 6 GiB floor RUNS. A floor is a minimum, not a margin above a minimum, and an
 * off-by-one here would refuse a run that the operator explicitly permitted.
 *
 * @param {{freeBytes:number, requiredGib?:number}} o
 * @returns {{ok:boolean, outcome:'OK'|'ENV-NONRUN', freeGib:number,
 *            requiredGib:number, shortfallGib:number}}
 */
export function classifyHeadroom({ freeBytes, requiredGib = DEFAULT_HEADROOM_GIB }) {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    throw new TypeError(`headroom: freeBytes must be a non-negative finite number, got ${freeBytes}`);
  }
  if (!Number.isFinite(requiredGib) || requiredGib < 0) {
    throw new TypeError(`headroom: requiredGib must be a non-negative finite number, got ${requiredGib}`);
  }
  const freeGib = freeBytes / GIB;
  const ok = freeGib >= requiredGib;
  return {
    ok,
    outcome: ok ? 'OK' : 'ENV-NONRUN',
    // Two decimals: the number is for a human reading a console line, and
    // full float precision in "2.7183948593 GiB free" helps nobody.
    freeGib: Math.round(freeGib * 100) / 100,
    requiredGib,
    shortfallGib: ok ? 0 : Math.round((requiredGib - freeGib) * 100) / 100,
  };
}

/**
 * Read `--headroom-gib N` out of an argv array.
 *
 * A present-but-unparseable value is an ERROR, never a silent fall back to the
 * default: `--headroom-gib eight` must not quietly run with 6, because the
 * operator who typed it believes they changed the floor. (Wrong option names
 * that disable a MUST are a recurring shape of this bug.) Zero is allowed and
 * means "never refuse" — an explicit, visible opt-out.
 *
 * @param {string[]} argv
 * @param {number} fallback
 * @returns {{gib:number, explicit:boolean}}
 */
export function parseHeadroomGib(argv, fallback = DEFAULT_HEADROOM_GIB) {
  const i = argv.indexOf('--headroom-gib');
  if (i === -1) {
    const inline = argv.find((a) => a.startsWith('--headroom-gib='));
    if (inline === undefined) return { gib: fallback, explicit: false };
    return { gib: requireNumber(inline.slice('--headroom-gib='.length)), explicit: true };
  }
  return { gib: requireNumber(argv[i + 1]), explicit: true };
}

function requireNumber(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n < 0) {
    throw new RangeError(
      `--headroom-gib needs a non-negative number, got ${raw === undefined ? '(nothing)' : `"${raw}"`}`,
    );
  }
  return n;
}

/**
 * Aggregate a process census into the biggest RSS holders, by IMAGE NAME.
 *
 * READ-ONLY. This never returns a pid and nothing downstream may kill from it
 * — WORKTREE_STANDARD rule 12: the memory on this box is mostly Dennis's own
 * Chrome, rooted under explorer.exe, and it is not the gate's to touch. The
 * census exists so the operator can SEE what to close, and for no other
 * purpose. Names, not pids, so that it cannot be fed to a killer even by
 * accident.
 *
 * @param {{name:string, rssBytes:number}[]} rows
 * @param {number} top
 * @returns {{name:string, count:number, rssGib:number}[]}
 */
export function topRssHolders(rows, top = 8) {
  const byName = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.name !== 'string') continue;
    const rss = Number(r.rssBytes);
    if (!Number.isFinite(rss) || rss < 0) continue;
    const prev = byName.get(r.name) || { name: r.name, count: 0, bytes: 0 };
    prev.count += 1;
    prev.bytes += rss;
    byName.set(r.name, prev);
  }
  return [...byName.values()]
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, top)
    .map((e) => ({ name: e.name, count: e.count, rssGib: Math.round((e.bytes / GIB) * 100) / 100 }));
}

/** The console block the gate prints when it refuses. Pure: returns a string. */
export function headroomReport(verdict, holders) {
  const lines = [
    '',
    '  ENV-NONRUN  env:headroom — not enough memory to run the browser harnesses.',
    `              free ${verdict.freeGib} GiB < required ${verdict.requiredGib} GiB `
      + `(short by ${verdict.shortfallGib} GiB)`,
    '',
    '    This is NOT a FAIL and NOT a WARN. The node and android lanes above ran and',
    '    their results stand. No gate JSON has been written, because a run that stops',
    '    before its browser harnesses is not evidence about this tree — and three',
    '    P6.1C runs that were OOM-killed with 0 FAIL / 0 WARN are why this check exists.',
    '',
    '    Biggest resident images (READ-ONLY census — the gate never kills these):',
  ];
  if (!holders.length) lines.push('      (census unavailable)');
  for (const h of holders) {
    lines.push(`      ${String(h.rssGib).padStart(6)} GiB  ${h.name} x${h.count}`);
  }
  lines.push(
    '',
    '    Close what you can (Chrome is usually the whole story) and re-run, or pass',
    '    --headroom-gib N to lower the floor deliberately.',
    '',
  );
  return lines.join('\n');
}
