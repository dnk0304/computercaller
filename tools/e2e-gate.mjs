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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const PHASE = (flag('phase', 'P0') || 'P0').toUpperCase();
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
const IS_WORKTREE = /\/worktrees\/computercaller\/e2e-p[0-9a-z]+$/i.test(NORM);
const IS_MAIN = /\/desktop\/computercaller$/i.test(NORM);
if (!IS_WORKTREE && !IS_MAIN) {
  refuse(
    `must run from C:\\Users\\D\\worktrees\\computercaller\\e2e-p<N> or the main checkout.\n` +
      `            Got: ${ROOT}`
  );
}
/** NEW-MA-1: the main checkout is somebody's live working tree. Never destroy it. */
const READ_ONLY = IS_MAIN;

// ── env: the gate refuses without the harness env (rule 7) ─────────────────
function loadEnvLocal() {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvLocal();
if (WEB) {
  if (!process.env.DATABASE_URL) refuse('DATABASE_URL is not set (expected postgresql://pix:pix@localhost:15433/cc). The /app harnesses cannot run without it.');
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
  if (!alive(lockPid)) {
    refuse(`.e2e-lock holds PID ${lockPid}, which is dead. Reclaim it per RESUME-PROTOCOL v2 §1c before running the gate.`);
  }
  const mine = ancestry(process.pid);
  const envPid = Number(process.env.E2E_LOCK_PID || NaN);
  if (!mine.includes(lockPid) && envPid !== lockPid) {
    refuse(
      `.e2e-lock holds live PID ${lockPid}, which is not in this run's process ancestry ` +
        `(${mine.join(' < ')}). Another writer owns this worktree.\n` +
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

// ── step runner ────────────────────────────────────────────────────────────
const steps = [];
let failed = null;
const GITBASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']
  .find((p) => existsSync(p)) || 'bash';

function record(name, cmd, exit, ms, counts, extra = {}) {
  const step = { name: redact(name), cmd: redact(cmd), exit, ms, counts: counts ?? null, ...extra };
  steps.push(step);
  const mark = step.skipped ? 'SKIP' : exit === 0 ? 'PASS' : 'FAIL';
  const detail = counts ? ` (${JSON.stringify(counts)})` : '';
  console.log(`  ${mark}  ${step.name}${detail}${step.skipped ? ` — ${step.skipped}` : ''}`);
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
function run(name, cmd, { cwd = ROOT, parse = null, env = {}, timeout = 15 * 60_000 } = {}) {
  if (failed) return skip(name, cmd, `not run — "${failed}" already failed`);
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8', timeout,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const exit = r.status === null ? 124 : r.status;
  let counts = null;
  try { counts = parse ? parse(out, exit) : null; } catch { counts = null; }
  if (exit !== 0) {
    mkdirSync(LOGDIR, { recursive: true });
    const log = join(LOGDIR, `${PHASE}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
    writeFileSync(log, out);
    return record(name, cmd, exit, ms, counts, { log: log.replace(/\\/g, '/') });
  }
  return record(name, cmd, exit, ms, counts);
}

/** Parse the repo's test convention: a final `N/M passed` line. */
const passLine = (out) => {
  const m = [...out.matchAll(/(\d+)\s*\/\s*(\d+)\s+passed/g)].pop();
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
};

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
function freePort(from = 3300) {
  for (let p = from; p < from + 200; p++) if (!portOwnerPid(p)) return p;
  return null;
}

// ── harness dev server (started by the gate, killed by the gate, by PID) ───
let devProc = null;
let devPort = null;
function startDevServer() {
  devPort = freePort(3300);
  if (!devPort) return { ok: false, why: 'no free port >= 3300' };
  const owner = portOwnerPid(devPort);
  if (owner) return { ok: false, why: `port ${devPort} owned by PID ${owner}` };
  devProc = spawn('node', ['server.js'], {
    cwd: ROOT, detached: false, stdio: 'ignore', shell: false,
    env: { ...process.env, PORT: String(devPort), NODE_ENV: 'production' },
  });
  return { ok: true };
}
function stopDevServer() {
  // Rule 12: never kill by image name. Only the PID we started.
  if (devProc && devProc.pid) {
    try { spawnSync('taskkill', ['/PID', String(devProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  devProc = null;
}
async function waitForDev(port, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
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
  `root=${ROOT}\nbase=${BASE_SHA.slice(0, 7)}\n`
);

const gitOut = (a) => (spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();
const SHA = gitOut(['rev-parse', 'HEAD']);

// ── 1. git identity, cleanliness, base ancestry ────────────────────────────
{
  const t0 = Date.now();
  const porcelain = gitOut(['status', '--porcelain']).split('\n').filter(Boolean);
  const ALLOW = /(^|\/)(bun\.lock|\.e2e-lock|\.env\.local|\.e2e-gate-logs\/?|node_modules\/?)$/;
  const dirty = porcelain.filter((l) => !ALLOW.test(l.slice(3).trim().replace(/^"|"$/g, '')));
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', BASE_SHA, 'HEAD'], { cwd: ROOT });
  const ok = dirty.length === 0 && anc.status === 0;
  record('git-identity-clean-base-ancestry',
    'git rev-parse HEAD && git status --porcelain && git merge-base --is-ancestor BASE_SHA HEAD',
    ok ? 0 : 1, Date.now() - t0,
    { dirtyPaths: dirty.length, baseIsAncestor: anc.status === 0 });
}

// ── 2. scope: a web phase touches no android, an android phase touches only android
{
  const t0 = Date.now();
  const changed = gitOut(['diff', '--name-only', `${BASE_SHA}..HEAD`]).split('\n').filter(Boolean);
  const android = changed.filter((f) => f.startsWith('dnkdialer-android/'));
  const nonAndroid = changed.filter((f) => !f.startsWith('dnkdialer-android/'));
  const offSide = DEFAULT_LANE === 'android' ? nonAndroid : android;
  record('scope-diff-vs-base', `git diff --name-only ${BASE_SHA.slice(0, 7)}..HEAD`,
    offSide.length === 0 ? 0 : 1, Date.now() - t0,
    { changed: changed.length, android: android.length, nonAndroid: nonAndroid.length, offLane: offSide.length });
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

  // ── lint = 0 (brief (b); rule-9 "named excuses" retired) ─────────────────
  run('lint', 'bun run lint', {
    parse: (out) => {
      const m = out.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/);
      return m ? { problems: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]) } : { problems: 0 };
    },
  });

  // ── 5. clean build ───────────────────────────────────────────────────────
  if (READ_ONLY) {
    skip('build', 'rm -rf .next && bun run build', 'read-only main checkout — never destroys another writer\'s .next');
  } else {
    try { rmSync(join(ROOT, '.next'), { recursive: true, force: true }); } catch { /* nothing to remove */ }
    run('build', 'bun run build', { timeout: 20 * 60_000, parse: (out) => ({ routes: (out.match(/^[┌├└]\s/gm) || []).length }) });
  }

  // ── clarity scope, AFTER the build (Security f-2: "skipped" is a FAIL) ───
  if (existsSync(join(ROOT, 'scripts', 'check-clarity-scope.mjs'))) {
    if (READ_ONLY && !existsSync(join(ROOT, '.next'))) {
      skip('clarity-scope', 'node scripts/check-clarity-scope.mjs', 'read-only and no .next present');
    } else {
      run('clarity-scope', 'node scripts/check-clarity-scope.mjs', {
        parse: (out, exit) => {
          const skipped = /skipping|skipped|no \.next/i.test(out);
          if (skipped) throw new Error('skipped counts as FAIL (Security f-2)');
          return { exit, buildChecked: 1 };
        },
      });
      // f-2: a skip must not read as a pass.
      const last = steps[steps.length - 1];
      if (last.name === 'clarity-scope' && last.counts === null && last.exit === 0) {
        last.exit = 1; last.counts = { skipped: 1 };
        if (!failed) failed = 'clarity-scope';
        console.log('  FAIL  clarity-scope — the build-output check was skipped; per Security f-2 that is a FAIL, not a pass');
      }
    }
  }

  // ── 6. extension packaging guard ─────────────────────────────────────────
  run('check-extension', `"${GITBASH}" tools/check-extension.sh`);

  // ── 7. relay suites ──────────────────────────────────────────────────────
  const RELAY = ['pairing-persist', 'pair-state', 'dock-resume', 'reset-room', 'listener-heartbeat',
    'relink-kill-frame-buffer', 'call-separation', 'www-origin', 'repro-resume-sync',
    'session-superseded', 'log-redaction'];
  /** P0 DELIVERS these; BASE_SHA predates them. Only --baseline may excuse them. */
  const P0_NEW = new Set(['session-superseded']);
  for (const base of RELAY) {
    const rel = resolveIn('tests', base);
    if (!rel) {
      if (BASELINE && P0_NEW.has(base)) skip(`relay:${base}`, `node tests/${base}`, 'absent-at-base (delivered by P0)');
      else record(`relay:${base}`, `node tests/${base}`, 1, 0, { missing: 1 });
      continue;
    }
    run(`relay:${base}`, `node ${rel}`, { parse: passLine });
  }
  for (const f of existsSync(join(ROOT, 'tests')) ? readdirSync(join(ROOT, 'tests')) : []) {
    if (/^e2e-.*\.test\.mjs$/.test(f)) run(`relay:${f}`, `node tests/${f}`, { parse: passLine });
  }

  // ── 8. unit: SAS vectors (web + SW context), padding property, bridge pin ─
  const UNIT = [
    ['sas-vectors', 'tests/sas-vectors.test.mjs', true],
    ['padding-property', 'tests/padding-property.test.mjs', true],
  ];
  for (const [name, rel, isNew] of UNIT) {
    if (!existsSync(join(ROOT, rel))) {
      if (BASELINE && isNew) skip(`unit:${name}`, `node ${rel}`, 'absent-at-base (delivered by P0)');
      else record(`unit:${name}`, `node ${rel}`, 1, 0, { missing: 1 });
      continue;
    }
    run(`unit:${name}`, `node ${rel}`, { parse: passLine });
  }
  if (existsSync(join(ROOT, 'scripts', 'ext-bridge-origin-pin-proof.mjs'))) {
    run('unit:bridge-origin-pin', 'node scripts/ext-bridge-origin-pin-proof.mjs', { parse: passLine });
  } else {
    record('unit:bridge-origin-pin', 'node scripts/ext-bridge-origin-pin-proof.mjs', 1, 0, { missing: 1 });
  }

  // ── 9. harnesses against a dev server the gate owns ──────────────────────
  const HARNESS = ['app-in-call-shots', 'ext-in-call-shots', 'ext-badge-counter-proof',
    'ext-templates-scroll-call-message-proof', 'ext-shell-theme-proof', 'ext-layering-shots'];
  if (['P3', 'P4', 'P5A', 'P5B', 'P6', 'P7', 'P8'].includes(PHASE)) HARNESS.splice(3, 0, 'ext-sw-lifetime-proof');
  if (!failed) {
    const started = startDevServer();
    if (!started.ok) {
      record('harness-dev-server', 'node server.js (gate-owned)', 1, 0, { why: 1 });
      console.log(`  FAIL  harness-dev-server — ${started.why}`);
    } else {
      const up = await waitForDev(devPort);
      record('harness-dev-server', `node server.js PORT=${devPort}`, up ? 0 : 1, 0, { port: devPort, pid: devProc?.pid ?? 0 });
      if (up) {
        for (const h of HARNESS) {
          const rel = `scripts/${h}.mjs`;
          if (!existsSync(join(ROOT, rel))) { record(`harness:${h}`, `node ${rel}`, 1, 0, { missing: 1 }); continue; }
          run(`harness:${h}`, `node ${rel}`, {
            parse: passLine,
            env: { PORT: String(devPort), DEV_URL: `http://127.0.0.1:${devPort}`, BASE_URL: `http://127.0.0.1:${devPort}` },
            timeout: 8 * 60_000,
          });
        }
      }
      stopDevServer();
    }
  } else {
    skip('harness-dev-server', 'node server.js (gate-owned)', `not run — "${failed}" already failed`);
  }
}

// ── 11. android lane ───────────────────────────────────────────────────────
if (ANDROID) {
  const AROOT = join(ROOT, 'dnkdialer-android');
  if (!existsSync(join(AROOT, 'gradlew.bat'))) {
    record('android:gradlew-present', 'dnkdialer-android/gradlew.bat', 1, 0, { missing: 1 });
  } else {
    run('android:assembleDebug', 'gradlew.bat :app:assembleDebug', { cwd: AROOT, timeout: 30 * 60_000 });
    run('android:lint', 'gradlew.bat :app:lintDebug', {
      cwd: AROOT, timeout: 30 * 60_000,
      parse: (out) => ({ issues: (out.match(/^\s*\d+ errors?, \d+ warnings?/gm) || []).length }),
    });
    if (['P4', 'P5B', 'P6', 'P7', 'P8'].includes(PHASE)) {
      run('android:SasVectorsTest', 'gradlew.bat :app:connectedDebugAndroidTest --tests "*SasVectorsTest"', { cwd: AROOT, timeout: 30 * 60_000 });
    }
  }
  // Step 12 is a prohibition, not a command: the gate never signs a release
  // APK. Asserted structurally — no assembleRelease/bundleRelease above.
  record('android:never-signs-release', '(assertion: no assembleRelease/bundleRelease in this tool)', 0, 0, { releaseTasks: 0 });
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
  record('baseline-parity', `write ${BASELINE_PATH.replace(/\\/g, '/')}`, 0, 0, { recorded: harnessPass.length });
} else if (existsSync(BASELINE_PATH)) {
  const ref = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const now = new Map(harnessPass.map((h) => [h.name, h]));
  baselineDiff = (ref.harnessPass || [])
    .filter((h) => !now.has(h.name))
    .map((h) => redact(`${h.name}: passed at BASE_SHA, not passing now`));
  record('baseline-parity', `diff vs ${BASELINE_PATH.replace(/\\/g, '/')}`,
    baselineDiff.length === 0 ? 0 : 1, 0, { reference: (ref.harnessPass || []).length, regressed: baselineDiff.length });
} else {
  record('baseline-parity', `read ${BASELINE_PATH.replace(/\\/g, '/')}`, 1, 0, { missing: 1 });
}

// ── evidence JSON (NEW-MA-2: committed in the repo under e2e-evidence/) ────
const result = failed ? 'FAIL' : 'PASS';
const evidence = {
  phase: PHASE,
  label: LABEL ? redact(LABEL) : null,
  sha: SHA,
  baseSha: BASE_SHA,
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
  failedStep: failed ? redact(failed) : null,
  result,
};

mkdirSync(OUTDIR, { recursive: true });
const outFile = join(OUTDIR, `gate-${PHASE}-${SHA.slice(0, 7)}${LABEL ? `-${LABEL.replace(/[^a-z0-9]+/gi, '-')}` : ''}.json`);
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

console.log(
  `\n${result} — ${steps.filter((s) => s.exit === 0).length}/${steps.filter((s) => !s.skipped).length} steps` +
  `${failed ? `; first failure: ${failed}` : ''}\nevidence: ${outFile.replace(/\\/g, '/')}\n` +
  (failed ? `logs (LOCAL, never committed): ${LOGDIR.replace(/\\/g, '/')}\n` : '')
);
process.exit(failed ? 1 : 0);
