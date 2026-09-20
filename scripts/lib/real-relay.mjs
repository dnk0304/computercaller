/**
 * The REAL relay, started as a child process, on an ephemeral port, against a
 * scratch Postgres. (E2E-P6, shared infrastructure for deliverables (e), (g),
 * (h) and (i).)
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every relay suite in tests/ — pairing-persist, dock-resume, listener-heartbeat,
 * pair-state, session-superseded, relink-kill-frame-buffer, call-separation —
 * MIRRORS the relay's state machine in-file. Each one says so at the top:
 *
 *   "server.js cannot be imported without booting Next.js, so — following the
 *    established pattern in the other .mjs relay tests — this file MIRRORS the
 *    relay's pairing state machine. If you change the logic in server.js,
 *    update this copy."
 *
 * That is a legitimate and fast way to test a state machine, but it is a MODEL.
 * A mirrored test cannot fail because server.js drifted; it can only fail
 * because the mirror disagrees with itself. `scripts/e2e-live-peer-proof.mjs`
 * goes one step further — it imports the relay's real validators into a
 * stand-in `WebSocketServer` — but the socket, the room table, the resume
 * claim and the frame buffer are still the harness's own.
 *
 * P6 (g) is defined by the brief as the scenario where NO side is simulated.
 * So this module runs the actual `node server.js` from the actual tree. What it
 * proves that a mirror cannot: routing, the tier gate, the e2e block
 * passthrough, PAIR_STATE ctx splicing, the resume claim, the frame buffer and
 * the log redaction, all in the code that ships.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * ------------------------------
 * - It never binds a fixed port. Two lanes on this box sharing port 3001 is how
 *   a harness quietly measures another lane's server; that failure mode reports
 *   all-zero assertions and looks like a pass. Ports are drawn from a random
 *   window and ownership-checked before use.
 * - It never kills by image name (WORKTREE_STANDARD rules 12 + 14). `stop()`
 *   kills ONLY the pid it spawned, by pid, with its descendants, and then
 *   re-censuses to prove the child actually died — because on Windows the
 *   wrapper pid exiting does not mean the node child did.
 * - It never writes its log inside the measured tree (rule 16). Relay stdout
 *   contains message bodies and canary strings; a log file inside the worktree
 *   would be picked up by `git status`, by the scope diff, and — worst — could
 *   be committed. Logs go to an out-of-tree directory the caller names.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { census, killTree, descendantsOf } from './reap.mjs';

const WIN = process.platform === 'win32';

/**
 * The pid that owns a TCP listener on `port`, or null.
 *
 * "Can I connect?" is NOT the same question. A port can be free for connect and
 * still be mid-bind by another lane; and a port that answers may be answering
 * from someone else's server, which is the exact confusion this guards against.
 */
export function portOwnerPid(port) {
  if (!WIN) {
    const r = spawnSync('bash', ['-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -1`], { encoding: 'utf8' });
    const pid = parseInt((r.stdout || '').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  }
  const ps = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const pid = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/** A port nobody is listening on, drawn from a random offset in [from, from+span). */
export function freePort(from = 3400, span = 2000) {
  const start = from + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = from + ((start - from + i) % span);
    if (!portOwnerPid(p)) return p;
  }
  throw new Error(`no free port in [${from}, ${from + span})`);
}

/** Poll until the port accepts a connection, or the child dies, or we time out. */
async function waitForListen(port, proc, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 1000);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Start `node server.js` from `cwd`.
 *
 * @param {object}  opts
 * @param {string}  opts.cwd          repo root (the worktree)
 * @param {string}  opts.logDir       OUT-OF-TREE directory for the stdout log
 * @param {string}  opts.databaseUrl  scratch Postgres (postgresql:// only)
 * @param {object}  opts.env          extra env (E2E_PAIRING_ENABLED, STAGING, …)
 * @param {number}  opts.timeoutMs    readiness budget
 * @param {string}  opts.label        goes in the log filename
 * @returns {Promise<RealRelay>}
 */
export async function startRealRelay({
  cwd,
  logDir,
  databaseUrl,
  env = {},
  timeoutMs = 180_000,
  label = 'relay',
} = {}) {
  if (!cwd) throw new Error('startRealRelay: cwd is required');
  if (!logDir) throw new Error('startRealRelay: logDir is required (must be OUTSIDE the measured tree — rule 16)');
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    // The gate refuses sqlite for the same reason: the DeviceKey routes and the
    // entitlement lookups behave differently, and a green run against sqlite
    // would be evidence about a database we do not ship.
    throw new Error('startRealRelay: databaseUrl must be a postgresql:// URL');
  }
  const resolvedLogDir = path.resolve(logDir);
  const resolvedCwd = path.resolve(cwd);
  if (resolvedLogDir === resolvedCwd || resolvedLogDir.startsWith(resolvedCwd + path.sep)) {
    throw new Error(`startRealRelay: logDir ${resolvedLogDir} is inside the measured tree ${resolvedCwd} — rule 16 forbids it`);
  }
  fs.mkdirSync(resolvedLogDir, { recursive: true });

  const port = freePort();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(resolvedLogDir, `${label}-${port}-${stamp}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: resolvedCwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Tee: the file is the durable artefact the canary grep (i) runs against; the
  // ring buffer is what we can quote in a failure message without re-reading a
  // file that may hold real bodies.
  //
  // TEARDOWN RACE (found by this module's own smoke test, P6): the child does
  // not stop writing the instant we close the fd. A chunk already in flight
  // lands after `closeSync`, `writeSync` throws EBADF from inside a stream
  // 'data' event — which is an unhandled throw, not a rejected promise — and
  // the whole harness process dies AFTER it has already reported success.
  //
  // That is the R-AE shape exactly: the work passed, the teardown crashed, and
  // the exit code blamed the work. So the fd has an explicit open/closed state
  // and every write is gated on it. `logOpen` is checked, not `try/catch`ed,
  // because swallowing EBADF would also swallow a genuinely broken log.
  let tail = '';
  let logOpen = true;
  const TAIL_MAX = 64 * 1024;
  const onChunk = (buf) => {
    tail = (tail + buf.toString()).slice(-TAIL_MAX);
    if (!logOpen) return;
    fs.writeSync(logFd, buf);
  };
  const closeLog = () => {
    if (!logOpen) return;
    logOpen = false;
    proc.stdout.off('data', onChunk);
    proc.stderr.off('data', onChunk);
    try { fs.closeSync(logFd); } catch { /* already gone */ }
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  const ready = await waitForListen(port, proc, timeoutMs);
  if (!ready) {
    // Fail with the server's OWN error text. A bare "port never opened" is how
    // a stale Prisma client once cost two hours of diagnosis across six
    // unrelated-looking harness symptoms.
    const hint = /(@prisma\/client did not initialize yet[^\n]*|PrismaClientInitializationError[^\n]*|Error:[^\n]*|EADDRINUSE[^\n]*)/i.exec(tail);
    try { killTree(proc.pid); } catch { /* best effort */ }
    closeLog();
    throw new Error(
      `real relay did not listen on ${port} within ${timeoutMs}ms`
      + (proc.exitCode !== null ? ` (exited ${proc.exitCode})` : '')
      + (hint ? `\n  server said: ${hint[1]}` : `\n  log: ${logPath}`),
    );
  }

  // Ownership check AFTER readiness: prove the thing answering on this port is
  // OUR child, not another lane's server that happened to take the port between
  // freePort() and bind. Without this the harness can measure a stranger.
  const owner = portOwnerPid(port);
  const ours = new Set([proc.pid, ...descendantsOf(proc.pid).map((p) => p.pid)]);
  if (owner !== null && !ours.has(owner)) {
    try { killTree(proc.pid); } catch { /* best effort */ }
    closeLog();
    throw new Error(`port ${port} is owned by pid ${owner}, which is not our child (pid ${proc.pid}) — refusing to measure another lane's server`);
  }

  let stopped = false;
  return {
    port,
    pid: proc.pid,
    logPath,
    /** ws:// base for relay clients. */
    wsBase: `ws://127.0.0.1:${port}`,
    /** http:// base for the API routes (DeviceKey register/list/revoke). */
    httpBase: `http://127.0.0.1:${port}`,
    /** Last 64 KiB of server output — for failure messages only, never asserted on. */
    tail: () => tail,
    /** Everything the relay has written, from disk. Used by the canary grep. */
    readLog: () => fs.readFileSync(logPath, 'utf8'),
    /**
     * Kill ONLY this pid + its descendants, then prove they are gone.
     * Safe to call twice; call it from a `finally`, always.
     */
    stop() {
      if (stopped) return { alreadyStopped: true, leaked: [] };
      stopped = true;
      const wanted = [proc.pid, ...descendantsOf(proc.pid).map((p) => p.pid)];
      try { killTree(proc.pid); } catch { /* best effort */ }
      closeLog();
      // The wrapper pid exiting is not proof the node child died. Re-census.
      const alive = new Set(census().map((p) => p.pid));
      const leaked = wanted.filter((p) => alive.has(p));
      return { alreadyStopped: false, killed: wanted, leaked };
    },
  };
}

/**
 * Run `fn(relay)` with a real relay, reaping in `finally` whatever happens.
 * This is the shape every P6 harness should use — there is no path out of this
 * function, exception or not, that leaves the child running.
 */
export async function withRealRelay(opts, fn) {
  const relay = await startRealRelay(opts);
  try {
    return await fn(relay);
  } finally {
    const r = relay.stop();
    if (r.leaked?.length) {
      console.error(`  LEAK relay pids still alive after stop(): ${r.leaked.join(', ')}`);
      process.exitCode = 1;
    }
  }
}
