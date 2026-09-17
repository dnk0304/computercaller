#!/usr/bin/env node
/**
 * ANDROID-LANE gate for the E2E programme — the documented stand-in for
 * `bun run e2e:gate --phase P4 --lane android`.
 *
 * Why this file exists: `tools/e2e-gate.mjs` is delivered by P0 and lives on
 * branch e2e/p0-design-freeze. Merging it into this branch would drag in
 * non-android files and break P4's own scope rule (non-android diff vs
 * BASE_SHA must be empty). The P4 brief anticipates this and allows the
 * equivalent to be run and noted. This emits the SAME JSON shape as
 * E2E-P0-GATE-SPEC.md so Ken can diff it against a real gate run once the
 * lanes are merged, and it implements the spec's android steps (11) plus the
 * repo-state steps (1, 2) that apply to any lane.
 *
 * Per N-3 the JSON records name/cmd/exit/ms/counts ONLY — never captured
 * stdout/stderr. Failing steps name a local log path that is not committed.
 *
 * Steps keep running after a failure (the spec's `needs` graph) so one run
 * reports everything that is broken, not just the first thing.
 *
 * Usage: node tools/e2e-gate-android.mjs [--out <dir>]
 * Exit:  0 PASS, 1 FAIL, 2 refused to run
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(MODULE_ROOT, '..');

const BASE_SHA = '445138a6c58c12b2848cb4c24371b0d443e51c27';
const EXPECTED_VERSION_CODE = 58;
const EXPECTED_VERSION_NAME = '1.0.34';
const PHASE = 'P4';
const LANE = 'android';

const LOG_DIR = join(tmpdir(), 'e2e-gate-p4-logs');
mkdirSync(LOG_DIR, { recursive: true });

const steps = [];

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}

/** Run a step, record it, never throw. `counts` is derived from stdout by fn. */
function step(name, cmd, run) {
  const t0 = Date.now();
  let exit = 0;
  let counts = {};
  let out = '';
  try {
    out = run() ?? '';
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : 1;
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
  }
  const logPath = join(LOG_DIR, `${name.replace(/[^\w.-]/g, '_')}.log`);
  try {
    writeFileSync(logPath, out, 'utf8');
  } catch { /* logging must never fail the gate */ }
  // Let the caller post-process into counts / override exit.
  const rec = { name, cmd, exit, ms: Date.now() - t0, counts };
  rec._out = out;
  rec._log = logPath;
  steps.push(rec);
  return rec;
}

function finish(rec, { exit, counts } = {}) {
  if (typeof exit === 'number') rec.exit = exit;
  if (counts) rec.counts = counts;
  if (rec.exit !== 0) rec.log = rec._log;
  return rec;
}

// Absolute path, quoted. A bare `gradlew.bat` is not resolvable through
// execSync's shell even with cwd set to the module root — it is not on PATH
// and cmd.exe does not search the child's cwd. Cost a false FAIL in (s7).
const gradlew = `"${join(MODULE_ROOT, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}"`;
const gradleOpts = { cwd: MODULE_ROOT, encoding: 'utf8', stdio: 'pipe', shell: true };

// ---------------------------------------------------------------- step 1
{
  const r = step('repo-state', 'git rev-parse HEAD; git status --porcelain; merge-base', () => {
    const head = git(['rev-parse', 'HEAD']);
    // Working tree must be clean apart from the untracked .e2e-lock, which is
    // the protocol's own liveness marker and is deliberately never committed
    // (committing it would put a non-android file in the diff).
    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.endsWith('.e2e-lock'));
    const ancestor = (() => {
      try {
        execFileSync('git', ['-C', REPO_ROOT, 'merge-base', '--is-ancestor', BASE_SHA, 'HEAD']);
        return true;
      } catch { return false; }
    })();
    if (!ancestor) throw new Error('BASE_SHA is not an ancestor of HEAD');
    if (dirty.length) throw new Error(`dirty working tree: ${dirty.join(' | ')}`);
    return `head=${head} ancestor=OK clean=OK`;
  });
  finish(r, { counts: { dirtyFiles: 0, ancestorOk: 1 } });
}

// ---------------------------------------------------------------- step 2
{
  const r = step('scope-non-android-diff', `git diff ${BASE_SHA}..HEAD -- . ':(exclude)dnkdialer-android/'`, () => {
    const files = git(['diff', '--name-only', `${BASE_SHA}..HEAD`, '--', '.', ':(exclude)dnkdialer-android/'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    // The ONE documented exception in the P4 brief: P4 owns the android lint
    // manifest, which necessarily lives beside P0's web one.
    const ALLOWED = new Set(['e2e-evidence/LINT-BASELINE-android.json']);
    const violations = files.filter((f) => !ALLOWED.has(f));
    if (violations.length) throw new Error(`non-android files touched: ${violations.join(', ')}`);
    return `nonAndroid=${files.length} allowed=${files.length} violations=0`;
  });
  const files = (() => {
    try {
      return git(['diff', '--name-only', `${BASE_SHA}..HEAD`, '--', '.', ':(exclude)dnkdialer-android/'])
        .split('\n').filter(Boolean).length;
    } catch { return -1; }
  })();
  finish(r, { counts: { nonAndroidFiles: files, violations: r.exit === 0 ? 0 : 1 } });
}

// ------------------------------------------------------- step 11a: build
{
  const r = step('assembleDebug', `${gradlew} :app:assembleDebug`, () =>
    execSync(`${gradlew} :app:assembleDebug --no-daemon`, gradleOpts));
  finish(r);
}

// --------------------------------------------- step 11b: versionCode check
{
  const r = step('aapt-badging-versionCode', 'aapt dump badging app-debug.apk', () => {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('ANDROID_HOME not set');
    const btDir = join(sdk, 'build-tools');
    const newest = readdirSync(btDir).sort().reverse()[0];
    const aapt = join(btDir, newest, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
    const apk = join(MODULE_ROOT, 'app/build/outputs/apk/debug/app-debug.apk');
    if (!existsSync(apk)) throw new Error('debug APK not built');
    const out = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' });
    const vc = /versionCode='(\d+)'/.exec(out)?.[1];
    const vn = /versionName='([^']+)'/.exec(out)?.[1];
    if (Number(vc) !== EXPECTED_VERSION_CODE) throw new Error(`versionCode ${vc} != ${EXPECTED_VERSION_CODE}`);
    if (vn !== EXPECTED_VERSION_NAME) throw new Error(`versionName ${vn} != ${EXPECTED_VERSION_NAME}`);
    return `versionCode=${vc} versionName=${vn}`;
  });
  finish(r, { counts: { versionCode: EXPECTED_VERSION_CODE, versionName: EXPECTED_VERSION_NAME } });
}

// ------------------------------------------------- step 11c: unit tests
{
  const r = step('testDebugUnitTest', `${gradlew} :app:testDebugUnitTest`, () =>
    execSync(`${gradlew} :app:testDebugUnitTest --no-daemon`, gradleOpts));
  // Parse the JUnit XML rather than trusting BUILD SUCCESSFUL: gradle is
  // "successful" when ZERO tests ran.
  let tests = 0, failures = 0, skipped = 0, errors = 0;
  const xmlDir = join(MODULE_ROOT, 'app/build/test-results/testDebugUnitTest');
  if (existsSync(xmlDir)) {
    for (const f of readdirSync(xmlDir).filter((f) => f.endsWith('.xml'))) {
      const x = readFileSync(join(xmlDir, f), 'utf8');
      tests += Number(/tests="(\d+)"/.exec(x)?.[1] ?? 0);
      failures += Number(/failures="(\d+)"/.exec(x)?.[1] ?? 0);
      skipped += Number(/skipped="(\d+)"/.exec(x)?.[1] ?? 0);
      errors += Number(/errors="(\d+)"/.exec(x)?.[1] ?? 0);
    }
  }
  const bad = r.exit !== 0 || tests === 0 || failures > 0 || errors > 0;
  finish(r, { exit: bad ? 1 : 0, counts: { tests, failures, skipped, errors } });
}

// --------------------------------------------- step 11d: lint vs manifest
{
  const r = step('lintDebug-vs-manifest', `${gradlew} :app:lintDebug --continue; lint-manifest --check`, () => {
    // lintDebug exits non-zero on the 8 pre-existing BASE_SHA errors
    // (abortOnError). That is EXPECTED and is exactly why the manifest rule
    // exists; the verdict comes from lint-manifest --check, not from gradle.
    // BUT the failure must not be swallowed blindly: if gradle never RAN
    // (bad path, no JDK), --check would happily pass against a stale report
    // from a previous run and the gate would go green on nothing. So require
    // a report file written AFTER this step started. Caught in (s7).
    const report = join(MODULE_ROOT, 'app/build/reports/lint-results-debug.xml');
    // Delete the previous report BEFORE running. Two birds: gradle treats a
    // missing output as out-of-date and actually re-runs the task (otherwise
    // it reports UP-TO-DATE and leaves the old XML in place), and the
    // freshness assertion below then means something. Without this, the
    // choice is between trusting a possibly-stale report and failing the gate
    // every time lint is legitimately up to date.
    if (existsSync(report)) rmSync(report);
    const startedAt = Date.now();
    let gradleOut = '';
    try {
      gradleOut = execSync(`${gradlew} :app:lintDebug --no-daemon --continue`, gradleOpts);
    } catch (e) {
      gradleOut = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    }
    if (!existsSync(report)) throw new Error('lint produced no XML report — did gradle run?');
    const mtime = statSync(report).mtimeMs;
    if (mtime < startedAt - 5000) {
      throw new Error(
        `lint report is STALE (written ${new Date(mtime).toISOString()}, step started ` +
        `${new Date(startedAt).toISOString()}) — gradle did not actually run lint`
      );
    }
    return gradleOut + '\n' + execFileSync(process.execPath, [join(HERE, 'lint-manifest.mjs'), '--check'],
      { cwd: MODULE_ROOT, encoding: 'utf8' });
  });
  const total = /\((\d+) issues/.exec(r._out)?.[1];
  finish(r, { counts: { issues: Number(total ?? -1), grownCells: r.exit === 0 ? 0 : 1 } });
}

// --------------------------------------- step 11e: instrumented (optional)
{
  const adb = process.env.ANDROID_HOME
    ? join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
    : null;
  const deviceUp = (() => {
    try {
      return /\bdevice\b/.test(execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n').slice(1).join('\n'));
    } catch { return false; }
  })();
  const r = step('instrumented-E2eKeyStoreTest', 'tools/run-keystore-test.ps1', () => {
    if (!deviceUp) {
      // Recorded as SKIPPED, never as PASS. A gate that silently passes when
      // no device is attached is worse than no gate.
      return 'SKIPPED: no device/emulator attached';
    }
    return execSync('powershell -ExecutionPolicy Bypass -File tools/run-keystore-test.ps1',
      { ...gradleOpts, maxBuffer: 1 << 24 });
  });
  const skipped = !deviceUp;
  const ok = skipped || /PROCESS-DEATH PROOF: PASS/.test(r._out);
  finish(r, {
    exit: skipped ? 0 : (ok ? 0 : 1),
    counts: { skipped: skipped ? 1 : 0, processDeathProof: ok && !skipped ? 'PASS' : (skipped ? 'SKIPPED' : 'FAIL') },
  });
}

// ------------------------------------------------------------------ emit
const result = steps.every((s) => s.exit === 0) ? 'PASS' : 'FAIL';
const sha = (() => { try { return git(['rev-parse', 'HEAD']); } catch { return 'unknown'; } })();
const short = sha.slice(0, 7);

const payload = {
  phase: PHASE,
  sha,
  baseSha: BASE_SHA,
  utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  lane: LANE,
  note:
    'Produced by tools/e2e-gate-android.mjs, the documented stand-in for ' +
    '`bun run e2e:gate --phase P4 --lane android` (P0 owns the real gate and it ' +
    'lives on e2e/p0-design-freeze; merging it here would violate P4 scope). ' +
    'Same JSON shape as E2E-P0-GATE-SPEC.md.',
  env: {
    node: process.version,
    bun: (() => { try { return execSync('bun --version', { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    chrome: null,
    gradle: (() => { try { return /Gradle (\S+)/.exec(execSync(`${gradlew} --version`, gradleOpts))?.[1] ?? null; } catch { return null; } })(),
  },
  steps: steps.map(({ _out, _log, ...s }) => s),
  harnessPass: [],
  baselineDiff: [],
  result,
};

const outArgIdx = process.argv.indexOf('--out');
const outDirs = outArgIdx > -1
  ? [process.argv[outArgIdx + 1]]
  : [
    join(MODULE_ROOT, 'e2e-evidence'),
    'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/e2e/evidence',
    'C:/Users/D/.claude/agent-memory/niki/PROJECTS/computercaller/e2e/evidence',
  ];

for (const d of outDirs) {
  try {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `gate-${PHASE}-${short}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`wrote ${join(d, `gate-${PHASE}-${short}.json`)}`);
  } catch (e) {
    console.error(`could not write to ${d}: ${e.message}`);
  }
}

for (const s of payload.steps) {
  console.log(`  ${s.exit === 0 ? 'ok  ' : 'FAIL'} ${s.name} (${s.ms} ms) ${JSON.stringify(s.counts)}`);
}
console.log(`RESULT: ${result}`);
process.exit(result === 'PASS' ? 0 : 1);
