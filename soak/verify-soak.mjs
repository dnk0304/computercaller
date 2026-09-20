/**
 * The verdict on a soak run. (R-AM; originally E2E-P6 (f).)
 *
 * The runner's job is to hold the pairs and write evidence. Deciding whether
 * what it produced is a VALID 24 h window is a separate question, answered here
 * from the files alone — which is the point: the process that claims to have
 * soaked is the last one that should be trusted to grade itself.
 *
 * RESUME-PROTOCOL rule 8 is the law this enforces, verbatim:
 *
 *   "a detached heartbeat process (survives session death) appends a line every
 *    5 min to `soak/<start-UTC>.jsonl`; the resumer verifies heartbeat
 *    continuity — a gap > 10 min invalidates the run and restarts the 24 h
 *    clock (recorded in CHECKPOINTS). Never stitch windows."
 *
 * "Never stitch windows" is why this tool reads exactly ONE heartbeat file and
 * refuses to merge two. Two 12 h windows are not a 24 h soak no matter how
 * adjacent they are, and the easiest way to accidentally claim otherwise is to
 * write a tool that accepts a list of files.
 *
 * ── WHY THIS FILE IS A MODULE AND NOT A SCRIPT (SOAK-RIG (b)/(c)) ──────────
 * It used to do all of the above at module scope: parse argv, read files and
 * `process.exit()` on import. That makes the verifier untestable — the only way
 * to exercise the >10 min gap rule was to run a real soak, which is precisely
 * the thing nobody gets to do twice. The grading logic now lives in
 * `verifySoak()`, a pure-ish function over file paths that RETURNS a verdict,
 * and the CLI is a thin `main()` that runs only when this file is the process
 * entry point. `tests/soak-rig.test.mjs` feeds it synthetic heartbeat files and
 * asserts PASS on a continuous 24 h window and FAIL on a gap, a short window
 * and a second file — so the guards are proven able to go red before the one
 * window that counts depends on them.
 *
 * Usage:
 *   node soak/verify-soak.mjs <heartbeat.jsonl> [trace.jsonl] [--hours 24]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_GAP_MS = 10 * 60_000;   // rule 8
export const EXPECT_EVERY_MS = 5 * 60_000;

/**
 * Split argv into positional file paths and flags.
 *
 * Track flag VALUES by index rather than by guessing from their shape. The
 * first version filtered positionals with `!/^\d+$/`, so `--hours 0.025`
 * left "0.025" looking like a third filename and the run was rejected as a
 * stitched window. A guard that fires on the wrong input is as bad as one that
 * never fires: it teaches you to pass --force.
 */
export function parseArgs(args) {
  const flagValueIdx = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) flagValueIdx.add(i + 1);
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : args[i + 1];
  };
  const files = args.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i));
  return { files, hours: Number(flag('hours', 24)) };
}

const readJsonl = (p) => fs.readFileSync(p, 'utf8')
  .split('\n').filter(Boolean)
  .map((l, i) => { try { return JSON.parse(l); } catch { return { __bad: i + 1, raw: l.slice(0, 80) }; } });

/**
 * Grade one soak window.
 *
 * @param {{ files: string[], hours?: number, log?: (s: string) => void }} opts
 * @returns {{ pass: number, fail: number, valid: boolean, usage?: true,
 *             refused?: string, checks: {name: string, ok: boolean, detail: string}[] }}
 *   `valid` is the verdict. `refused` is set for a caller error (no file, or —
 *   the rule this tool exists for — more than one heartbeat file), which is NOT
 *   the same as a graded-and-failed window and must not be reported as one.
 */
export function verifySoak({ files, hours = 24, log = () => {} }) {
  const checks = [];
  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    checks.push({ name, ok: !!cond, detail });
    if (cond) { pass += 1; log(`  ok   ${name}`); }
    else { fail += 1; log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  if (!files.length) {
    return { pass: 0, fail: 0, valid: false, usage: true, checks, refused: 'no heartbeat file given' };
  }
  if (files.length > 2) {
    // Refusing this is the whole "never stitch windows" rule in one guard.
    return {
      pass: 0, fail: 0, valid: false, checks,
      refused: 'refusing more than one heartbeat file: two windows are not one soak (NEW-MA-3)',
    };
  }

  const HEARTBEAT = files[0];
  const TRACE = files[1] || null;

  const hb = readJsonl(HEARTBEAT);
  const bad = hb.filter((x) => x.__bad);
  check('heartbeat file parses as JSONL', bad.length === 0,
    bad.length ? `${bad.length} unparseable line(s), first at ${bad[0].__bad}` : '');

  const beats = hb.filter((x) => !x.__bad && x.utc).map((x) => ({ ...x, t: Date.parse(x.utc) }))
    .sort((a, b) => a.t - b.t);
  check('heartbeat has a start and an end marker',
    beats.some((b) => b.kind === 'start') && beats.some((b) => b.kind === 'end'),
    beats.length ? `kinds seen: ${[...new Set(beats.map((b) => b.kind))].join(',')}` : 'no beats');

  // ── continuity: the rule that actually decides validity ──────────────────
  let worstGap = 0, worstAt = null;
  const gaps = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i].t - beats[i - 1].t;
    if (d > worstGap) { worstGap = d; worstAt = beats[i - 1].utc; }
    if (d > MAX_GAP_MS) gaps.push({ after: beats[i - 1].utc, before: beats[i].utc, minutes: +(d / 60000).toFixed(1) });
  }
  check(`no heartbeat gap over ${MAX_GAP_MS / 60000} min (rule 8)`, gaps.length === 0,
    gaps.length ? `${gaps.length} gap(s), worst ${(worstGap / 60000).toFixed(1)} min after ${worstAt}` : '');
  log(`       worst gap ${(worstGap / 60000).toFixed(1)} min (expected cadence ${EXPECT_EVERY_MS / 60000} min)`);

  // ── duration: a continuous window is not automatically a LONG ENOUGH one ─
  const first = beats[0], last = beats[beats.length - 1];
  const spanH = first && last ? (last.t - first.t) / 3600_000 : 0;
  check(`window spans at least ${hours} h`, spanH >= hours,
    `spanned ${spanH.toFixed(2)} h from ${first?.utc} to ${last?.utc}`);

  // Count-based cross-check. A file could span 24 h with four beats in it; the
  // gap check would catch that, but asserting the count too means a truncated
  // file cannot pass by being short at BOTH ends.
  const expected = Math.floor((spanH * 3600_000) / EXPECT_EVERY_MS);
  check('beat count is consistent with the span', beats.length >= expected * 0.95,
    `${beats.length} beats, expected about ${expected}`);

  // ── what the beats say about the pairs ───────────────────────────────────
  const held = beats.filter((b) => b.kind === 'hb');
  const bothOpen = held.filter((b) => b.onOpen === true && b.offOpen === true);
  check('both pairs were held open at every heartbeat',
    held.length > 0 && bothOpen.length === held.length,
    `${bothOpen.length}/${held.length} beats had both pairs open`);
  check('zero unexpected closes across the window',
    held.every((b) => (b.unexpectedCloses || 0) === 0),
    `max unexpectedCloses seen: ${Math.max(0, ...held.map((b) => b.unexpectedCloses || 0))}`);

  // One sha for the whole run. A heartbeat file whose sha changes mid-window is
  // a stitched window wearing one filename.
  const shas = [...new Set(beats.map((b) => b.sha).filter(Boolean))];
  check('one build sha for the whole window', shas.length === 1, `saw: ${shas.join(', ') || 'none'}`);

  // ── memory / CPU trend, from the trace ───────────────────────────────────
  if (TRACE && fs.existsSync(TRACE)) {
    const tr = readJsonl(TRACE).filter((x) => !x.__bad);
    const hourly = tr.filter((x) => x.kind === 'hourly' || x.kind === 'start' || x.kind === 'end');
    check('trace has at least one sample per hour of the window',
      hourly.length >= Math.floor(spanH), `${hourly.length} samples over ${spanH.toFixed(1)} h`);

    if (hourly.length >= 3) {
      const rss = hourly.map((x) => x.rssMb).filter((n) => typeof n === 'number');
      const firstThird = rss.slice(0, Math.max(1, Math.floor(rss.length / 3)));
      const lastThird = rss.slice(-Math.max(1, Math.floor(rss.length / 3)));
      const avg = (a) => a.reduce((s, n) => s + n, 0) / a.length;
      const growth = ((avg(lastThird) - avg(firstThird)) / avg(firstThird)) * 100;
      // A soak is hunting a slow leak, so the threshold is on the TREND, not on
      // any single peak. 25% over a day is generous for a steady-state relay and
      // still tight enough to catch a real leak.
      check('RSS did not grow more than 25% from the first third to the last',
        growth <= 25, `growth ${growth.toFixed(1)}% (${avg(firstThird).toFixed(1)}MB -> ${avg(lastThird).toFixed(1)}MB)`);
      log(`       rss ${Math.min(...rss).toFixed(1)}-${Math.max(...rss).toFixed(1)} MB over ${rss.length} samples`);
    }

    const end = tr.find((x) => x.kind === 'end');
    if (end) {
      check('runner ended because its window completed, not because it was killed',
        end.why === 'window-complete', `why=${end.why}`);
      check('final counters show traffic actually flowed',
        (end.counters?.framesSentOn || 0) > 0 && (end.counters?.framesSentOff || 0) > 0,
        JSON.stringify(end.counters || {}).slice(0, 200));
    }
  } else {
    log('  note trace file not supplied — memory/CPU trend not checked');
  }

  return { pass, fail, valid: fail === 0, checks };
}

/** The CLI. Returns the process exit code rather than calling process.exit(). */
export function main(argv) {
  const { files, hours } = parseArgs(argv);
  const r = verifySoak({ files, hours, log: (s) => console.log(s) });
  if (r.usage) {
    console.error('usage: node soak/verify-soak.mjs <heartbeat.jsonl> [trace.jsonl] [--hours 24]');
    return 2;
  }
  if (r.refused) { console.error(r.refused); return 2; }
  console.log(`\n  ${r.pass} passed, ${r.fail} failed`);
  console.log(r.valid
    ? `  VERDICT: VALID ${hours} h soak window`
    : '  VERDICT: INVALID — the 24 h clock restarts (record it in CHECKPOINTS; never stitch)');
  return r.valid ? 0 : 1;
}

// Entry-point guard. Importing this module must do nothing — no argv parsing,
// no file reads, no exit. tests/soak-rig.test.mjs asserts exactly that.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
