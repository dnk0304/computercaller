/**
 * scripts/lib/computer-peer.mjs — the COMPUTER side of a real phone↔computer
 * pair: the real /app page plus the real unpacked extension service worker in
 * one real Chromium, both talking to the real relay. E2E-P6.1b.
 *
 * Extracted from scripts/e2e-cross-impl-proof.mjs so the phone leg can drive
 * the same surfaces rather than growing a second, divergent copy of the
 * bring-up. That driver keeps its own entry point and behaviour.
 *
 * ── THE ORIGIN PROBLEM, AND WHY THE ANSWER IS A PROXY AND NOT A FLAG ───────
 *
 * P6 recorded, as a hard limitation, that the web client never opened a relay
 * socket in its harness:
 *
 *     [RelayTicket] CSRF reject: bad-origin
 *         (origin=http://127.0.0.1:PORT, expected=http://localhost:3000)
 *
 * The cause is not the harness and not the product. scripts/lib/real-relay.mjs
 * starts the relay with NODE_ENV=production (real-relay.mjs:143); in
 * production lib/auth.ts:514 pins the expected origin to NEXT_PUBLIC_APP_URL
 * rather than to the request's Host. So a page served from an ephemeral port
 * can never mint a browser relay ticket, and every scenario needing the
 * computer on the wire was BLOCKED behind it.
 *
 * MEASURED, not assumed: setting NEXT_PUBLIC_APP_URL in the relay's runtime
 * env does NOT move the pin. Next inlines NEXT_PUBLIC_* into the compiled
 * bundle at BUILD time, so the route handler carries the value baked into
 * .next — this lane observed `expected=http://localhost:3000` from a relay
 * started with NEXT_PUBLIC_APP_URL=https://computercaller.com. Changing it
 * would require rebuilding, which would mean the page under test was no longer
 * the artefact the gate graded.
 *
 * So instead of moving the origin to the page, this moves the page to the
 * origin: a plain forwarding proxy on 127.0.0.1:3000 — the exact host:port the
 * shipped build already expects — splicing http and WebSocket traffic to the
 * relay's ephemeral port. The page's Origin is then `http://localhost:3000`,
 * the mint's own unmodified CSRF check passes, and the check is SATISFIED
 * rather than disabled. Nothing about the relay, the route or the page is
 * patched, and `--ignore-certificate-errors` never appears: a harness that
 * turns a security control off cannot then report on that control's behaviour.
 *
 * The PHONE reaches the same relay through its own TLS terminator as
 * https://computercaller.com (the APK hardcodes that host). Two front doors,
 * one relay, one pair — which is the shape the product actually ships.
 *
 * Port 3000 is fixed, not ephemeral, because the baked origin names it. That
 * is the one place this module cannot use an ephemeral port, so the caller
 * MUST check ownership first (WORKTREE_STANDARD rule 13): a pre-existing dev
 * server on 3000 would serve OLD code and the run would silently measure it.
 * assertAppPortFree() below is that check.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { census, descendantsOf } from './reap.mjs';

export const APP_PORT = 3000;
export const APP_ORIGIN = `http://localhost:${APP_PORT}`;

/**
 * Refuse to start if anything already listens on the app port.
 *
 * Returns the owning pid, or null when free. The caller fails loudly on a
 * non-null result rather than binding beside it: "address in use" would be the
 * lucky outcome; the unlucky one is a stale server answering our page's
 * requests with last week's build.
 */
export function assertAppPortFree(port = APP_PORT) {
  const ps = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const pid = Number((r.stdout || '').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Forward http + WebSocket traffic from the baked app origin to the relay.
 *
 * The upgrade is a raw socket splice rather than an http-client round trip:
 * the relay authenticates AT the upgrade, so any header rewriting here would
 * make the proven thing "this proxy's handshake" instead of the page's.
 */
export function startAppOriginProxy(relayPort, { onRequest, onUpgrade } = {}) {
  const server = http.createServer((req, res) => {
    onRequest?.(req);
    const up = http.request(
      { host: '127.0.0.1', port: relayPort, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
    );
    up.on('error', (e) => { try { res.writeHead(502); res.end(String(e.message)); } catch { /* client gone */ } });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    onUpgrade?.(req);
    const up = net.connect(relayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const kill = () => { try { up.destroy(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } };
    up.on('error', kill); socket.on('error', kill);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(APP_PORT, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Launch the real Chromium with the shipped extension loaded unpacked and real
 * session cookies for `user`, and return the page + the real MV3 worker.
 *
 * `log` is called with progress strings. Every await below is bounded, because
 * this bring-up has already hung once in this lane: an unbounded wait here
 * presents as a dead harness with no output, which is indistinguishable from a
 * relay that never came up.
 */
export async function startComputerPeer({ extDir, jwtSecret, user, headless = false, log = () => {} }) {
  const before = census();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-p61b-'));

  log(`launching chromium (extension: ${extDir})`);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  const access = jwt.sign(
    { userId: user.id, email: user.email, ver: user.sessionVersion ?? 0, purpose: 'access' },
    jwtSecret, { expiresIn: '30d' },
  );
  const idle = jwt.sign({ userId: user.id, purpose: 'idle' }, jwtSecret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });
  const extToken = jwt.sign(
    { userId: user.id, ver: user.sessionVersion ?? 0, purpose: 'ext-session' },
    jwtSecret, { expiresIn: '30d' },
  );

  // domain 'localhost', secure:false — the baked origin is http, and a Secure
  // cookie on an http origin is simply not sent, which presents as "signed
  // out" and costs a whole run to diagnose.
  await ctx.addCookies([
    { name: 'auth_token', value: access, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    { name: 'idle_token', value: idle, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ]);

  log('waiting for the extension service worker');
  const { awaitServiceWorker } = await import('./ext-sw.mjs');
  // wake:false — the default wake opens popup.html, which iframes
  // CC.EXTENSION_URL (https://computercaller.com/extension). In THIS lane that
  // host resolves, through the phone leg's TLS terminator, to our own relay,
  // so the nudge page pulls a real cross-origin document and the bring-up
  // stalls behind it. The worker starts on its own at install; the poll is the
  // real mechanism and the wake was only ever a hurry-up.
  const sw = await awaitServiceWorker(ctx, null, { extDir, wake: false, timeoutMs: 60_000 });
  const extId = new URL(sw.url()).host;
  log(`extension service worker up: ${extId}`);

  const page = await ctx.newPage();

  /**
   * Repoint the SHIPPED extension at the local relay by mutating its own
   * `self.CC` config object at runtime — the single-knob repoint
   * chrome-extension/config.js's own header prescribes ("If the webapp ever
   * moves off computercaller.com, change ONLY this file"). No extension file
   * is edited, so the loaded package stays byte-identical to the shipped one.
   */
  const repointSw = () => sw.evaluate(({ tok, origin, ws }) => {
    self.CC.WEBAPP_ORIGIN = origin;
    self.CC.RELAY_BASE = `${ws}/relay`;
    self.CC.TICKET_URL = `${origin}/api/auth/relay-ticket/extension`;
    self.CC.ME_URL = `${origin}/api/auth/me`;
    return new Promise((r) => chrome.storage.local.set({ [self.CC.TOKEN_KEY]: tok }, r));
  }, { tok: extToken, origin: APP_ORIGIN, ws: `ws://localhost:${APP_PORT}` });

  /**
   * Every Chromium pid this run is responsible for.
   *
   * Censused while the process tree is still INTACT, because ctx.close() kills
   * the browser root first and a renderer that outlives it can no longer be
   * found by walking the tree — the leak P6 run 1 shipped. Ownership is proven
   * by "did not exist before this run", never by image name, and explorer.exe's
   * tree (the human's own browser) is excluded per WORKTREE_STANDARD rule 12.
   */
  const ownBrowserPids = () => {
    const snap = census();
    const had = new Set(before.map((p) => p.pid));
    const mine = new Set(descendantsOf(process.pid, snap));

    // MEASURED, then fixed. The first form of this excluded everything under
    // explorer.exe, copying the shape used by the gate's own harnesses. On an
    // interactive box THIS process also descends from explorer.exe, so the
    // exclusion swallowed our own Chromium and the reaper reported
    // "reaped 0 chromium pid(s)" with a live browser on screen — a detector
    // that could not fire, which is worse than no detector.
    //
    // Ownership is therefore positive, not subtractive: a pid is ours when it
    // is Chromium-family, did not exist before this run, AND descends from
    // this process — which Playwright's browser always does, because we
    // launched it. Nothing is ever claimed by image name alone, and the
    // human's own browser can never satisfy the descent test.
    return snap
      .filter((p) => !had.has(p.pid)
        && mine.has(p.pid)
        && /^(chrome|chromium|msedge|headless_shell)/i.test(p.name))
      .map((p) => ({ pid: p.pid, name: p.name }));
  };

  return { ctx, page, sw, extId, extToken, userDataDir, ownBrowserPids, before, origin: APP_ORIGIN, repointSw };
}
