/**
 * Process reaping for harnesses and the gate.
 * (E2E-P5a slice 1, deliverable (c) — WORKTREE_STANDARD rule 14.)
 *
 * Dennis, 2026-09-17: "we should remember to close all processes once they are
 * done, the pc crashed the other day because of this." Sixty-odd orphaned
 * chrome.exe accumulated on this box from lanes that returned without killing
 * what they started — and orphans are also the load that makes the extension
 * harnesses flaky, so this is the same defect as deliverable (a) seen from the
 * other end.
 *
 * THE RULE, VERBATIM (WORKTREE_STANDARD rules 12 + 14):
 *   never kill by image name. No `taskkill /IM`, no `Stop-Process -Name`.
 *   Only PIDs you recorded. Never explorer.exe's tree — that is Dennis's own
 *   browser.
 *
 * So this module never matches on a name in order to KILL. It matches on a name
 * only to take a census, and every kill is by a PID that was proven to descend
 * from THIS process.
 */
import { spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';

/**
 * Every live process as { pid, ppid, name }. Windows recycles PIDs, so the
 * census is always taken fresh rather than cached across a long run.
 */
export function census() {
  if (!WIN) {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    return (r.stdout || '').trim().split('\n').flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? [{ pid: +m[1], ppid: +m[2], name: m[3].trim() }] : [];
    });
  }
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const parsed = JSON.parse(r.stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: String(p.Name || '') }));
  } catch {
    return [];
  }
}

/** Kill one PID and its descendants. PID only — never a name, never a pattern. */
export function killTree(pid) {
  if (!pid || pid === process.pid) return false;
  if (WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* no group */ }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

/** Every descendant PID of `root`, root included, from a census snapshot. */
export function descendantsOf(rootPid, snapshot = census()) {
  const byParent = new Map();
  for (const p of snapshot) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p.pid);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of byParent.get(pid) || []) stack.push(c);
  }
  return out;
}

/**
 * Records what a harness spawns and kills exactly that, by PID, in try/finally —
 * on the success path and on the failure path alike.
 *
 * Usage:
 *   const reaper = new Reaper();
 *   const before = reaper.mark();                       // census before launch
 *   const ctx = await chromium.launchPersistentContext(...);
 *   reaper.adoptBrowser(before);                        // find the browser root
 *   try { ...assertions... } finally {
 *     await ctx.close().catch(() => {});
 *     reaper.reap();                                    // by recorded PID
 *   }
 */
export class Reaper {
  constructor() {
    /** @type {Map<number,string>} recorded PID → what it is */
    this.owned = new Map();
  }

  /** Snapshot for a later diff. */
  mark() { return census(); }

  /** Record a PID we know we started (a spawn()'s .pid, for instance). */
  own(pid, label = 'spawned') {
    if (pid && pid !== process.pid) this.owned.set(pid, label);
    return pid;
  }

  /**
   * Find the browser process Playwright just started and record it.
   *
   * Identified as: a process that did not exist in `before`, whose PARENT is
   * this node process. That is a proof of ownership, not a name match — the
   * name is used only to narrow the census, never as the kill criterion.
   * Renderers and GPU children are not recorded individually; they are killed
   * as descendants of this root at reap time, which is also how they are found
   * if Chromium spawns them later.
   */
  adoptBrowser(before, hint = /^(chrome|chromium|msedge|headless_shell)/i) {
    const had = new Set(before.map((p) => p.pid));
    const now = census();
    const roots = now.filter((p) => !had.has(p.pid) && hint.test(p.name) && p.ppid === process.pid);
    // Fall back to any new matching process whose parent is not itself new —
    // covers a launcher shim sitting between node and the browser.
    const picked = roots.length ? roots
      : now.filter((p) => !had.has(p.pid) && hint.test(p.name)
        && !now.some((q) => q.pid === p.ppid && !had.has(q.pid) && hint.test(q.name)));
    for (const p of picked) this.own(p.pid, `browser:${p.name}`);
    return picked.map((p) => p.pid);
  }

  /**
   * Kill everything recorded, plus its descendants. Idempotent and never
   * throws: a reaper that can throw cannot live in a finally block.
   * @returns {{killed:number, pids:number[]}}
   */
  reap() {
    const snapshot = census();
    const live = new Set(snapshot.map((p) => p.pid));

    /**
     * Collect every LIVE descendant, then kill each one BY ITS OWN PID.
     *
     * The first version only did `killTree(root)` and trusted it. The gate's
     * own leak assertion caught that being wrong on the very first run:
     * ext-badge-counter-proof reported "reaped: yes 2 (41316,20616)" and the
     * gate then found both still running with a dead parent (34856).
     *
     * Cause: `await ctx.close()` runs BEFORE this, and it already kills the
     * browser root. `taskkill /PID <dead pid> /T` then has no tree to walk, so
     * any renderer that outlived its parent — which is exactly the orphan we
     * are trying to prevent — was never touched. Killing the root is necessary
     * and not sufficient; the descendants must be named individually, deepest
     * first so a parent's death cannot reparent a child out from under us.
     */
    const targets = [];
    for (const [pid] of this.owned) {
      for (const d of descendantsOf(pid, snapshot)) if (live.has(d)) targets.push(d);
    }
    const unique = [...new Set(targets)];
    // Deepest first: descendantsOf returns root-first, so reverse it.
    for (const pid of unique.slice().reverse()) {
      try { killTree(pid); } catch { /* already gone */ }
    }
    this.owned.clear();

    /**
     * Report what actually DIED, not what we tried to kill. A cleanup routine
     * that reports its intentions is how the bug above stayed invisible: the
     * harness printed a confident "reaped: yes 2" about two processes that
     * were still running.
     */
    const after = new Set(census().map((p) => p.pid));
    const gone = unique.filter((p) => !after.has(p));
    const survived = unique.filter((p) => after.has(p));
    return { killed: gone.length, pids: gone, survived };
  }

  /**
   * Belt to the try/finally's braces. `reap()` is fully synchronous (spawnSync
   * taskkill), which is the one kind of cleanup that still works from an
   * 'exit' handler — so a harness that dies on an uncaught throw, an unhandled
   * rejection, or a Ctrl-C STILL kills its browser. try/finally alone does not
   * cover any of those three.
   *
   * Idempotent: reap() clears the owned set, so the hook is a no-op after a
   * normal finally-block reap.
   */
  installExitHook(tag = 'harness') {
    if (this._hooked) return this;
    this._hooked = true;
    const fire = () => {
      if (!this.owned.size) return;
      const { killed, pids } = this.reap();
      if (killed) console.log(`[reap] ${tag}: emergency reap on exit — ${killed} PID(s): ${pids.join(',')}`);
    };
    process.on('exit', fire);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => { fire(); process.exit(130); });
    }
    // Node's default for an uncaught throw is "print and exit 1". Preserve that
    // exactly — a harness must not start passing because cleanup swallowed its
    // crash — and only add the reap in front of it.
    process.on('uncaughtException', (e) => { fire(); console.error(e); process.exit(1); });
    return this;
  }

  /** One line for the harness's own output, so "reaped" is a number not a claim. */
  reapAndReport(tag = 'harness') {
    const { killed, pids, survived } = this.reap();
    console.log(`[reap] ${tag}: spawned PIDs reaped: yes ${killed}${killed ? ` (${pids.slice(0, 12).join(',')}${pids.length > 12 ? ',…' : ''})` : ''}`);
    // Never silent about a survivor: the gate will fail the step for it anyway,
    // and the harness's own log should say so first.
    if (survived?.length) {
      console.log(`[reap] ${tag}: WARNING — ${survived.length} process(es) SURVIVED the kill: ${survived.join(',')}`);
    }
    return killed;
  }
}

/**
 * The gate's leak assertion (deliverable (c), second half).
 *
 * After a harness returns, no browser/node process it started may still be
 * running. A survivor is identified two ways, both PID-based:
 *
 *   - its parent PID no longer exists (an orphan), or
 *   - its parent is inside the gate's own process tree.
 *
 * Processes under explorer.exe are NEVER reported: that is Dennis's own
 * browser and his own terminals. So are processes that existed in `before`,
 * which belong to some other lane and are not ours to judge.
 *
 * @returns {{leaked:number, pids:Array<{pid:number,ppid:number,name:string,why:string}>}}
 */
export function findLeaks(before, gateRootPid = process.pid, { allow = [], hint = /^(chrome|chromium|node|msedge|headless_shell)/i } = {}) {
  const now = census();
  const had = new Set(before.map((p) => p.pid));
  // PIDs the gate legitimately owns for longer than one step — the gate-owned
  // dev server outlives every harness by design and is killed by stopDevServer.
  const allowed = new Set(allow.filter(Boolean).flatMap((pid) => descendantsOf(pid, now)));
  const live = new Set(now.map((p) => p.pid));
  const gateTree = new Set(descendantsOf(gateRootPid, now));

  // Everything under explorer.exe is the human's, transitively.
  const explorerPids = now.filter((p) => /^explorer\.exe$/i.test(p.name)).map((p) => p.pid);
  const human = new Set(explorerPids.flatMap((e) => descendantsOf(e, now)));

  const pids = [];
  for (const p of now) {
    if (had.has(p.pid)) continue;            // predates this step — another lane's
    if (p.pid === gateRootPid) continue;
    if (allowed.has(p.pid)) continue;        // the gate's own dev server and its children
    if (!hint.test(p.name)) continue;
    if (human.has(p.pid)) continue;          // rule 12: never explorer's tree
    const orphan = !live.has(p.ppid);
    const inGate = gateTree.has(p.ppid);
    if (orphan || inGate) {
      pids.push({ pid: p.pid, ppid: p.ppid, name: p.name, why: orphan ? 'parent-dead' : 'parent-in-gate-tree' });
    }
  }
  return { leaked: pids.length, pids };
}

export default Reaper;
