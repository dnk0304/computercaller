#!/usr/bin/env node
/**
 * tools/e2e-gate.mjs — the one command that is the gate for the E2E programme.
 *
 * Spec: e2e/E2E-P0-GATE-SPEC.md (Ken) + DISPATCH-BRIEF-E2E-P0 (b), which adds
 *   NEW-MA-1 read-only main-checkout mode
 *   NEW-MA-2 evidence JSON committed in the REPO under e2e-evidence/
 *   gradlew.bat for the android lane, `lint 0`, port-ownership check,
 *   refuse-without-env
 * and Security AUDIT-SECURITY-v2 N-3: the JSON records name/cmd/exit/ms/counts
 * ONLY — never captured stdout, never fixture content — and every string that
 * reaches it is CC-CANARY- redacted. Full output of a failing step goes to a
 * LOCAL log under .e2e-gate-logs/ which is gitignored and never mirrored.
 *
 * Usage:
 *   bun run e2e:gate [--phase P0] [--lane web|android|all] [--out e2e-evidence]
 *                    [--baseline] [--label <tag>]
 *
 * Exit codes:
 *   0  PASS
 *   1  FAIL (a step failed; the failing step is named in the JSON and stdout)
 *   2  REFUSED to run (wrong location, missing env, foreign port owner, lock)
 *
 * --baseline records e2e-evidence/BASELINE-harness.json (the step-10 parity
 * reference). It is the ONLY mode in which a P0+ artifact that does not exist
 * yet (sas-vectors, padding, session-superseded) is recorded as
 * `absent-at-base` instead of failing: BASE_SHA predates them by definition.
 * In every other mode a missing required test is a FAIL, never a skip.
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
// (c) The gate and the harnesses share ONE definition of "what did we spawn and
// is it still alive" — scripts/lib/reap.mjs. Rule 12/14 live in that file.
import { census, findLeaks } from '../scripts/lib/reap.mjs';
// (E2E-P0.3) The moving-base decision and the authored/inherited lint split,
// kept pure so tests/scope-base.test.mjs can pin them without a repository.
import { chooseScopeBase, splitGrown } from './lib/scope-base.mjs';
import { harnessesFor, KNOWN_PHASES, phaseTableProblems } from './lib/harness-list.mjs';
import { porcelainLines as porcelainOf, porcelainPath } from './lib/porcelain.mjs';
import { resolveJavaHome } from './lib/java-home.mjs';
// (E2E-P5a f3) Worktree/main location predicates, extracted so the gate no
// longer encodes the phase in the worktree name.
import { isGateWorktree, isGateMain } from './gate-location.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T_START = Date.now();
const LOGDIR = join(ROOT, '.e2e-gate-logs');

// ── arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : def;
};
const has = (name) => argv.includes(`--${name}`);
/**
 * R-B: run the Playwright harnesses concurrently instead of one after another.
 * OPT-IN, and deliberately not the default — see the note at the harness loop.
 */
const PARALLEL_HARNESSES = has('parallel-harnesses');

/**
 * (f) --phase is REQUIRED. It used to default to P0, and a P3 lane ran its
 * whole gate as P0 by accident: the phase-gated steps — ext-sw-lifetime-proof
 * among them — simply never ran, and the JSON said PASS. A step that was never
 * executed is not a step that passed, and a default that silently narrows the
 * gate is the most expensive kind of convenience.
 *
 * Refusing costs one flag. Every caller in the repo and in the briefs already
 * passes --phase.
 */
const PHASE_RAW = flag('phase', null);
if (!PHASE_RAW) {
  console.error(
    '\ne2e-gate: REFUSING TO RUN — --phase is required.\n'
    + '    usage: bun run e2e:gate --phase P<N> [--lane web|android|all] [--parallel-harnesses]\n'
    + '    e.g.:  bun run e2e:gate --phase P5A --parallel-harnesses\n\n'
    + '    It used to default to P0. A P3 lane ran its entire gate as P0 without noticing,\n'
    + '    which quietly skipped every phase-gated step (ext-sw-lifetime-proof included) and\n'
    + '    still reported PASS. Absent is not the same as passing.\n'
  );
  process.exit(2);
}
const PHASE = PHASE_RAW.toUpperCase();

/**
 * (b2) --phase is WHITELISTED, not merely required.
 *
 * Requiring the flag closed the "defaulted to P0" hole but left the opposite
 * one open: any string at all was accepted, and every phase-gated step in this
 * file is an `includes(PHASE)` membership test. A phase nobody recognises
 * therefore fails every one of those tests SILENTLY and the run still reports
 * PASS on a narrower gate than the caller asked for.
 *
 * That is not hypothetical. The MERGE lane ran `--phase MERGE`, executed 62 of
 * 69 steps, and destabilised the badge count to 24/42 — with no warning,
 * because "MERGE" was not in any of the membership lists below. A typo
 * ("--phase P5a2", "--phase D-1") would have done the same thing.
 *
 * So: the set of phases is enumerated in ONE place and an unrecognised value
 * exits 2 with usage rather than quietly narrowing the gate. Adding a phase is
 * a deliberate edit to this list — which is the point. Absent is not passing,
 * and neither is unrecognised.
 */
/**
 * FT-MERGE (e). KNOWN_PHASES, the per-harness runs/skips table and the coverage
 * rule all moved to tools/lib/harness-list.mjs, which is also where
 * harnessesFor() already lived. They were two tables that had to agree and did
 * not: after merging ft/3b into integration, harnessesFor('D1') returned the six
 * BASE harnesses, because this file's PHASE_HARNESSES named D1 and that file's
 * arrays did not. --phase D1 would have skipped ext-sw-lifetime-proof and
 * e2e-ui-proof and still printed PASS. One home, one decision.
 *
 * The gate keeps what is the gate's: the exit code and the usage text.
 */
const phaseProblems = phaseTableProblems();
if (phaseProblems.length) {
  for (const { harness, unknown, undecided, both } of phaseProblems) {
    console.error(
      `\ne2e-gate: REFUSING TO RUN — PHASE_HARNESSES["${harness}"] does not cover KNOWN_PHASES.\n`
      + (unknown.length ? `    not a known phase: ${unknown.join(', ')}\n` : '')
      + (undecided.length ? `    known phase with no decision: ${undecided.join(', ')}\n` : '')
      + (both.length ? `    listed in BOTH runs and skips: ${both.join(', ')}\n` : '')
      + '\n    Every known phase must be explicitly listed as running or skipping this\n'
      + '    harness. A phase that is merely missing would skip it silently, which is\n'
      + '    the defect this table exists to make impossible.\n',
    );
  }
  process.exit(2);
}
if (!KNOWN_PHASES.includes(PHASE)) {
  console.error(
    `\ne2e-gate: REFUSING TO RUN — unrecognised --phase "${PHASE_RAW}".\n`
    + `    known phases: ${KNOWN_PHASES.join(', ')}\n`
    + '    usage: bun run e2e:gate --phase P<N> [--lane web|android|all] [--parallel-harnesses]\n\n'
    + '    Every phase-gated step in this gate is an includes(PHASE) membership test, so an\n'
    + '    unrecognised phase does not error — it silently fails every one of them and still\n'
    + '    reports PASS on a gate narrower than you asked for. "--phase MERGE" once ran 62 of\n'
    + '    69 steps that way. A phase that is not on the list above has not been thought about;\n'
    + '    add it here deliberately rather than letting it through.\n'
  );
  process.exit(2);
}
const BASELINE = has('baseline');
const OUTDIR = join(ROOT, flag('out', 'e2e-evidence'));
const LABEL = flag('label', null);
/** P4 and P5b are the android phases; everything else is a web phase. */
const DEFAULT_LANE = ['P4', 'P5B'].includes(PHASE) ? 'android' : 'web';
const LANE = (flag('lane', DEFAULT_LANE) || DEFAULT_LANE).toLowerCase();
if (!['web', 'android', 'all'].includes(LANE)) refuse(`--lane must be web|android|all, got "${LANE}"`);
const WEB = LANE === 'web' || LANE === 'all';
const ANDROID = LANE === 'android' || LANE === 'all';

// ── N-3: nothing that reaches the JSON may carry a canary or fixture text ──
const redact = (s) =>
  String(s ?? '').replace(/CC-CANARY-[A-Za-z0-9_-]+/g, 'CC-CANARY-[redacted]');

function refuse(msg) {
  console.error(`\ne2e-gate: REFUSING TO RUN — ${msg}\n`);
  process.exit(2);
}

// ── location: a fixed e2e worktree, or the main checkout (read-only) ────────
const NORM = ROOT.replace(/\\/g, '/');
/**
 * (f2) ANY worktree under worktrees/computercaller, not just `e2e-p<N>`.
 *
 * The old pattern encoded the PHASE in the directory name, so the three `ft-*`
 * lanes could not run the gate at all — it refused before reading a single
 * flag. That was a naming convention doing an argument's job: `--phase` is
 * already REQUIRED (P5a slice 1 (f)), so the phase has exactly one source and
 * the directory name has none.
 *
 * What is still enforced is the part that actually matters: the run happens in
 * a worktree of THIS repo (where .e2e-lock gives one writer) or in the main
 * checkout (read-only). Only the phase-from-name coupling is removed.
 */
const IS_WORKTREE = isGateWorktree(NORM);
const IS_MAIN = isGateMain(NORM);
if (!IS_WORKTREE && !IS_MAIN) {
  refuse(
    `must run from a worktree under C:\\Users\\D\\worktrees\\computercaller\\ or the main checkout.\n` +
      `            The phase comes from --phase, not from the directory name.\n` +
      `            Got: ${ROOT}`
  );
}
/** NEW-MA-1: the main checkout is somebody's live working tree. Never destroy it. */
const READ_ONLY = IS_MAIN;

// ── env: the gate refuses without the harness env (rule 7) ─────────────────
/**
 * `.env.local` is the source of JWT_SECRET and nothing else the gate needs.
 *
 * DATABASE_URL is explicitly NOT read from it: this worktree's .env.local still
 * carries `file:./dev.db` from the retired sqlite rig (production has been
 * Postgres since 2026-05-24, see .gitignore). Importing it would hand Prisma a
 * dead sqlite path under a name that looks configured — the harness would fail
 * with a confusing Prisma error instead of the gate refusing with a clear one,
 * and worse, a future sqlite file appearing on disk would make it "work".
 * The harness DB is the operator's to supply, per rule 7.
 */
const ENV_LOCAL_NEVER = new Set(['DATABASE_URL']);
function loadEnvLocal() {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    if (ENV_LOCAL_NEVER.has(k)) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();
if (WEB) {
  const db = process.env.DATABASE_URL || '';
  if (!db) {
    refuse(
      'DATABASE_URL is not set in the environment. The /app harnesses cannot run without it.\n' +
      '            Expected: postgresql://pix:pix@localhost:15433/cc\n' +
      '            It is deliberately NOT read from .env.local — that file still holds the\n' +
      '            retired sqlite value (file:./dev.db), and silently handing that to Prisma\n' +
      '            is exactly the failure this refusal exists to prevent. Export it:\n' +
      '                DATABASE_URL=postgresql://pix:pix@localhost:15433/cc bun run e2e:gate ...'
    );
  }
  if (!db.startsWith('postgresql://')) {
    refuse(`DATABASE_URL is set but is not a postgresql:// URL (got "${db.split(':')[0]}:..."). Production is Postgres; the harnesses assume it.`);
  }
  if (!process.env.JWT_SECRET) refuse('JWT_SECRET is not set (expected in .env.local). The /app harnesses cannot mint a session without it.');
}

// ── process table (one CIM call): pid → {name, ppid} ────────────────────────
function processTable() {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const map = new Map();
  try {
    for (const p of JSON.parse(ps.stdout || '[]')) map.set(p.ProcessId, { name: p.Name, ppid: p.ParentProcessId });
  } catch { /* leave empty; callers treat an empty table as "cannot prove" */ }
  return map;
}
const PTABLE = processTable();
const alive = (pid) => PTABLE.has(Number(pid));
function ancestry(pid) {
  const chain = [];
  let cur = Number(pid);
  for (let i = 0; i < 40 && PTABLE.has(cur); i++) { chain.push(cur); cur = PTABLE.get(cur).ppid; }
  return chain;
}

// ── .e2e-lock: one writer per worktree (NEW-MA-1 / RESUME-PROTOCOL §1-2) ───
if (IS_WORKTREE) {
  const lockPath = join(ROOT, '.e2e-lock');
  if (!existsSync(lockPath)) {
    refuse(`no .e2e-lock in ${ROOT}. The phase owner writes "<PID> <UTC> <agent>" at start; one writer per worktree.`);
  }
  const lockPid = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0]);
  if (!Number.isFinite(lockPid)) refuse('.e2e-lock is malformed (expected "<PID> <UTC> <agent>").');

  /**
   * RESUME-PROTOCOL v2.1 lock liveness. A live PID proves NOTHING on this box:
   * every specialist subagent runs inside Niki's long-lived claude.exe, so a
   * task that died at 21:38 leaves a lock whose PID is still alive at 01:20.
   * A lock is HELD only when its PID is alive AND it is fresh — mtime < 90 min,
   * or the branch has a commit newer than the lock (the owner `touch`es the lock
   * at every commit, so an active run is always one or the other).
   */
  const LOCK_MAX_AGE_MS = 90 * 60_000;
  const lockMtime = statSync(lockPath).mtimeMs;
  const lockAgeMin = Math.round((Date.now() - lockMtime) / 60_000);
  const headMs = (() => {
    const t = Number((spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim());
    return Number.isFinite(t) ? t * 1000 : 0;
  })();
  const fresh = Date.now() - lockMtime < LOCK_MAX_AGE_MS || headMs > lockMtime;
  const held = alive(lockPid) && fresh;

  if (!held) {
    refuse(
      `.e2e-lock (PID ${lockPid}, ${lockAgeMin} min old) is STALE — ` +
        `${alive(lockPid) ? 'its PID is alive, but' : 'its PID is dead and'} ` +
        `the lock has not been touched for ${lockAgeMin} min and no commit is newer than it.\n` +
        `            A live PID is NOT evidence of a live run: specialist subagents share the\n` +
        `            long-lived claude.exe host PID, so a dead task leaves a live-PID lock.\n` +
        `            Reclaim it per RESUME-PROTOCOL v2.1 §1c (note the reclaim in CHECKPOINTS.md),\n` +
        `            then write a fresh lock and \`touch .e2e-lock\` at every commit.`
    );
  }

  const mine = ancestry(process.pid);
  const envPid = Number(process.env.E2E_LOCK_PID || NaN);
  if (!mine.includes(lockPid) && envPid !== lockPid) {
    refuse(
      `.e2e-lock holds live, fresh PID ${lockPid} (${lockAgeMin} min old), which is not in ` +
        `this run's process ancestry (${mine.join(' < ')}). Another writer owns this worktree.\n` +
        `            If YOU hold the lock, the shells between you and this process are\n` +
        `            short-lived and ancestry cannot prove it — assert it explicitly:\n` +
        `                E2E_LOCK_PID=${lockPid} bun run e2e:gate --phase ...`
    );
  }
}

// ── BASE_SHA ───────────────────────────────────────────────────────────────
function readBaseSha() {
  for (const p of [join(ROOT, 'e2e-evidence', 'BASE.md')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/BASE_SHA\s*=\s*`?([0-9a-f]{40})`?/i);
    if (m) return m[1];
  }
  return null;
}
const BASE_SHA = readBaseSha();
if (!BASE_SHA) refuse('e2e-evidence/BASE.md is missing or carries no 40-char BASE_SHA. Deliverable P0(a) must land first.');

/**
 * ── SCOPE_BASE: the MOVING base (E2E-P0.3) ─────────────────────────────────
 *
 * BASE_SHA answers "is this branch part of the programme?" and nothing else —
 * step 1 still asserts it as an ancestor of HEAD, unchanged. It stopped being
 * able to answer "what did THIS LANE change?" the moment lanes began branching
 * from the integration TIP instead of from 445138a: scope-diff then reports
 * every file every earlier lane landed, and the lint floor flags files that do
 * not exist at 445138a at all.
 *
 * So scope-diff and the lint floor measure against
 * `git merge-base origin/e2e/integration HEAD`. The decision itself lives in
 * tools/lib/scope-base.mjs so it can be unit-tested with no repository
 * (tests/scope-base.test.mjs); everything below is just gathering the facts.
 */
const INTEGRATION_REF = 'origin/e2e/integration';
const SCOPE_BASE = (() => {
  const g = (args) => (spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();
  // Fetch first: a stale remote-tracking ref would put the base BEHIND the tip
  // the lane actually branched from, re-introducing the same false FAIL in
  // miniature. A failed fetch is not fatal — chooseScopeBase falls back.
  spawnSync('git', ['fetch', '--quiet', 'origin', 'e2e/integration'],
    { cwd: ROOT, timeout: 180_000, stdio: 'ignore' });
  const tipSha = g(['rev-parse', '--verify', '--quiet', `${INTEGRATION_REF}^{commit}`]);
  const mergeBase = /^[0-9a-f]{40}$/.test(tipSha) ? g(['merge-base', INTEGRATION_REF, 'HEAD']) : null;
  const baseIsAncestorOfMergeBase = /^[0-9a-f]{40}$/.test(mergeBase || '')
    && spawnSync('git', ['merge-base', '--is-ancestor', BASE_SHA, mergeBase], { cwd: ROOT }).status === 0;
  return chooseScopeBase({ baseSha: BASE_SHA, tipSha, mergeBase, baseIsAncestorOfMergeBase });
})();

/**
 * ── SCRUBBED env ───────────────────────────────────────────────────────────
 * The gate loads `.env.local` so it can refuse without DATABASE_URL/JWT_SECRET
 * (rule 7). That load is a `process.env` mutation, and every child inherited it
 * — which is how `tests/www-origin.test.mjs` scored 4/8 under the gate and 8/8
 * standalone: the suite asserts the relay's default origin handling, and
 * NEXT_PUBLIC_APP_URL from .env.local overrode the default it was testing. The
 * test was right; the gate was lying to it.
 *
 * So relay + unit steps run with an allowlist env carrying NOTHING about this
 * app: the OS essentials a node process needs to start, resolve a binary and
 * open a temp file, and nothing else. Harness steps get this plus exactly the
 * app keys they need, passed EXPLICITLY (never leaked).
 */
const SCRUB_KEYS = [
  // named in the gate spec amendment
  'PATH', 'SystemRoot', 'TEMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ComSpec',
  // OS-level necessities that carry no application configuration: without
  // PATHEXT/ComSpec `shell: true` cannot resolve `node`, and TMP is TEMP's twin.
  'PATHEXT', 'SystemDrive', 'windir', 'TMP', 'NUMBER_OF_PROCESSORS',
];
const SCRUBBED = Object.fromEntries(
  SCRUB_KEYS.flatMap((k) => {
    // Windows env keys are case-insensitive; process.env is not, when spread.
    const hit = Object.keys(process.env).find((e) => e.toLowerCase() === k.toLowerCase());
    return hit && process.env[hit] != null ? [[hit, process.env[hit]]] : [];
  })
);

/**
 * ── declared assertion floors (Ken, 2026-09-17) ────────────────────────────
 *
 * Two lanes shipped a step that still read PASS while one of its checks had
 * been silently switched off — a mis-named option in one, duplicate keys in a
 * vector table in the other. Neither is visible in an exit code, because a
 * suite that runs 41 of its 42 checks and passes all 41 exits 0 and prints a
 * perfectly cheerful "41/41 checks passed".
 *
 * So every step that reports a count declares the number of checks it is known
 * to make, and the gate FAILS it when the count comes in BELOW that number.
 *
 * It is deliberately the TOTAL that is compared, not the passes. A disabled
 * check removes itself from both sides of "N/N", so only the denominator can
 * see it go; comparing passes would find nothing.
 *
 * Maintenance rule, same as LINT-BASELINE.json: a floor may only RISE, and it
 * rises in the commit that adds the checks ("[E2E-P<N>] min-checks raise").
 * Lowering one requires a named reason in the commit message — that is the
 * whole point of the mechanism, and a lane that lowers a floor to go green has
 * done the exact thing this catches.
 *
 * WHERE THE NUMBERS COME FROM. Mostly not from here: e2e-evidence/BASELINE-
 * harness.json already records, per step, the total this repo measured at the
 * parity baseline — a committed declaration that every lane already maintains.
 * Re-typing those 16 numbers into a second table would guarantee the two
 * disagree within a phase, so the floor is READ from that file and this table
 * holds only explicit overrides and steps the baseline does not cover.
 *
 * Note this is a strictly stronger check than the existing baseline-parity
 * step, which compares the run's passes against the reference and reports a
 * diff at the END. The floor fails the STEP, at the step, which is what makes
 * a silently-disabled check impossible to walk past.
 */
const MIN_CHECKS_OVERRIDE = {
  // Not in the parity baseline (a `unit:` step added after that file was
  // written), and until this commit it reported no count at all — see the
  // last-resort branch of passLine(). Measured: 13 assertions.
  'unit:bridge-origin-pin': 13,
  // FT-MERGE (c2). tests/e2e-ft-sw-union.test.mjs proves the background.js
  // UNION of P3.1's sealed passthrough and FT-3a's routing. It is RUN by the
  // `tests/e2e-*.test.mjs` sweep (step 7) like every other e2e-* suite, so it
  // is NOT re-listed in UNIT below — that would execute it twice and put two
  // disagreeing entries in the gate JSON. What it needs from this table is the
  // half the sweep does not give it: a declared floor, so a resolution that
  // silently drops half the union cannot take the count down with it and still
  // print a cheerful N/N. Measured: 44 assertions.
  'relay:e2e-ft-sw-union.test.mjs': 44,
  // FT-3b (g). The file-transfer harnesses post-date BASELINE-harness.json, so
  // the floor cannot be read from it. Measured totals at the commit that
  // registers them: ft-ui-proof 96 (FT-3b (d)), ft-web-proof 26 (FT-3a).
  'harness:ft-ui-proof': 96,
  'harness:ft-web-proof': 26,
  // The phase-list test itself. Measured 33. Not decoration: with FT3 removed
  // from the FT list the mutant drops to 31 TOTAL (two `scripts/<h>.mjs exists`
  // checks stop being generated), so the floor catches the deletion even if
  // someone also deletes the four checks that go red.
  // FT-MERGE (e) min-checks raise 33 -> 107: the fold moved KNOWN_PHASES and the
  // per-harness runs/skips table into this module, so the suite now asserts the
  // phase set, every phase's resolved list, the coverage rule and four controls
  // for the rule itself. Measured: 107.
  // E2E-P4.2 (e) min-checks raise 107 -> 130. Registering P4.2 in KNOWN_PHASES
  // generates three more checks (its resolved list, its no-FT-proofs arm, and
  // the frozen phase-set string). The floor was ALSO stale: the suite already
  // measured 127 on this lane's base 165f165, i.e. 20 checks above the number
  // guarding it, so a deletion of twenty assertions would have printed a
  // cheerful N/N. Re-measured here rather than bumped by three.
  'unit:harness-list': 130,
  // GATE-FOLD (a). tests/gate-porcelain.test.mjs — the ONE porcelain parser
  // (tools/lib/porcelain.mjs), asserted directly plus a reconstructed plant of
  // the pre-fix block-trim so the arms cannot be vacuous. Measured: 16.
  'unit:gate-porcelain': 16,
  // E2E-P4.2 (e). The android lane's test counts, read from the JUnit XML by
  // junitCounts(). These floors are the "0 tests ran = FAIL" rule: gradle exits
  // 0 and prints BUILD SUCCESSFUL for a run that executed nothing, so the exit
  // code cannot tell a passing suite from an absent one. Measured on
  // e2e/p4.2-a5-android at 9fac09c, AVD e2e_p42 (API 34):
  //   testDebugUnitTest 200 · instrumented-A5 8 (4 vectors + 2 observability
  //   + 2 vector-M) · SasVectorsTest 7.
  'android:testDebugUnitTest': 200,
  'android:instrumented-A5': 8,
  'android:SasVectorsTest': 7,
};
const MIN_CHECKS = (() => {
  const table = {};
  try {
    const ref = JSON.parse(readFileSync(join(OUTDIR, 'BASELINE-harness.json'), 'utf8'));
    for (const h of ref.harnessPass || []) {
      const t = h?.counts?.total ?? h?.total;
      if (typeof t === 'number' && h.name) table[h.name] = t;
    }
  } catch { /* no baseline yet — overrides still apply */ }
  return { ...table, ...MIN_CHECKS_OVERRIDE };
})();

// ── step runner ────────────────────────────────────────────────────────────
const steps = [];
/** Repo paths this run wrote — recorded in the JSON so a resumer commits them. */
const produced = [];
let failed = null;
const GITBASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']
  .find((p) => existsSync(p)) || 'bash';

function record(name, cmd, exit, ms, counts, extra = {}) {
  /**
   * The assertion floor, applied here rather than in run()/runAsyncStep() so
   * that BOTH paths — and anything else that records a count — are covered by
   * one piece of code. Only a step that CLAIMS success is judged: a step that
   * already failed, or was skipped, has a louder problem than its count.
   */
  const floor = MIN_CHECKS[name];
  let floorNote = null;
  if (floor != null && exit === 0 && !extra.skipped) {
    const total = typeof counts?.total === 'number' ? counts.total : null;
    if (total === null) {
      floorNote = `declares ${floor} checks but reported NO count at all — its pass line did not parse, `
        + 'so the gate cannot tell whether its checks ran';
    } else if (total < floor) {
      floorNote = `ran ${total} checks, declares ${floor} — ${floor - total} check(s) vanished. `
        + 'A suite that skips a check still prints "N/N passed", so this is the only place it shows.';
    }
    if (floorNote) {
      exit = 1;
      counts = { ...(counts || {}), minChecks: floor, ranChecks: total };
    }
  }

  const step = { name: redact(name), cmd: redact(cmd), exit, ms, counts: counts ?? null, ...extra,
    ...(floorNote ? { minChecksViolation: floorNote } : {}) };
  steps.push(step);
  const mark = step.skipped ? 'SKIP' : exit === 0 ? 'PASS' : 'FAIL';
  const detail = counts ? ` (${JSON.stringify(counts)})` : '';
  console.log(`  ${mark}  ${step.name}${detail}${step.skipped ? ` — ${step.skipped}` : ''}`);
  if (floorNote) console.log(`        min-checks: ${step.name} ${floorNote}`);
  if (mark === 'FAIL' && !failed) failed = step.name;
  return step;
}

function skip(name, cmd, reason) {
  return record(name, cmd, null, 0, null, { skipped: reason });
}

/**
 * Run one command. stdout/stderr go to a LOCAL log file (never committed,
 * never mirrored, never inlined into the JSON — N-3). `parse` may return a
 * counts object; it is the ONLY thing derived from output that survives.
 */
/**
 * `needs` names a step this one genuinely depends on (harnesses need the build,
 * not the lint). Independent steps keep running after a failure so ONE gate run
 * reports everything that is broken instead of one symptom at a time.
 */
/**
 * P5a slice 2 — KEEP THE OUTPUT OF EVERY FAILED ATTEMPT.
 *
 * Both retry loops used to write a log only when the FINAL attempt failed. A
 * step that failed attempt 1 and passed attempt 2 therefore recorded
 * `attempts: 2` and destroyed the only evidence of what went wrong. That is why
 * `app-in-call-shots`, `ext-in-call-shots` and
 * `ext-templates-scroll-call-message-proof` have carried "still needs attempts:2"
 * across four dispatches with nobody able to say WHY: the retry that made the
 * gate green was also deleting the diagnosis. The fix is one line in each loop.
 *
 * Only NON-FINAL failures land here (the final failure already writes the plain
 * `<phase>-<step>.log`), and only when a retry was actually configured, so a
 * normal green run writes nothing new.
 */
/**
 * (f) Did this step print a complete verdict before it was killed?
 *
 * Keyed on the PARSED count, not on a substring: the parser is the same one
 * `record()` floors against, so "it printed a summary" here means exactly what
 * it means everywhere else in this file. A partial run that never reached its
 * summary parses to null and is correctly NOT covered by this.
 */
/**
 * (f) Run `fn` over `items` with at most `limit` in flight.
 *
 * Deliberately not a dependency and deliberately tiny: it keeps a fixed window
 * of workers pulling from one shared cursor, so the Nth harness added to the
 * list cannot raise the load the first N-1 run under.
 */
async function runPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await fn(next);
    }
  });
  await Promise.all(workers);
}

function finishedButHung(out, counts) {
  return Boolean(counts && Number.isFinite(counts.total) && counts.total > 0);
}

function keepFailedAttempt(name, index, exit, out, attempts) {
  if (exit === 0 || attempts <= 1 || index >= attempts - 1) return;
  try {
    mkdirSync(LOGDIR, { recursive: true });
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const p = join(LOGDIR, `${PHASE}-${slug}-attempt${index + 1}.log`);
    writeFileSync(p, out);
    console.log(`  RETRY ${name} — attempt ${index + 1} failed (exit ${exit}); output kept at ${p.replace(/\\/g, '/')}`);
  } catch { /* evidence is best-effort; never fail a step over its own log */ }
}

function run(name, cmd, { cwd = ROOT, parse = null, env = {}, timeout = 15 * 60_000, needs = [], scrub = false, attempts = 1 } = {}) {
  const blocker = needs.find((n) => steps.some((s) => s.name === n && s.exit !== 0));
  if (blocker) return skip(name, cmd, `not run — depends on "${blocker}", which failed`);

  const t0 = Date.now();
  let out = '', exit = 1, counts = null, used = 0;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    used = i + 1;
    const r = spawnSync(cmd, {
      cwd, shell: true, encoding: 'utf8', timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: scrub ? { ...SCRUBBED, ...env } : { ...process.env, ...env },
    });
    out = `${r.stdout || ''}${r.stderr || ''}`;
    exit = r.status === null ? 124 : r.status;
    try { counts = parse ? parse(out, exit) : null; } catch { counts = null; }
    keepFailedAttempt(name, i, exit, out, attempts);
    if (exit === 0) break;
  }
  const ms = Date.now() - t0;
  // `attempts` is always recorded, not only when a retry happened, so flakiness
  // is a number somebody can trend rather than something the gate hides.
  if (used > 1) counts = { ...(counts || {}), attempts: used };

  if (exit !== 0) {
    mkdirSync(LOGDIR, { recursive: true });
    const log = join(LOGDIR, `${PHASE}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
    writeFileSync(log, out);
    return record(name, cmd, exit, ms, counts, { log: log.replace(/\\/g, '/') });
  }
  return record(name, cmd, exit, ms, counts);
}

/**
 * Async twin of run(), used ONLY by --parallel-harnesses (R-B). Same contract —
 * same retry semantics, same log file on failure, same record() entry — but it
 * spawns rather than spawnSync so several can be in flight at once.
 *
 * It is a separate function rather than a rewrite of run() on purpose: run() is
 * the path every PASS on this branch was measured through, and converting the
 * whole gate to async to add an opt-in flag would put every step's evidence at
 * risk for a runtime optimisation.
 */
function runAsyncStep(name, cmd, { cwd = ROOT, parse = null, env = {}, timeout = 15 * 60_000, needs = [], scrub = false, attempts = 1 } = {}) {
  const blocker = needs.find((n) => steps.some((st) => st.name === n && st.exit !== 0));
  if (blocker) { skip(name, cmd, `not run — depends on "${blocker}", which failed`); return Promise.resolve(); }

  const t0 = Date.now();
  const once = () => new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd, shell: true,
      env: scrub ? { ...SCRUBBED, ...env } : { ...process.env, ...env },
    });
    let out = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    /**
     * (f) Resolve on 'exit' rather than 'close'.
     *
     * HONEST SCOPE: this is a robustness improvement, NOT the fix for the P5A
     * timeouts, and it is not claimed as one. 'close' additionally waits for
     * every inherited stdio pipe to shut, which a surviving Chromium could in
     * principle hold — but tests/gate-child-exit.test.mjs measured that exact
     * shape on Windows and 'close' still arrived in ~179ms, so that theory was
     * DISPROVED rather than assumed. The real defect is the kill below.
     *
     * 'exit' is still the fact we want (the process ended), and the 250ms drain
     * keeps the summary line the parser needs. Kept because it costs nothing
     * and removes a dependency on grandchild behaviour we do not control.
     */
    let timer = setTimeout(() => {
      killTree(child.pid);
      done({ out, exit: 124 });
    }, timeout);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      timer = null;
      // 250ms to drain, then take what we have. Waiting on 'close' here would
      // reintroduce the exact hang this replaces.
      setTimeout(() => done({ out, exit: signal ? 124 : (code ?? 1) }), 250);
    });
    child.on('close', (code, signal) => {
      if (timer) { clearTimeout(timer); timer = null; }
      done({ out, exit: signal ? 124 : (code ?? 1) });
    });
    child.on('error', () => { if (timer) clearTimeout(timer); done({ out, exit: 1 }); });
  });

  return (async () => {
    let out = '';
    let exit = 1;
    let counts = null;
    let used = 0;
    for (let i = 0; i < Math.max(1, attempts); i++) {
      used = i + 1;
      const r = await once();
      out = r.out;
      exit = r.exit;
      try { counts = parse ? parse(out, exit) : null; } catch { counts = null; }
      /**
       * (f) R-AE: a step that produced a COMPLETE summary and was still
       * recorded as a timeout is a PASS-with-WARN, ONCE, and never a retry.
       *
       * This is the shape all three P5A timeouts had: the harness did the work
       * and printed its verdict, and the budget expired around it. Retrying
       * re-measures nothing and doubles the load that caused the overrun in the
       * first place — which is exactly how one slow harness took two others
       * down with it. The WARN keeps it visible so a step cannot quietly live
       * here forever instead of being made faster or given a real budget.
       */
      if (exit === 124 && finishedButHung(out, counts)) {
        console.log(`  WARN  ${name} — printed its summary (${counts?.passed}/${counts?.total}) `
          + 'and then did not exit; treated as PASS, not retried (P5a f). '
          + 'Its PID tree was killed; see reap: steps for survivors.');
        exit = counts && counts.passed === counts.total ? 0 : 1;
        counts = { ...(counts || {}), hungAfterSummary: 1 };
        break;
      }
      keepFailedAttempt(name, i, exit, out, attempts);
      if (exit === 0) break;
    }
    const ms = Date.now() - t0;
    if (used > 1) counts = { ...(counts || {}), attempts: used };
    if (exit !== 0) {
      mkdirSync(LOGDIR, { recursive: true });
      const log = join(LOGDIR, `${PHASE}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
      writeFileSync(log, out);
      record(name, cmd, exit, ms, counts, { log: log.replace(/\\/g, '/') });
      return;
    }
    record(name, cmd, exit, ms, counts);
  })();
}

/**
 * Parse the repo's pass line. There are three dialects in tree and the original
 * regex only knew one, so the parity reference recorded 2 of 7 suites — useless
 * as a regression baseline, because a suite it never recorded can never be seen
 * to regress.
 *   "22/22 passed"          pair-state, badge-counter
 *   "8/8 checks passed"     five harnesses
 *   "8 passed, 0 failed"    relay suites
 */
const passLine = (out) => {
  const slash = [...out.matchAll(/(\d+)\s*\/\s*(\d+)\s+(?:checks\s+)?passed/gi)].pop();
  if (slash) return { passed: Number(slash[1]), total: Number(slash[2]) };
  const pf = [...out.matchAll(/(\d+)\s+passed,\s*(\d+)\s+failed/gi)].pop();
  if (pf) return { passed: Number(pf[1]), total: Number(pf[1]) + Number(pf[2]) };
  // A fourth dialect: "21 assertion group(s) passed", "9 repro assertions
  // passed". Without this, reset-room, listener-heartbeat, repro-resume-sync
  // and bridge-origin-pin produce no counts — and a suite with no counts never
  // enters the parity reference, so a later failure there is invisible to
  // step 10. Four unprotected suites is not an acceptable parity baseline.
  const bare = [...out.matchAll(/(\d+)\s+[A-Za-z][A-Za-z()\s-]*?passed/gi)].pop();
  if (bare) return { passed: Number(bare[1]), total: Number(bare[1]) };
  /**
   * Last resort: count per-assertion lines directly.
   *
   * Two spellings, because the suites disagree: the older ones print "ok <m>",
   * and ext-bridge-origin-pin-proof prints "  PASS  <m>" / "  FAIL  <m>" with
   * no summary line at all. That suite ran 13 assertions and reported counts
   * of `null` to the gate for its whole life — so it was in the parity
   * reference for nothing, and an assertion could have been deleted from it
   * without any number moving. Counting the FAIL lines too keeps the
   * denominator honest when something is actually failing.
   */
  const oks = (out.match(/^\s*ok\b/gim) || []).length;
  if (oks > 0) return { passed: oks, total: oks };
  const passLines = (out.match(/^\s*PASS\s/gim) || []).length;
  const failLines = (out.match(/^\s*FAIL\s/gim) || []).length;
  if (passLines + failLines > 0) return { passed: passLines, total: passLines + failLines };
  return null;
};

// ── lint: a committed MANIFEST that may only shrink (GATE-SPEC amendment) ──
const LINT_MANIFEST_PATH = join(ROOT, 'e2e-evidence', 'LINT-BASELINE.json');

/**
 * `eslint . -f json` → { "<repo-relative/path>": { "<ruleId>": count } }, sorted.
 * Paths are forward-slashed and relative so the manifest is identical in every
 * worktree and on every box.
 */
function eslintManifest() {
  const r = spawnSync('bunx eslint . -f json', {
    cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
  });
  const raw = r.stdout || '';
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let results;
  try { results = JSON.parse(raw.slice(start)); } catch { return null; }

  const files = {};
  let problems = 0, errors = 0, warnings = 0;
  for (const f of results) {
    if (!f.messages || f.messages.length === 0) continue;
    const rel = String(f.filePath).replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, '');
    for (const m of f.messages) {
      const rule = m.ruleId || '(fatal)';
      files[rel] ??= {};
      files[rel][rule] = (files[rel][rule] || 0) + 1;
      problems++;
      if (m.severity === 2) errors++; else warnings++;
    }
  }
  // Deterministic key order — the manifest is diffed by humans and by git.
  const sorted = {};
  for (const k of Object.keys(files).sort()) {
    sorted[k] = Object.fromEntries(Object.keys(files[k]).sort().map((r2) => [r2, files[k][r2]]));
  }
  return { files: sorted, problems, errors, warnings };
}

/**
 * Compare a live manifest against the committed floor.
 * PASS iff every (file, rule) cell is <= the floor AND every pair absent from
 * the floor is 0 (a new file or a newly-triggered rule must be clean).
 *
 * A COUNT would be gameable — fix one unused var, add one `any`, total unchanged.
 * The cell-wise rule cannot be gamed that way: the new cell has no floor, so its
 * floor is 0.
 */
/**
 * Plan NEW-mi-4: "lint 0, or every remaining item named with an owner."
 * The react-hooks family cannot be fixed with no behaviour change, so it is
 * NAMED instead — per file, with a human owner, in the manifest header. The
 * mechanical remainder (unused vars, require-imports, img/alt) is a separate
 * dispatch on feature/saas-multiuser and reaches the programme via the rebase.
 */
function namedOwners(files) {
  const out = {};
  for (const [file, rules] of Object.entries(files)) {
    const hooks = Object.entries(rules).filter(([r]) => r.startsWith('react-hooks/'));
    if (hooks.length === 0) continue;
    out[file] = {
      owner: 'Forge',
      reason: 'react-hooks family — no fix exists that is provably behaviour-preserving; '
            + 'named per plan NEW-mi-4 rather than suppressed.',
      rules: Object.fromEntries(hooks),
    };
  }
  return out;
}

function lintCompare(live, floor) {
  const grown = [];
  let shrunk = 0;
  for (const [file, rules] of Object.entries(live.files)) {
    for (const [rule, n] of Object.entries(rules)) {
      const cap = floor?.files?.[file]?.[rule] ?? 0;
      if (n > cap) grown.push(`${file} :: ${rule} ${cap} -> ${n}`);
    }
  }
  for (const [file, rules] of Object.entries(floor?.files || {})) {
    for (const [rule, cap] of Object.entries(rules)) {
      if ((live.files?.[file]?.[rule] ?? 0) < cap) shrunk++;
    }
  }
  return { grown, shrunk };
}

// ── port ownership (WORKTREE_STANDARD rule 13) ─────────────────────────────
function portOwnerPid(port) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { encoding: 'utf8' }
  );
  const pid = Number((r.stdout || '').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
/**
 * P5a slice 2 — the scan START is RANDOM, and that is the whole point.
 *
 * This used to be a deterministic upward scan from a fixed 3300. Two gates
 * running on this box at the same time — which happened, and is why rule R-AA
 * now exists — both find 3300 free in the same instant and both take it: a
 * classic time-of-check/time-of-use collision that presents as one gate's
 * harnesses hitting the other gate's server. Combined with `attempts: 2`, an
 * attempt-1 collision is then guaranteed to produce a second, equally
 * misleading failure.
 *
 * A random start in a 2,000-port window makes an accidental collision between
 * two concurrent gates ~0.05% instead of certain, and the ownership check below
 * still refuses the port if something already holds it. R-AA remains the actual
 * rule; this is the belt to its braces.
 */
function freePort(from = 3300, span = 2000) {
  const start = from + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = from + ((start - from + i) % span);
    if (!portOwnerPid(p)) return p;
  }
  return null;
}

// ── harness dev server (started by the gate, killed by the gate, by PID) ───
let devProc = null;
let devPort = null;
/**
 * (d) The server's own output, kept in a ring buffer.
 *
 * It used to be `stdio: 'ignore'`, and that is how a fresh worktree with a
 * stale Prisma client turned into a two-hour diagnosis: the server printed
 * "@prisma/client did not initialize yet" and died, the gate saw only a port
 * that never opened, and EVERY extension harness then reported "signed-out" or
 * "service worker never registered" — six misleading symptoms for one cause
 * (e2e/LEARNINGS.md, P3-FU). The first compile is now allowed 120s and, if it
 * does not finish, the FAIL carries the server's actual error text.
 */
let devLog = '';
const DEV_LOG_MAX = 64 * 1024;
const noteDev = (buf) => {
  devLog = (devLog + buf.toString()).slice(-DEV_LOG_MAX);
};
/** The line worth surfacing, if there is one. */
function devFailureHint() {
  const prisma = /(@prisma\/client did not initialize yet[^\n]*|Prisma[^\n]*(?:generate|initialize|Client)[^\n]*|PrismaClientInitializationError[^\n]*)/i.exec(devLog);
  if (prisma) return `${prisma[1].trim()} — run \`bunx prisma generate\` in this worktree (WORKTREE_STANDARD).`;
  const err = /^(.*(?:Error|EADDRINUSE|MODULE_NOT_FOUND).*)$/m.exec(devLog);
  if (err) return err[1].trim();
  const tail = devLog.trim().split('\n').slice(-3).join(' | ');
  return tail ? `no error line found; last output: ${tail}` : 'the server produced no output at all';
}
function startDevServer() {
  devPort = freePort(3300);
  if (!devPort) return { ok: false, why: 'no free port >= 3300' };
  const owner = portOwnerPid(devPort);
  if (owner) return { ok: false, why: `port ${devPort} owned by PID ${owner}` };
  devLog = '';
  devProc = spawn('node', ['server.js'], {
    cwd: ROOT, detached: false, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, PORT: String(devPort), NODE_ENV: 'production' },
  });
  devProc.stdout.on('data', noteDev);
  devProc.stderr.on('data', noteDev);
  devProc.on('error', (e) => noteDev(Buffer.from(`spawn error: ${e.message}\n`)));
  return { ok: true };
}
/**
 * (f) THE FIX. Kill a timed-out step by its PID TREE.
 *
 * `child.kill()` on a step spawned with `shell: true` signals **cmd.exe only**.
 * The node harness and its Chromium survive. So at the 8-minute budget the gate
 * declared a timeout, LEFT THE WORK RUNNING, and started the retry on top of
 * it — doubling the very load that caused the overrun. The orphan kept writing
 * into the still-open pipe, which is precisely why three steps the gate called
 * timeouts have a COMPLETE summary in their kept attempt-1 logs, and why that
 * evidence reads like "finished, then hung" when it is really "never stopped".
 *
 * Pinned by tests/gate-child-exit.test.mjs with a positive control: the old
 * kill lets the work write a marker AFTER the kill lands; the tree kill does
 * not. By PID and only by PID (WORKTREE_STANDARD r12: never by image name).
 *
 * The companion half is the concurrency cap: ext-shell-theme-proof takes 409s
 * standalone against a 480s budget, so at 8-way parallelism it overruns no
 * matter how it is killed.
 */
function killTree(pid) {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

function stopDevServer() {
  // Rule 12: never kill by image name. Only the PID we started.
  if (devProc && devProc.pid) {
    try { spawnSync('taskkill', ['/PID', String(devProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  devProc = null;
}
async function waitForDev(port, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Fail FAST, not at the deadline: if the server process has already exited
    // there is nothing to wait for, and the two remaining minutes would only
    // delay the error text we already have.
    if (devProc && devProc.exitCode !== null) return false;
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 1000);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * ── clarity scope ──────────────────────────────────────────────────────────
 * Two halves in one script: STATIC (source + build output, always) and RUNTIME
 * (fetch every route, assert the tag is PRESENT on marketing HTML and ABSENT
 * from authed HTML — opt-in via CLARITY_SCOPE_BASE_URL).
 *
 * The baseline run scored this FAIL/skipped because the gate ran it with no
 * base URL: the runtime half silently disabled itself. The presence half is the
 * one that stops "we deleted Clarity entirely" reading as a green absence proof
 * (the absence-only vacuity trap), so a skip is a FAIL, never a pass — Security
 * f-2. The fix is to run it AFTER the gate-owned dev server, with the URL.
 */
function runClarityScope(baseUrl) {
  if (!existsSync(join(ROOT, 'scripts', 'check-clarity-scope.mjs'))) return;
  if (READ_ONLY && !existsSync(join(ROOT, '.next'))) {
    skip('clarity-scope', 'node scripts/check-clarity-scope.mjs', 'read-only main checkout with no .next to inspect');
    return;
  }
  run('clarity-scope', 'node scripts/check-clarity-scope.mjs', {
    needs: ['build'],
    env: baseUrl ? { CLARITY_SCOPE_BASE_URL: baseUrl } : {},
    parse: (out, exit) => {
      if (/runtime check skipped|skipping|no \.next/i.test(out)) {
        throw new Error('a skipped half is a FAIL (Security f-2)');
      }
      return { exit, buildChecked: 1, runtimeChecked: baseUrl ? 1 : 0 };
    },
  });
  // f-2: parse threw (or never ran) ⇒ a half was skipped ⇒ that is a FAIL.
  const last = steps[steps.length - 1];
  if (last.name === 'clarity-scope' && last.counts === null && last.exit === 0) {
    last.exit = 1;
    last.counts = { skipped: 1, runtimeChecked: baseUrl ? 1 : 0 };
    if (!failed) failed = 'clarity-scope';
    console.log('  FAIL  clarity-scope — a half was skipped; per Security f-2 that is a FAIL, not a pass');
  }
}

// ── resolve a test/script file by bare name ────────────────────────────────
function resolveIn(dir, base) {
  for (const ext of ['.test.mjs', '.test.js', '.test.ts', '.mjs', '.js']) {
    const p = join(ROOT, dir, base + ext);
    if (existsSync(p)) return `${dir}/${base}${ext}`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(
  `\ne2e-gate ${PHASE} lane=${LANE}${BASELINE ? ' [baseline]' : ''}${READ_ONLY ? ' [read-only main checkout]' : ''}\n` +
  `root=${ROOT}\nbase=${BASE_SHA.slice(0, 7)} (programme identity)\n` +
  `scope-base=${SCOPE_BASE.sha.slice(0, 7)} (${SCOPE_BASE.kind}` +
  `${SCOPE_BASE.fellBack ? ` — FELL BACK: ${SCOPE_BASE.reason}` : ` vs ${INTEGRATION_REF}`})\n`
);

const gitRaw = (a) => (spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout || '');
const gitOut = (a) => gitRaw(a).trim();
const SHA = gitOut(['rev-parse', 'HEAD']);

// ── 1. git identity, cleanliness, base ancestry ────────────────────────────
{
  const t0 = Date.now();
  const porcelain = porcelainOf(gitRaw(['status', '--porcelain']));
  const ALLOW = /(^|\/)(bun\.lock|\.e2e-lock|\.env\.local|\.e2e-gate-logs\/?|node_modules\/?)$/;
  /**
   * The gate's OWN evidence is not "a dirty tree". The baseline run failed its
   * own cleanliness check because it graded the artefacts it had just written —
   * a gate that cannot be run twice is not a gate. These paths are allowed, and
   * every one this run writes is listed in `produced` so the resumer knows
   * exactly what to commit.
   */
  /**
   * ANDROID-LINT (a3), CHECKPOINTS #159. `docs/screenshots/*.png` belongs in
   * the same category and for the same reason. Three of this gate's own
   * harnesses — scripts/e2e-ui-proof.mjs (p5a-*.png), dialpad-toggle-proof.mjs
   * and ext-text-size-proof.mjs — re-render into docs/screenshots/ at step 10,
   * i.e. AFTER this cleanliness check has already run. Attempt 1 in a fresh
   * tree therefore reads dirtyPaths 0 and attempt 2 in the SAME tree reads the
   * churn those harnesses just wrote and FAILs step 1 on the gate's own output.
   * FT-MERGE-2 (e) attempt 2 was aborted mid-run for exactly this.
   *
   * PNG bytes are not reproducible run-to-run (font hinting, compression
   * timestamps), so "commit them and they stop being dirty" is not a fix — the
   * next run dirties them again. The honest rule is the one already applied to
   * the JSON evidence: the gate does not grade the artefacts it writes, and
   * every one it writes is listed in `produced`. The harnesses are deliberately
   * NOT moved before step 1 — they need the dev server, which step 10 owns.
   */
  const OWN_OUTPUT = /^(e2e-evidence\/(gate-P[^/]*\.json|BASELINE-harness\.json|LINT-BASELINE(-android)?\.json)|docs\/screenshots\/[^/]+\.png)$/;
  const dirty = porcelain.filter((l) => {
    const p = porcelainPath(l);
    return !ALLOW.test(p) && !OWN_OUTPUT.test(p);
  });
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', BASE_SHA, 'HEAD'], { cwd: ROOT });
  const ok = dirty.length === 0 && anc.status === 0;
  record('git-identity-clean-base-ancestry',
    'git rev-parse HEAD && git status --porcelain && git merge-base --is-ancestor BASE_SHA HEAD',
    ok ? 0 : 1, Date.now() - t0,
    { dirtyPaths: dirty.length, baseIsAncestor: anc.status === 0 });
}

// ── 2. scope: a web phase touches no android, an android phase touches only android
/** Repo paths in `SCOPE_BASE..HEAD` — filled by step 2, read by the lint floor. */
let LANE_CHANGED = [];
{
  const t0 = Date.now();
  // E2E-P0.3: measured against SCOPE_BASE (the merge-base with the integration
  // tip), NOT BASE_SHA. Against BASE_SHA this step reported `android: 77` for a
  // lane whose own diff has zero android files — it was grading the lane on
  // every commit already merged into integration.
  const changed = gitOut(['diff', '--name-only', `${SCOPE_BASE.sha}..HEAD`]).split('\n').filter(Boolean);
  const android = changed.filter((f) => f.startsWith('dnkdialer-android/'));
  const nonAndroid = changed.filter((f) => !f.startsWith('dnkdialer-android/'));
  // FT-MERGE-2 (d1), Ken R-AU. Keyed on LANE, not DEFAULT_LANE.
  //
  // `--lane all` had no read path here: this line asked DEFAULT_LANE, which
  // is a pure function of PHASE, so `--phase D1 --lane all` still graded every
  // android file as off-lane and reported offLane 15 on the FT-MERGE gates —
  // the artefact R-AU rules is not a defect. It was also self-contradictory:
  // ANDROID is true under `all`, so the gate ran assembleDebug and lintDebug
  // over the very files it was calling out of scope.
  //
  // Under `all` BOTH lanes are in scope, so nothing is off-lane and the step
  // degrades to "did this lane change anything outside the repo?" — vacuously
  // true. It still reports `android` and `nonAndroid` counts, so the numbers
  // a reviewer reads are unchanged; only the PASS/FAIL predicate moves.
  const offSide = LANE === 'all' ? [] : (LANE === 'android' ? nonAndroid : android);
  record('scope-diff-vs-base', `git diff --name-only ${SCOPE_BASE.sha.slice(0, 7)}..HEAD`,
    offSide.length === 0 ? 0 : 1, Date.now() - t0,
    {
      changed: changed.length, android: android.length, nonAndroid: nonAndroid.length, offLane: offSide.length,
      scopeBase: SCOPE_BASE.sha, scopeBaseKind: SCOPE_BASE.kind,
      ...(SCOPE_BASE.fellBack ? { fellBackToBaseSha: 1, fallbackReason: redact(SCOPE_BASE.reason) } : {}),
    });
  // The lint floor uses the same file list, so the two steps can never disagree
  // about what this lane touched.
  LANE_CHANGED = changed;
}

if (WEB) {
  // ── 3. syntax ────────────────────────────────────────────────────────────
  for (const f of ['server.js', 'chrome-extension/background.js', 'chrome-extension/shell.js']) {
    run(`node-check:${f}`, `node --check ${f}`);
  }

  // ── 4. typescript ────────────────────────────────────────────────────────
  run('tsc-noEmit', 'bunx tsc --noEmit -p .', {
    parse: (out) => ({ errors: (out.match(/error TS\d+/g) || []).length }),
  });

  // ── lint: committed manifest that may only shrink ────────────────────────
  // The brief asked for "lint 0". eslint is NOT 0 at BASE_SHA — 176 problems /
  // 55 errors of pre-existing debt, of which ~24 are react-hooks-family items
  // that cannot be fixed without a behaviour change. Demanding 0 paints the gate
  // permanently red; declaring it 0 is a lie; a bare COUNT is gameable. So Ken's
  // ruling: a committed per-(file, rule) manifest that may only shrink.
  {
    const t0 = Date.now();
    const live = eslintManifest();
    if (!live) {
      record('lint', 'bunx eslint . -f json', 1, Date.now() - t0, { parsed: 0 });
    } else if (BASELINE && !existsSync(LINT_MANIFEST_PATH)) {
      // Generating the floor IS the baseline run's job.
      mkdirSync(join(ROOT, 'e2e-evidence'), { recursive: true });
      writeFileSync(LINT_MANIFEST_PATH, JSON.stringify({
        baseSha: BASE_SHA,
        utc: new Date().toISOString(),
        note: 'Per-(file, rule) lint floor. May only SHRINK. A phase that reduces a cell '
            + 'regenerates this file in its own commit "[E2E-P<N>] lint-baseline shrink". '
            + 'New files and newly-triggered rules have an implicit floor of 0.',
        namedOwners: namedOwners(live.files),
        totals: { problems: live.problems, errors: live.errors, warnings: live.warnings },
        files: live.files,
      }, null, 2) + '\n');
      produced.push('e2e-evidence/LINT-BASELINE.json');
      record('lint', 'bunx eslint . -f json (generate manifest)', 0, Date.now() - t0,
        { problems: live.problems, errors: live.errors, warnings: live.warnings, generated: 1 });
    } else {
      /**
       * E2E-P0.3. The floor is read from the COMMIT at SCOPE_BASE, never from
       * the working tree.
       *
       * Reading it from the working tree meant a lane could edit its own floor
       * and grade itself against the edit; the old defence was a "floor of
       * floors" diff against BASE_SHA's copy, which cannot survive a moving
       * base (a legitimate regeneration at the integration tip necessarily
       * contains files that do not exist at 445138a, so it read as GROWN and
       * would fail every lane forever). `git show <scope-base>:<path>` removes
       * the hole structurally instead: nothing this lane commits can change the
       * blob it is measured against, so the floor-of-floors check is gone and
       * the manifest is no longer rewritable into a pass.
       */
      const floorRev = `${SCOPE_BASE.sha}:e2e-evidence/LINT-BASELINE.json`;
      const floorShow = spawnSync('git', ['show', floorRev],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      let floor = null;
      if (floorShow.status === 0 && floorShow.stdout) {
        try { floor = JSON.parse(floorShow.stdout); } catch { floor = null; }
      }
      if (!floor) {
        record('lint', `git show ${floorRev.slice(0, 7)}...`, 1, Date.now() - t0,
          { problems: live.problems, errors: live.errors, warnings: live.warnings, manifestMissingAtScopeBase: 1 });
      } else {
        const { grown, shrunk } = lintCompare(live, floor);
        /**
         * With a moving base a cell can exceed the floor for two unrelated
         * reasons. The lane added a problem to a file it edited — its fault.
         * Or an EARLIER lane landed debt on integration without regenerating
         * the floor, and this lane merely inherited it — not its fault, and
         * exactly the `dnkdialer-android/tools/e2e-gate-android.mjs` false FAIL
         * that P5a-SW hit. The discriminator is this lane's own diff, the same
         * list step 2 reported, so the two steps cannot contradict each other.
         *
         * A lane still cannot go green on its own mess: edit the file at all
         * and every grown cell in it counts as authored again.
         */
        const { authored, inherited } = splitGrown(grown, LANE_CHANGED);
        const ok = authored.length === 0;
        if (grown.length) {
          // N-3: the JSON carries counts; the NAMES go to the local log only.
          mkdirSync(LOGDIR, { recursive: true });
          writeFileSync(join(LOGDIR, `${PHASE}-lint.log`),
            [...authored.map((g) => `AUTHORED ${g}`), ...inherited.map((g) => `INHERITED ${g}`)].join('\n') + '\n');
        }
        record('lint', `bunx eslint . -f json (vs ${floorRev.slice(0, 7)}:e2e-evidence/LINT-BASELINE.json)`,
          ok ? 0 : 1, Date.now() - t0,
          {
            problems: live.problems, errors: live.errors, warnings: live.warnings,
            grown: authored.length, inherited: inherited.length, shrunk,
            floorRev: SCOPE_BASE.sha,
          },
          ok ? {} : { log: join(LOGDIR, `${PHASE}-lint.log`).replace(/\\/g, '/') });
      }
    }
  }

  // ── 5. clean build ───────────────────────────────────────────────────────
  if (READ_ONLY) {
    skip('build', 'rm -rf .next && bun run build', 'read-only main checkout — never destroys another writer\'s .next');
  } else {
    try { rmSync(join(ROOT, '.next'), { recursive: true, force: true }); } catch { /* nothing to remove */ }
    run('build', 'bun run build', { needs: ['tsc-noEmit'], timeout: 20 * 60_000, parse: (out) => ({ routes: (out.match(/^[┌├└]\s/gm) || []).length }) });
  }

  // ── 6. extension packaging guard ─────────────────────────────────────────
  run('check-extension', `"${GITBASH}" tools/check-extension.sh`);

  /**
   * D1-PREP (a). The identity-leak guard runs as its OWN gate step, in addition
   * to the call check-extension.sh already makes.
   *
   * It is registered separately and SCOPE-INDEPENDENTLY on purpose. What it
   * guards is not a property of any one lane's diff: it scans the built client
   * output (.next/static/** and chrome-extension/**) for personal identities
   * and access-control env NAMES. A lane that touches no client code at all can
   * still ship a leak, because the leak travels by IMPORT CHAIN — that is
   * exactly how lib/entitlement-core.js reached a public _next/static chunk
   * through a 'use client' LoginForm. Gating this on "did this lane touch the
   * bundler" would make it blind to the only way the defect actually occurs.
   *
   * Nesting it inside check-extension.sh alone also made it invisible in the
   * gate JSON: a failure there was reported as "check-extension failed", which
   * is a packaging verdict, not a disclosure one. D1 ships to production and
   * needs the disclosure answer named in its own right.
   *
   * It needs the build, since .next/static does not exist before it.
   */
  run('check-no-identities', `"${GITBASH}" tools/check-no-identities.sh`, { needs: ['build'] });

  // ── 7. relay suites ──────────────────────────────────────────────────────
  const RELAY = ['pairing-persist', 'pair-state', 'dock-resume', 'reset-room', 'listener-heartbeat',
    'relink-kill-frame-buffer', 'call-separation', 'www-origin', 'repro-resume-sync',
    'session-superseded', 'log-redaction',
    // P1 — B8 authorization over the real ccpix DB. Not matched by the
    // `tests/e2e-*.test.mjs` sweep below, so it is named explicitly; a security
    // suite the gate never runs is a security suite that stops being true.
    'devicekey-authz',
    // FT-1 (2026-09-18). The relay half of file transfer: the accept-before-
    // chunks consent gate, the backpressure abort, the frameBuffer exclusion,
    // resume, and the tier + 2 GiB/day quota chokepoint. Named explicitly
    // because the `tests/e2e-*.test.mjs` sweep below does not match it, and a
    // security gate the gate never runs is a security gate that stops being
    // true.
    'ft-relay'];
  /** Delivered by a lane AFTER BASE_SHA. Only --baseline may excuse them. */
  const P0_NEW = new Set(['session-superseded', 'devicekey-authz', 'ft-relay']);
  /**
   * Suites that genuinely need the harness DATABASE_URL.
   *
   * The relay suites run under a SCRUBBED env on purpose — the P0 baseline run
   * found `.env.local` leaking into tests/www-origin and producing four false
   * FAILs. That scrub is correct and stays. But it means a DB-backed suite gets
   * no DATABASE_URL and refuses to start, which is what devicekey-authz did on
   * the first P1 run: "DATABASE_URL is required".
   *
   * So the DB URL is passed back EXPLICITLY, to the named suites only — exactly
   * the pattern step 9 already uses for the harnesses. Explicit beats widening
   * the scrub: the suites that must not see the ambient environment still
   * cannot, and the one that needs a database says so by name.
   */
  // FT-1: ft-relay's PART 11 enforces the 2 GiB/day quota against a REAL
  // PostgreSQL — the subject is an atomic INSERT … ON CONFLICT … WHERE over a
  // BIGINT column and a unique index, none of which a mock can be wrong about.
  const DB_BACKED = new Set(['devicekey-authz', 'ft-relay']);
  for (const base of RELAY) {
    const rel = resolveIn('tests', base);
    if (!rel) {
      if (BASELINE && P0_NEW.has(base)) skip(`relay:${base}`, `node tests/${base}`, 'absent-at-base (delivered by P0)');
      else record(`relay:${base}`, `node tests/${base}`, 1, 0, { missing: 1 });
      continue;
    }
    const env = DB_BACKED.has(base) ? { DATABASE_URL: process.env.DATABASE_URL || '' } : {};
    run(`relay:${base}`, `node ${rel}`, { parse: passLine, scrub: true, env });
  }
  for (const f of existsSync(join(ROOT, 'tests')) ? readdirSync(join(ROOT, 'tests')) : []) {
    if (/^e2e-.*\.test\.mjs$/.test(f)) run(`relay:${f}`, `node tests/${f}`, { parse: passLine, scrub: true });
  }

  // ── 8. unit: SAS vectors (web + SW context), padding property, bridge pin ─
  const UNIT = [
    ['sas-vectors', 'tests/sas-vectors.test.mjs', true],
    ['padding-property', 'tests/padding-property.test.mjs', true],
    // P0.2: the frozen key schedule + AEAD (§13.10 / Addendum A1). Same file the
    // Android lane's E2eKdfVectorsTest asserts, so a drift in either lane fails
    // its own build instead of surfacing as "Encrypted mode never pairs".
    ['kdf-vectors', 'tests/kdf-vectors.test.mjs', true],
    // Ken R-X(2). A STRUCTURAL guard over the same frozen file: unique vector
    // ids, an allowlist of top-level keys, and a reviewed manifest of the
    // duplicate-value groups. It exists because a rebase merged two spellings
    // of the same Security values into this file with NO conflict and every
    // value-level test stayed green — the duplicates were individually correct,
    // there were just supposed to be one of each.
    ['kdf-vectors-schema', 'tests/kdf-vectors-schema.test.mjs', true],
    // P5a-SW (b). The null-token verdict table + the wiring that routes both
    // of background.js's null paths through it. Named explicitly because the
    // sweep above only matches `tests/e2e-*.test.mjs`, and this file is not an
    // e2e-* file — a rule the gate never runs is a rule that stops being true.
    // ONLY e2e-gate.mjs change made by P5a-SW; declared in the résumé.
    ['ext-auth-absence', 'tests/ext-auth-absence.test.mjs', true],
    // P5a-SW (d) / Security A4.1-M1. The pin-provenance reply shapes AND the
    // diagnostics-only constraint (A4.1-M2: nothing may gate on a field a
    // wire-delivered ROOM_RESET can erase). Named for the same reason as the
    // line above — the sweep matches only tests/e2e-*.test.mjs.
    ['ext-pin-provenance', 'tests/ext-pin-provenance.test.mjs', true],
    // P0.3. The moving-base decision (tools/lib/scope-base.mjs) and the
    // authored/inherited lint split. Named explicitly — the sweep matches only
    // tests/e2e-*.test.mjs, and this is the rule that decides what every other
    // step considers "this lane's change". If it silently reverted to BASE_SHA
    // nothing would crash; the gate would just start grading lanes on 77 files
    // they never touched again.
    ['scope-base', 'tests/scope-base.test.mjs', true],
    // D1-PREP (b2). --phase is whitelisted, not merely required. Named
    // explicitly for the same reason as the lines above — the sweep matches
    // only tests/e2e-*.test.mjs. This is the rule that stops an unrecognised
    // phase from silently failing every includes(PHASE) membership test in
    // this file and reporting PASS on a hollow gate ("--phase MERGE" ran 62 of
    // 69 steps that way). Carries its own positive control, so narrowing
    // KNOWN_PHASES turns it red instead of turning the gate quiet.
    ['gate-phase-whitelist', 'tests/gate-phase-whitelist.test.mjs', true],
    // GATE-JAVA-HOME. tools/lib/java-home.mjs decides whether the android
    // lane runs at all. Named explicitly (the sweep matches only
    // tests/e2e-*.test.mjs) because its silent-failure mode is the one this
    // gate is worst at reporting: trust a stale JAVA_HOME and all three
    // gradle steps come back exit 9009 in ~30 ms, which reads as "the android
    // lane failed" rather than "the gate never ran".
    ['gate-java-home', 'tests/gate-java-home.test.mjs', true],
    // FT-MERGE (c2) is deliberately ABSENT from this list: see
    // MIN_CHECKS_OVERRIDE['relay:e2e-ft-sw-union.test.mjs'] above. The sweep in
    // step 7 matches tests/e2e-*.test.mjs and already runs it; its count is
    // pinned by the floor table rather than by a second registration here.
    // FT-3b (g). WHICH harnesses each phase runs (tools/lib/harness-list.mjs).
    // Named explicitly for the same reason as the lines above — the sweep
    // matches only tests/e2e-*.test.mjs — and because a step quietly absent
    // from a phase's list is the one failure mode the gate cannot report.
    ['harness-list', 'tests/harness-list.test.mjs', true],
    // GATE-FOLD (a). tools/lib/porcelain.mjs, the single `git status
    // --porcelain` parser behind step 1's cleanliness filter and the
    // ANDROID-LINT enumeration. Named explicitly (the sweep matches only
    // tests/e2e-*.test.mjs) because its failure mode is a phantom dirtyPaths:1
    // on a clean tree — a red gate about the parser, not about the repo.
    ['gate-porcelain', 'tests/gate-porcelain.test.mjs', true],
    // SOAK-RIG (c). 48 checks. The R-AM soak rig: that importing soak-runner /
    // verify-soak / relay-auth starts no clock and opens no socket, and that
    // verify-soak's rule-8 guards can actually go RED — a >10 min gap, a <24 h
    // window, a mid-window sha change and a second heartbeat file are each
    // asserted BY NAME against fixtures from one generator whose clean 24 h
    // window passes. Named explicitly because the sweep above matches only
    // `tests/e2e-*.test.mjs`.
    //
    // It is in the gate because the soak's verdict is a one-shot: the 24 h
    // window is not repeatable on a whim, and until this file existed the gap
    // rule had never once been observed to fire. A guard nothing exercises is
    // a comment. Node-only — no browser, no Docker, no database (rule 17).
    // ONLY e2e-gate.mjs change made by SOAK-RIG; declared in the résumé.
    ['soak-rig', 'tests/soak-rig.test.mjs', true],
    // SOAK-RIG-2. The handshake proof, against the SHIPPED relay.
    //
    // Every other relay suite in tests/ mirrors server.js's state machine by
    // hand. A mirror cannot prove a CLIENT speaks the protocol the shipped
    // relay implements — the mirror and the client are written by the same hand
    // and agree by construction. That is exactly how the soak runner shipped
    // without a Connect+Accept handshake and soaked the lobby for a whole
    // window (Hetzner 2026-09-20T02:32Z): four authed sockets, zero 4401, zero
    // frames forwarded, and a verifier grading `framesSent`.
    //
    // So this one boots server.js for real (tests/lib/relay-boot.cjs stubs only
    // `next`) on an ephemeral port, runs the REAL soak/soak-runner.mjs against
    // it, and carries the plant: the same client with the handshake removed,
    // which must forward nothing and must be graded INVALID. DB-backed — it
    // needs the harness DATABASE_URL, passed explicitly below for the same
    // reason devicekey-authz does. Node-only: no browser (rule 17).
    ['soak-handshake', 'tests/soak-handshake.test.mjs', true],
  ];
  // The one unit suite that needs a database, named for the same reason
  // DB_BACKED names devicekey-authz above: explicit beats widening the scrub.
  const UNIT_DB_BACKED = new Set(['soak-handshake']);
  for (const [name, rel, isNew] of UNIT) {
    if (!existsSync(join(ROOT, rel))) {
      if (BASELINE && isNew) skip(`unit:${name}`, `node ${rel}`, 'absent-at-base (delivered by P0)');
      else record(`unit:${name}`, `node ${rel}`, 1, 0, { missing: 1 });
      continue;
    }
    const unitEnv = UNIT_DB_BACKED.has(name) ? { DATABASE_URL: process.env.DATABASE_URL || '' } : {};
    run(`unit:${name}`, `node ${rel}`, { parse: passLine, scrub: true, env: unitEnv, timeout: 10 * 60_000 });
  }
  // E2E-P2 (g-node), Ken R-L. The live-peer harness: both ends driven for real
  // over a socket, with the relay's OWN lib/e2eBlock-core.js doing the block
  // validation and a drift guard over server.js. Named explicitly because it is
  // a script, not a tests/e2e-*.test.mjs file, and so is matched by no sweep —
  // and a cross-lane harness the gate never runs is a harness that stops being
  // true. ONLY e2e-gate.mjs change made by P2; declared in the résumé.
  if (existsSync(join(ROOT, 'scripts', 'e2e-live-peer-proof.mjs'))) {
    run('unit:live-peer', 'node scripts/e2e-live-peer-proof.mjs', { parse: passLine, scrub: true });
  } else if (!BASELINE) {
    record('unit:live-peer', 'node scripts/e2e-live-peer-proof.mjs', 1, 0, { missing: 1 });
  }

  // E2E-P2.1. The `cc-e2e` schema proved against REAL IndexedDB in a real
  // Chromium, because the bug it guards was a disagreement about IndexedDB's
  // own upgrade semantics that every injected-factory unit suite passed
  // straight through. Arm 0 asserts the ORIGINAL defect, so a green run also
  // proves the harness can still tell the two states apart.
  if (existsSync(join(ROOT, 'scripts', 'e2e-idb-migration-proof.mjs'))) {
    run('unit:idb-migration', 'node scripts/e2e-idb-migration-proof.mjs', { parse: passLine, scrub: true });
  } else if (!BASELINE) {
    record('unit:idb-migration', 'node scripts/e2e-idb-migration-proof.mjs', 1, 0, { missing: 1 });
  }

  if (existsSync(join(ROOT, 'scripts', 'ext-bridge-origin-pin-proof.mjs'))) {
    run('unit:bridge-origin-pin', 'node scripts/ext-bridge-origin-pin-proof.mjs', { parse: passLine, scrub: true });
  } else {
    record('unit:bridge-origin-pin', 'node scripts/ext-bridge-origin-pin-proof.mjs', 1, 0, { missing: 1 });
  }

  // ── 8b. E2E-P6 proofs that drive the REAL relay ──────────────────────────
  //
  // These four are NOT scrubbed, and that is the whole difference between them
  // and every step above.
  //
  // The relay suites run under SCRUBBED on purpose — the P0 baseline found
  // .env.local leaking into tests/www-origin and producing four false FAILs.
  // But these steps start an actual `node server.js` against an actual scratch
  // Postgres, so a scrubbed env leaves them with no DATABASE_URL and the relay
  // refuses to boot. Worse, the relay authenticates at the WS upgrade behind a
  // fail-closed entitlement gate: without credentials every socket is closed
  // 4401 before a single frame exists, and a harness counting `open` events
  // would report healthy sockets while measuring nothing at all. So they get
  // DATABASE_URL explicitly, the way devicekey-authz does, and nothing else
  // from the ambient environment.
  //
  // Gated to P6 and later because they are P6 deliverables and did not exist at
  // BASE_SHA; running them under an earlier --phase would report `missing` for
  // a file that was never supposed to be there yet.
  if (['P6', 'P6.1', 'P7', 'P8', 'D1'].includes(PHASE)) {
    const P6_REAL_RELAY = [
      // (e) 10,000 frames across a resume, counters asserted on all three lanes.
      ['p6:replay', 'scripts/e2e-replay-proof.mjs'],
      // (i) CC-CANARY in an SMS + notification body: log, heap and store greps.
      ['p6:canary', 'scripts/e2e-canary-proof.mjs'],
      // (h) the tampering proxy in front of the real relay: strip, downgrade,
      //     replayed epoch, forged same-origin pubkey.
      ['p6:staging-relay', 'scripts/e2e-staging-relay-proof.mjs'],
      // (g) cross-implementation. Emits its cross-match table as JSON.
      ['p6:cross-impl', 'scripts/e2e-cross-impl-proof.mjs'],
    ];
    for (const [name, rel] of P6_REAL_RELAY) {
      if (!existsSync(join(ROOT, rel))) {
        // Never a silent skip. A P6 proof that is absent at --phase P6 is a
        // deliverable that did not land, and the gate has to say so — the
        // "gate step that ran nothing" failure is exactly what this avoids.
        record(name, `node ${rel}`, 1, 0, { missing: 1 });
        continue;
      }
      run(name, `node ${rel}`, {
        parse: passLine,
        env: { DATABASE_URL: process.env.DATABASE_URL || '' },
        // Real relay boot + Chromium + 10k frames; the default 15 min is tight.
        timeout: 30 * 60_000,
      });
    }
  }

  // ── 9. harnesses against a dev server the gate owns ──────────────────────
  // FT-3b (g). The per-phase list lives in tools/lib/harness-list.mjs, pure,
  // so tests/harness-list.test.mjs can assert WHICH steps a phase runs. It was
  // a local const here, which meant a step missing from a phase failed nothing
  // — the P3.1 "the phase list silently skipped a step" lesson.
  const HARNESS = harnessesFor(PHASE);
  if (!steps.some((s2) => s2.name === 'build' && s2.exit !== 0)) {
    const started = startDevServer();
    if (!started.ok) {
      record('harness-dev-server', 'node server.js (gate-owned)', 1, 0, { why: 1 });
      console.log(`  FAIL  harness-dev-server — ${started.why}`);
      runClarityScope(null);
    } else {
      const tDev = Date.now();
      const up = await waitForDev(devPort, 120_000);
      // (d) stale-Prisma guard. A dev server that never opened its port is the
      // single cause behind the "every extension harness says signed-out"
      // symptom, and the reason is always in ITS output, never in the harness's.
      const why = up ? null : redact(devFailureHint());
      record('harness-dev-server', `node server.js PORT=${devPort}`, up ? 0 : 1, Date.now() - tDev,
        { port: devPort, pid: devProc?.pid ?? 0, ...(up ? {} : { timedOutMs: Date.now() - tDev }) },
        up ? {} : { why });
      if (!up) console.log(`  FAIL  harness-dev-server — first compile did not finish in 120s: ${why}`);
      if (up) {
        const origin = `http://127.0.0.1:${devPort}`;

        // Clarity's runtime half needs a live server, so it belongs HERE, not
        // next to the build. Its static/build half runs in the same invocation.
        runClarityScope(origin);

        /**
         * The harnesses' env is BUILT, not inherited. The baseline run failed
         * app-in-call-shots on Prisma "URL must start with postgresql://" and
         * ext-layering-shots on ERR_CONNECTION_REFUSED at :3178 — two faces of
         * one bug: whatever happened to be in the ambient env decided what the
         * child saw. Now every key a harness reads is passed explicitly, and
         * nothing else is. `CC_BASE_URL` is included because ext-layering-shots
         * reads that name, not DEV_URL; the harness scripts are Pixel's files
         * and the gate does not edit them to match its own assumptions.
         */
        const dbUrl = process.env.DATABASE_URL || '';
        const harnessEnv = {
          ...SCRUBBED,
          DATABASE_URL: dbUrl,
          JWT_SECRET: process.env.JWT_SECRET || '',
          PORT: String(devPort),
          DEV_URL: origin,
          BASE_URL: origin,
          CC_BASE_URL: origin,
          /**
           * D1-PREP (a). The screenshot harnesses mint a REAL session for a
           * REAL user, and as of dispatch forge/w-strip-email-literals they
           * REFUSE to guess who: `requireShotEmail()` throws when
           * CC_SHOT_EMAIL is unset, because the default used to be a personal
           * address hardcoded in the repo.
           *
           * SCRUBBED strips everything not named here, so before this line the
           * variable could not reach a harness even when the operator had set
           * it — and every shot harness died on the throw. That failure is a
           * MERGE INTERACTION, not a fault in either branch: the product branch
           * made the value mandatory, the e2e branch owns the gate that runs
           * these harnesses, and neither half fails on its own.
           *
           * The gate passes the operator's value through rather than inventing
           * one. Supplying a default here would re-introduce exactly the
           * hardcoded identity that dispatch removed.
           */
          CC_SHOT_EMAIL: process.env.CC_SHOT_EMAIL || '',
        };
        // Assert before step 9 rather than discovering it as a Prisma error.
        // CC_SHOT_EMAIL is asserted for the same reason and in the same place:
        // a missing value is an operator/env fact, and it should be named once
        // here rather than rediscovered as six identical harness stack traces.
        const shotEmailSet = Boolean(harnessEnv.CC_SHOT_EMAIL);
        record('harness-env', 'assert DATABASE_URL + CC_SHOT_EMAIL reach the harness env',
          (dbUrl.startsWith('postgresql://') && shotEmailSet) ? 0 : 1, 0,
          { dbUrlSet: dbUrl ? 1 : 0, jwtSet: process.env.JWT_SECRET ? 1 : 0, ccBaseUrlSet: 1,
            shotEmailSet: shotEmailSet ? 1 : 0 });

        /**
         * R-B asked P1 to deliver --parallel-harnesses to bring the runtime
         * under the ceiling. It is delivered, and it is OPT-IN, because the two
         * standing rulings pull against each other:
         *
         *   R-B wants the harnesses faster.
         *   R-C records that these same harnesses are FLAKY UNDER LOAD —
         *   ext-badge-counter-proof and ext-shell-theme-proof lose checks when
         *   the box is busy — and the source fix is Pixel's, unfixed until P5a.
         *
         * Running them concurrently is deliberately adding load to the exact
         * harnesses whose load sensitivity is the known open defect. Making that
         * the default would trade a runtime number for a gate that goes red at
         * random, which R-C already identifies as the worse failure. So the flag
         * exists and the sequential path stays the default until P5a fixes the
         * flake at source; the measured comparison is in the P1 résumé.
         */
        const harnessSpecs = HARNESS.map((h) => ({ h, rel: `scripts/${h}.mjs` }))
          .filter(({ h, rel }) => {
            if (existsSync(join(ROOT, rel))) return true;
            record(`harness:${h}`, `node ${rel}`, 1, 0, { missing: 1 });
            return false;
          });
        const harnessOpts = () => ({
            needs: ['harness-dev-server', 'harness-env'],
            parse: passLine,
            env: harnessEnv,
            scrub: true,
            /**
             * Playwright harnesses drive a real browser and a real MV3 service
             * worker, and they are measurably flaky under load: the baseline run
             * scored ext-badge-counter-proof 39/42 with three consecutive checks
             * reading "signed-out" where they expected "held" — the SW had not
             * finished re-signing-in. Standalone, the same harness scores 42/42.
             * It reads no env at all (zero `process.env` references), so the
             * scrub cannot be the cause.
             *
             * ONE retry, and the attempt count lands in the JSON. A gate that
             * goes red at random teaches everyone to ignore it, which is the
             * same failure as a gate that is permanently red; a real break still
             * fails twice. Flagged to Ken as a harness-side flake to fix at
             * source — this is a gate making the signal usable, not a fix.
             */
            attempts: 2,
            timeout: 8 * 60_000,
          });
        /**
         * (c) WORKTREE_STANDARD rule 14, enforced rather than requested.
         *
         * A harness that returns while its Chromium is still running is a gate
         * FAIL, not a note: sixty-odd orphaned chrome.exe crashed Dennis's PC
         * this week, and the same orphans are the load that makes these very
         * harnesses flaky. Detection is entirely PID-based — a survivor counts
         * only if it appeared during this step AND its parent is dead or sits
         * inside the gate's own process tree. Rule 12 holds: nothing is ever
         * matched or killed by image name, and explorer.exe's tree (Dennis's
         * own browser and terminals) is excluded transitively.
         *
         * The gate-owned dev server is allow-listed — it outlives every harness
         * by design and stopDevServer kills it by PID below.
         */
        const allowPids = [devProc?.pid].filter(Boolean);
        const assertNoLeaks = (label, before) => {
          const { leaked, pids } = findLeaks(before, process.pid, { allow: allowPids });
          record(`reap:${label}`, 'assert no browser/node survived the harness (by PID)',
            leaked === 0 ? 0 : 1, 0, { leaked });
          if (leaked) {
            console.log(`  FAIL  reap:${label} — ${leaked} process(es) left running: `
              + pids.map((p) => `${p.name}#${p.pid}(ppid ${p.ppid}, ${p.why})`).join(', '));
          }
        };

        const tHarness = Date.now();
        if (PARALLEL_HARNESSES) {
          // In parallel mode a per-harness census would see its SIBLINGS' live
          // browsers and call them leaks, so the assertion is made once, after
          // the batch. Same rule, one measurement point — and it is recorded
          // under a name that says so rather than pretending to be per-harness.
          const beforeBatch = census();
          /**
           * (f) R-AE: CONCURRENCY IS CAPPED AT 6, measured rather than guessed.
           *
           * P5a slice 2 added an eighth harness to this block and the run that
           * followed put THREE of them past the 8-minute budget — the first
           * time that had happened with seven. Unbounded Promise.all makes the
           * degree of parallelism an accident of how many harnesses happen to
           * exist, so every harness added to the list silently raises the
           * failure rate of every harness already in it.
           *
           * A fixed window keeps the runtime win R-B asked for while making the
           * load a constant. 6 is the last count that ran clean on this box.
           */
          await runPool(harnessSpecs, 6, ({ h, rel }) =>
            runAsyncStep(`harness:${h}`, `node ${rel}`, harnessOpts(rel)));
          assertNoLeaks('harness-batch', beforeBatch);
        } else {
          for (const { h, rel } of harnessSpecs) {
            const beforeStep = census();
            run(`harness:${h}`, `node ${rel}`, harnessOpts(rel));
            assertNoLeaks(h, beforeStep);
          }
        }
        // Recorded either way so the sequential/parallel comparison is a number
        // in the JSON rather than a claim in a résumé.
        record('harness-mode', PARALLEL_HARNESSES ? 'parallel' : 'sequential', 0, Date.now() - tHarness,
          { parallel: PARALLEL_HARNESSES ? 1 : 0, harnesses: harnessSpecs.length });
      } else {
        runClarityScope(null);
      }
      stopDevServer();
    }
  } else {
    skip('harness-dev-server', 'node server.js (gate-owned)', 'not run — depends on "build", which failed');
    runClarityScope(null);
  }
}

// ── 11. android lane ───────────────────────────────────────────────────────
if (ANDROID) {
  const AROOT = join(ROOT, 'dnkdialer-android');
  if (!existsSync(join(AROOT, 'gradlew.bat'))) {
    record('android:gradlew-present', 'dnkdialer-android/gradlew.bat', 1, 0, { missing: 1 });
  } else {
    /**
     * ANDROID-LINT (a1), CHECKPOINTS #158. ABSOLUTE, QUOTED path — never a bare
     * `gradlew.bat`. A bare name is only resolvable because cmd.exe searches the
     * current directory, and Windows turns that search OFF when the environment
     * carries `NoDefaultCurrentDirectoryInExePath=1`. FT-MERGE-2 (e) attempt 1
     * lost BOTH android steps to "'gradlew.bat' is not recognized" in a shell
     * that happened to carry it — a gate verdict that depended on an env var
     * nobody set deliberately. Same pattern as
     * dnkdialer-android/tools/e2e-gate-android.mjs:122.
     */
    const gradlew = `"${join(AROOT, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}"`;

    /**
     * GATE-JAVA-HOME. ANDROID-LINT-2 run 1 lost all three gradle steps below
     * to exit 9009 in 31 ms: "JAVA_HOME is not set and no java command could
     * be found in your PATH". None of these calls passes `scrub: true`, so
     * they inherit process.env verbatim — the lane's verdict was decided by
     * whether the invoking shell happened to export JAVA_HOME. That is an
     * environment non-run wearing a lane result's clothes.
     *
     * So the gate derives it itself and injects it explicitly, and records
     * WHICH jdk graded the lane in the step's meta. No JDK is a LOUD FAIL
     * plus three skips — never a silent PASS, same shape as
     * `android:gradlew-present`. The two run() calls inherit that via
     * `needs`, which already writes the "depends on X, which failed" skip.
     */
    const javaHome = resolveJavaHome();
    record('android:java-home', 'resolveJavaHome()', javaHome ? 0 : 1, 0,
      { missing: javaHome ? 0 : 1 },
      javaHome ? { javaHome: javaHome.replace(/\\/g, '/') } : {});

    run('android:assembleDebug', `${gradlew} :app:assembleDebug`, {
      cwd: AROOT, timeout: 30 * 60_000, needs: ['android:java-home'], env: { JAVA_HOME: javaHome || '' },
    });

    /**
     * ANDROID-LINT (a2). The verdict is the MANIFEST CHECK, not gradle's exit.
     *
     * This step used to be a raw `gradlew.bat :app:lintDebug`, which aborts on
     * any error (abortOnError) and so reported FAIL for lint findings that are
     * pre-existing at the scope base — a step that had no way to be green. The
     * android gate has had the right rule since P4: run lint, then grade the
     * result against e2e-evidence/LINT-BASELINE-android.json, which may only
     * SHRINK. This mirrors dnkdialer-android/tools/e2e-gate-android.mjs:242
     * ("lintDebug-vs-manifest") rather than reimplementing the rule; it is not
     * extracted into a shared module because the two gates have different
     * step/record plumbing and a shim between them would be more code than the
     * ~20 lines it saves.
     *
     * The freshness guard is load-bearing and is mirrored too: without it,
     * `--check` would happily grade a STALE XML left by a previous run and the
     * gate would go green having never run lint at all. Delete the report
     * first (which also stops gradle reporting UP-TO-DATE and leaving the old
     * XML in place), then require one written after the step started.
     */
    if (!javaHome) {
      skip('android:lint', `${gradlew} :app:lintDebug --continue && node tools/lint-manifest.mjs --check  (cwd dnkdialer-android)`,
        'not run — depends on "android:java-home", which failed');
    } else {
      const t0 = Date.now();
      const report = join(AROOT, 'app/build/reports/lint-results-debug.xml');
      const manifestTool = join(AROOT, 'tools', 'lint-manifest.mjs');
      const cmd = `${gradlew} :app:lintDebug --continue && node tools/lint-manifest.mjs --check  (cwd dnkdialer-android)`;
      if (existsSync(report)) rmSync(report);
      const startedAt = Date.now();
      const lint = spawnSync(`${gradlew} :app:lintDebug --continue`, {
        cwd: AROOT, shell: true, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, JAVA_HOME: javaHome },
      });
      let out = `${lint.stdout || ''}${lint.stderr || ''}`;
      const gradleExit = lint.status === null ? 124 : lint.status;
      let exit = 1;
      let reportFresh = 0;
      if (!existsSync(report)) {
        out += `\nFAIL: lint produced no XML report at ${report} — did gradle run? (gradle exit ${gradleExit})\n`;
      } else if (statSync(report).mtimeMs < startedAt - 5000) {
        out += `\nFAIL: lint report is STALE (written ${new Date(statSync(report).mtimeMs).toISOString()}, `
          + `step started ${new Date(startedAt).toISOString()}) — gradle did not actually run lint\n`;
      } else {
        reportFresh = 1;
        const chk = spawnSync(process.execPath, [manifestTool, '--check'], {
          cwd: AROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        });
        out += `${chk.stdout || ''}${chk.stderr || ''}`;
        exit = chk.status === null ? 124 : chk.status;
      }
      // `issues` parse kept verbatim from the old step so the number in the
      // JSON means the same thing across every gate run ever recorded.
      const counts = {
        issues: (out.match(/^\s*\d+ errors?, \d+ warnings?/gm) || []).length,
        reportFresh,
        gradleExit,
      };
      if (exit !== 0) {
        mkdirSync(LOGDIR, { recursive: true });
        const log = join(LOGDIR, `${PHASE}-android-lint.log`);
        writeFileSync(log, out);
        record('android:lint', cmd, exit, Date.now() - t0, counts, { log: log.replace(/\\/g, '/') });
      } else {
        record('android:lint', cmd, exit, Date.now() - t0, counts);
      }
    }

    const ANDROID_TEST_RESULTS = join(AROOT, 'app/build/outputs/androidTest-results/connected');
    if (['P4', 'P4.2', 'P5B', 'P6', 'P6.1', 'P7', 'P8'].includes(PHASE)) {
      // FINDING (E2E-P4.2 (e)): this is a SECOND phase table that has to agree
      // with KNOWN_PHASES and does not — the exact defect tools/lib/harness-
      // list.mjs was created to fold away. It still names 'P7' and 'P8', which
      // are not phases (the gate refuses them before reaching here, so they are
      // dead entries rather than live bugs), and it silently omitted P4.2 — an
      // android phase whose ONLY instrumented step is this one. A phase missing
      // from this list does not fail: it runs nothing and the gate prints PASS,
      // which is "0 tests ran" wearing a green hat. P4.2 added; folding the
      // table into harness-list.mjs is Ken's call, not this lane's.
      // FINDING (E2E-P4.2 (e)): this step could never have run. `--tests` is a
      // JVM `Test` task option; :app:connectedDebugAndroidTest is a
      // DeviceProviderInstrumentTestTask and REFUSES it —
      // "Unknown command-line option '--tests'" — so the step failed at
      // CONFIGURATION time, before a single test. It went unnoticed because no
      // android-lane gate JSON has ever been committed (e2e-evidence/ holds
      // gate-P0..P6 and D1/FT3/MERGE, no P4 or P5B). Every android phase that
      // names this step — P4, P5B, P6, P6.1 — inherits the fix.
      // The supported mechanism is the runner-argument property below, which is
      // what the lane's own manual runs have been using throughout.
      rmSync(ANDROID_TEST_RESULTS, { recursive: true, force: true });
      run('android:SasVectorsTest',
        `${gradlew} :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.dnkdialer.companion.E2eSasVectorsTest`, {
          cwd: AROOT, timeout: 30 * 60_000, needs: ['android:java-home'], env: { JAVA_HOME: javaHome || '' },
          parse: () => junitCounts(ANDROID_TEST_RESULTS),
        });
    }

    // E2E-P4.2 (e). The android lane's own test evidence, with COUNTS.
    //
    // Counts are read from the JUnit XML rather than from gradle's stdout, and
    // that is the point: `BUILD SUCCESSFUL` is printed by a run that executed
    // zero tests just as cheerfully as by one that executed two hundred. A
    // filter matching nothing, an instrumentation that never installed, a suite
    // renamed out from under its own gate step — all three exit 0. The
    // MIN_CHECKS floors turn "0 tests ran" into a FAIL, structurally.
    // E2E-P6.1b FINDING + FIX. This was `PHASE === 'P4.2'` — an EQUALITY test
    // where every other android step uses a phase LIST. P6.1's brief requires
    // this sweep to show android:testDebugUnitTest (>=200) and
    // android:instrumented-A5 (>=8), and under the equality guard neither step
    // was dispatched at --phase P6.1: no step, no counts, no MIN_CHECKS, and
    // the gate printed PASS 107/107 (gate-P6.1-815bba5.json). The floors at
    // :464-465 cannot rescue that — MIN_CHECKS grades a step that RAN, and is
    // silent about one that was never created. That is precisely the "0 tests
    // ran wearing a green hat" shape the comment at :1822-1830 warns about,
    // one guard below where it is written.
    //
    // NOT the known P7/P8 second-table item the brief set aside: that table
    // (:1789) already lists P6.1 and did run android:SasVectorsTest. This is a
    // separate guard with a separate defect.
    //
    // P6.1 only is added here. P4/P5B/P6 are deliberately NOT: their briefs
    // never declared these floors, the A5 classes post-date P4/P5B/P6, and
    // widening a gate to phases that never agreed to it turns other lanes'
    // recorded PASSes into retro-active failures — Ken's call, not this lane's.
    if (['P4.2', 'P6.1'].includes(PHASE)) {
      const A5_CLASSES = [
        'com.dnkdialer.companion.E2eForwardJumpVectorsTest',
        'com.dnkdialer.companion.E2eForwardJumpObservabilityTest',
        'com.dnkdialer.companion.E2eModeVectorMBackCompatTest',
      ].join(',');

      run('android:testDebugUnitTest', `${gradlew} :app:testDebugUnitTest`, {
        cwd: AROOT, timeout: 30 * 60_000, needs: ['android:java-home'], env: { JAVA_HOME: javaHome || '' },
        parse: () => junitCounts(join(AROOT, 'app/build/test-results/testDebugUnitTest')),
      });

      // Both instrumented steps write to ONE results directory, and gradle
      // overwrites rather than clears it. Counting without removing it first
      // would let a step report the PREVIOUS step's (or the previous gate
      // run's) totals — a count read from a stale artefact is worth less than
      // no count, because it looks like evidence.
      rmSync(ANDROID_TEST_RESULTS, { recursive: true, force: true });
      run('android:instrumented-A5',
        `${gradlew} :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=${A5_CLASSES}`, {
          cwd: AROOT, timeout: 30 * 60_000, needs: ['android:java-home'], env: { JAVA_HOME: javaHome || '' },
          parse: () => junitCounts(ANDROID_TEST_RESULTS),
        });
    }
  }
  // Step 12 is a prohibition, not a command: the gate never signs a release
  // APK. Asserted structurally — no assembleRelease/bundleRelease above.
  record('android:never-signs-release', '(assertion: no assembleRelease/bundleRelease in this tool)', 0, 0, { releaseTasks: 0 });
}

/**
 * Sum the JUnit XML in a gradle results directory into a counts object.
 *
 * Deliberately reads the ARTEFACTS, never stdout. A gradle run that executed
 * nothing exits 0 and says BUILD SUCCESSFUL; only the XML knows how many tests
 * there actually were. Returns total 0 for a missing or empty directory, which
 * the MIN_CHECKS floor then reports as the failure it is.
 */
function junitCounts(dir) {
  let total = 0, failures = 0, errors = 0, skipped = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.xml')) continue;
      let xml = '';
      try { xml = readFileSync(full, 'utf8'); } catch { continue; }
      const open = xml.match(/<testsuite[ >][^>]*/);
      if (!open) continue;
      const attr = (k) => {
        const a = open[0].match(new RegExp(k + '="([0-9]+)"'));
        return a ? Number(a[1]) : 0;
      };
      total += attr('tests'); failures += attr('failures');
      errors += attr('errors'); skipped += attr('skipped');
      files++;
    }
  }
  return { passed: total - failures - errors - skipped, total, failures, errors, skipped, files };
}

// ── 10. baseline parity ────────────────────────────────────────────────────
const harnessPass = steps
  .filter((s) => /^(harness|relay|unit):/.test(s.name) && s.exit === 0 && s.counts)
  .map((s) => ({ name: s.name, passed: s.counts.passed ?? null, total: s.counts.total ?? null }));

const BASELINE_PATH = join(OUTDIR, 'BASELINE-harness.json');
let baselineDiff = [];
if (BASELINE) {
  mkdirSync(OUTDIR, { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify({ baseSha: BASE_SHA, utc: new Date().toISOString(), harnessPass }, null, 2) + '\n');
  produced.push('e2e-evidence/BASELINE-harness.json');
  record('baseline-parity', `write ${BASELINE_PATH.replace(/\\/g, '/')}`, 0, 0, { recorded: harnessPass.length });
} else if (existsSync(BASELINE_PATH)) {
  const ref = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const now = new Map(harnessPass.map((h) => [h.name, h]));
  // Only steps this lane COULD have run are comparable.
  //
  // BASELINE-harness.json was recorded on a WEB lane, and every step in it is a
  // harness/relay/unit step living inside `if (WEB)`. Under `--lane android`
  // none of them execute, so diffing the whole list reported all 16 as
  // "regressed" — a lane being structurally incapable of running a step is not
  // that step regressing. Same class as FT-MERGE (d1) / R-AU: a predicate asked
  // of a lane it has no meaning for, answering FAIL because it had no read path
  // for that lane. Reported as `comparable` rather than quietly passing, so the
  // JSON says WHY the number is zero.
  const comparable = WEB ? (ref.harnessPass || []) : [];
  baselineDiff = comparable
    .filter((h) => !now.has(h.name))
    .map((h) => redact(`${h.name}: passed at BASE_SHA, not passing now`));
  record('baseline-parity', `diff vs ${BASELINE_PATH.replace(/\\/g, '/')}`,
    baselineDiff.length === 0 ? 0 : 1, 0, {
      reference: (ref.harnessPass || []).length,
      comparable: comparable.length,
      regressed: baselineDiff.length,
      ...(WEB ? {} : { why: 'lane=android runs no web-lane steps; nothing in the reference is comparable' }),
    });
} else {
  record('baseline-parity', `read ${BASELINE_PATH.replace(/\\/g, '/')}`, 1, 0, { missing: 1 });
}

/**
 * ANDROID-LINT (a3). The other half of the OWN_OUTPUT allowance at step 1: a
 * path the gate stops grading MUST be a path the gate declares. Enumerated
 * from git rather than from a hard-coded list of filenames, so a harness that
 * adds or renames a shot shows up here without anybody remembering to update
 * this block. Listing it is not the same as endorsing committing it — the
 * resumer decides that per lane (FT-3b committed its shots because ft-ui-proof
 * asserts on them; FT-MERGE-2 reverted its shots as pure render churn).
 */
for (const line of porcelainOf(gitRaw(['status', '--porcelain', '--', 'docs/screenshots']))) {
  const p = porcelainPath(line);
  if (/^docs\/screenshots\/[^/]+\.png$/.test(p) && !produced.includes(p)) produced.push(p);
}

// ── evidence JSON (NEW-MA-2: committed in the repo under e2e-evidence/) ────
const result = failed ? 'FAIL' : 'PASS';
const outFile = join(OUTDIR, `gate-${PHASE}-${SHA.slice(0, 7)}${LABEL ? `-${LABEL.replace(/[^a-z0-9]+/gi, '-')}` : ''}.json`);
produced.push(outFile.replace(/\\/g, '/').replace(`${ROOT.replace(/\\/g, '/')}/`, ''));
const evidence = {
  phase: PHASE,
  label: LABEL ? redact(LABEL) : null,
  /**
   * Ken R-AO. Which way the harnesses were run, recorded IN the evidence rather
   * than inferred from a runtime number.
   *
   * A sequential run is slower by construction — the R-B 25-minute ceiling is
   * waived for it — and without this field the next reader sees a long runtime
   * and reads it as a regression. `--parallel-harnesses` is opt-in precisely
   * because R-C records these harnesses as flaky under load, so the two modes
   * are not interchangeable evidence and the JSON should say which one it is.
   */
  harnessMode: PARALLEL_HARNESSES ? 'parallel' : 'sequential',
  /**
   * R-AO breach note. Free-form, set via E2E_GATE_NOTE, and carried into the
   * evidence so a contended run is never silently compared against a clean one.
   */
  note: process.env.E2E_GATE_NOTE ? redact(process.env.E2E_GATE_NOTE) : null,
  sha: SHA,
  /** Programme identity. Frozen; step 1 asserts it is an ancestor of HEAD. */
  baseSha: BASE_SHA,
  /**
   * E2E-P0.3 — the MOVING base that scope-diff and the lint floor are measured
   * against. `kind: "merge-base"` is the normal case; `"base-sha"` means the
   * branch does not descend from origin/e2e/integration and `reason` says why.
   */
  scopeBase: {
    sha: SCOPE_BASE.sha,
    kind: SCOPE_BASE.kind,
    ref: INTEGRATION_REF,
    integrationTip: SCOPE_BASE.integrationTip,
    fellBackToBaseSha: SCOPE_BASE.fellBack,
    reason: SCOPE_BASE.reason ? redact(SCOPE_BASE.reason) : null,
  },
  utc: new Date().toISOString(),
  lane: LANE,
  mode: READ_ONLY ? 'read-only' : BASELINE ? 'baseline' : 'full',
  env: {
    node: process.version,
    bun: (spawnSync('bun', ['-v'], { encoding: 'utf8', shell: true }).stdout || '').trim() || null,
    chrome: (spawnSync('node', ['-e', "try{console.log(require('playwright-core').chromium.executablePath())}catch{console.log('')}"],
      { cwd: ROOT, encoding: 'utf8', shell: true }).stdout || '').trim() || null,
  },
  steps,
  harnessPass: harnessPass.map((h) => h.name),
  baselineDiff,
  ms: Date.now() - T_START,
  failedStep: failed ? redact(failed) : null,
  /** Repo paths this run wrote. A resumer commits exactly these — nothing else. */
  produced,
  result,
};

mkdirSync(OUTDIR, { recursive: true });
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

console.log(
  `\n${result} — ${steps.filter((s) => s.exit === 0).length}/${steps.filter((s) => !s.skipped).length} steps` +
  `${failed ? `; first failure: ${failed}` : ''}\nevidence: ${outFile.replace(/\\/g, '/')}\n` +
  (failed ? `logs (LOCAL, never committed): ${LOGDIR.replace(/\\/g, '/')}\n` : '')
);
process.exit(failed ? 1 : 0);
