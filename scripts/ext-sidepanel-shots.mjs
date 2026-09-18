/**
 * PIXEL-C visual proof harness.
 *
 * Forge-E's three "surface" screenshots came out byte-identical (32376 B each),
 * so the brief treats that surface evidence as unverified. This harness exists
 * to produce the states for real, at real geometry, and to make the signed-in
 * ones reachable without a live account:
 *
 *   - the extension is loaded from a COPY in tmp whose config.js points at the
 *     local dev server, so the screenshots show THIS branch's /extension and
 *     not the deployed one;
 *   - the shell's session probe is stubbed per-page (window.fetch on ME_URL),
 *     which is the one thing standing between a local build and the signed-in
 *     surface. Nothing else is faked: the presence port, shell-hello, canDock,
 *     the unread push and the whole iframe handshake are the real code paths.
 *
 * chrome.sidePanel's own window is browser chrome and cannot be captured by
 * Playwright at all. So the panel is captured as sidepanel.html rendered at the
 * exact viewport sizes the panel produces — the same document, the same width,
 * the same height behaviour — and the "does the toolbar icon open it" question
 * is answered from the service worker instead, by reading back the panel
 * behaviour Chrome actually stored.
 */
import { chromium } from 'playwright';
import { exitAfterFlush } from './lib/finish.mjs';
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { Reaper } from './lib/reap.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'C:/Users/D/worktrees/computercaller/ext-sidepanel';
const OUT = 'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/extension-login-and-reflecto-redesign/evidence';
const DEV = 'http://localhost:3123';

// ---- extension copy, pointed at the dev server -----------------------------
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-shot-'));
fs.cpSync(path.join(REPO, 'chrome-extension'), EXT, { recursive: true });
const cfg = fs.readFileSync(path.join(EXT, 'config.js'), 'utf8')
  .replaceAll('https://computercaller.com', DEV)
  .replace('wss://', 'ws://');
fs.writeFileSync(path.join(EXT, 'config.js'), cfg);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shot-profile-'));
// P5a(c) / WORKTREE_STANDARD rule 14: record what we spawn so we can kill it
// by PID in the finally below — on the failure path as well as the success one.
const reaper = new Reaper().installExitHook('ext-sidepanel-shots');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

const sessionStub = (status) => `
  (() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/auth/me')) {
        return Promise.resolve(new Response(
          ${status} === 200 ? JSON.stringify({ user: { email: 'dennis@computercaller.com' } }) : '{}',
          { status: ${status}, headers: { 'content-type': 'application/json' } },
        ));
      }
      return real(input, init);
    };
  })();
`;

async function shot(name, url, width, height, { authed = true, settle = 3500, act } = {}) {
  const page = await ctx.newPage();
  // 200 → the signed-in surface; 401 → the real signed-out gate (skeleton →
  // framed /extension/login). Stubbing the 401 rather than letting the probe
  // fail is the difference between capturing the sign-in state and capturing
  // the network-error state, which are different screens.
  await page.addInitScript(sessionStub(authed ? 200 : 401));
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(settle);
  if (act) { await act(page); await page.waitForTimeout(900); }
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const bytes = fs.statSync(file).size;
  console.log(`  shot ${name}  ${width}x${height}  ${bytes} B`);
  await page.close();
  return bytes;
}

try {
  // P5a(a): wake the MV3 worker instead of polling for one that is registered
  // but idle. `ctx.serviceWorkers()` lists only RUNNING workers, so the old
  // 60x500ms poll reported "service worker never registered" for a perfectly
  // healthy extension whenever nothing had happened to start it. The
  // assertions below are unchanged. See scripts/lib/ext-sw.mjs.
  const sw = await awaitServiceWorker(ctx, null, { extDir: EXT });
  const extId = new URL(sw.url()).host;
  check('service worker registered', true, extId);
  check('extension ID is the pinned one', extId === 'helkcjjlidcceiifjccolmppanfmcjjg', extId);

  // ---- manifest facts (Forge-E's plumbing, re-verified not assumed) --------
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  check('manifest declares side_panel.default_path', mf.side_panel?.default_path === 'sidepanel.html', String(mf.side_panel?.default_path));
  check('manifest has the sidePanel permission', mf.permissions.includes('sidePanel'));
  check('action.default_popup is GONE (else it beats the panel on click)', !('default_popup' in (mf.action || {})));

  // ---- the toolbar click really opens the panel ----------------------------
  const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
  check('openPanelOnActionClick is set → toolbar icon opens the PANEL',
    behavior?.openPanelOnActionClick === true, JSON.stringify(behavior));
  const opts = await sw.evaluate(() => chrome.sidePanel.getOptions({}));
  check('side panel resolves to sidepanel.html', opts?.path === 'sidepanel.html', JSON.stringify(opts));

  // ---- unread counts, so the Dial / Texts badges have something to show ----
  await sw.evaluate(() => chrome.storage.session.set({
    cc_unread: { missedCalls: 3, newSms: 5, alerts: 1 },
  }));
  check('SW unread seeded (3 missed / 5 sms / 1 alert)', true);

  const base = `chrome-extension://${extId}`;

  // ---- SIGNED OUT, in the panel -------------------------------------------
  // Caught early on purpose: this is the BOOT SKELETON, the first face of the
  // signed-out gate (PIXEL-D). C-07 below is the same panel once the framed
  // login has reported ready — two states, not one screenshot taken twice.
  await shot('C-01-sidepanel-signedout-skeleton-400x900', `${base}/sidepanel.html`, 400, 900,
    { authed: false, settle: 350 });

  // ---- SIGNED IN: narrow-and-tall, the panel's default and worst case ------
  const a = await shot('C-02-sidepanel-signedin-400x900', `${base}/sidepanel.html`, 400, 900);
  // ---- The badge mechanics, proved rather than asserted --------------------
  // On Dial, the Dial badge is 0 (you are looking at it) and Texts shows 5.
  // Switch to Texts and the two swap: Texts clears (viewing IS the read
  // receipt) and Dial's 3 missed calls appear.
  await shot('C-02b-sidepanel-texts-tab-badges-swap', `${base}/sidepanel.html`, 400, 900, {
    act: async (page) => {
      const f = page.frameLocator('#cc-frame');
      await f.getByRole('tab', { name: /Texts/ }).click();
    },
  });

  // ---- Deep link + the Dial badge, in one shot -----------------------------
  // Opening on Dial legitimately consumes the missed-call count — you are
  // looking at them — which is why C-02 shows no Dial badge. So re-seed, then
  // open the panel the way a notification does: sidepanel.html#tab=texts,
  // which shell.js passes straight through to the hosted route. Two things
  // must be true in this capture: Texts is the selected tab (the deep link
  // landed) and Dial now carries its 3 (the count survived a surface that
  // never showed it).
  await sw.evaluate(() => chrome.storage.session.set({
    cc_unread: { missedCalls: 3, newSms: 0, alerts: 1 },
  }));
  await shot('C-02c-sidepanel-deeplink-tab-texts', `${base}/sidepanel.html#tab=texts`, 400, 900);

  // ---- SIGNED IN: a dragged-open panel, just under the 560px cap ----------
  const b = await shot('C-03-sidepanel-widened-540x900', `${base}/sidepanel.html`, 540, 900);
  // ---- SIGNED IN: dragged past the cap — column centres, gutters show -----
  const c = await shot('C-04-sidepanel-widened-760x900', `${base}/sidepanel.html`, 760, 900);
  check('the three panel captures are genuinely different renders',
    new Set([a, b, c]).size === 3, `${a} / ${b} / ${c} bytes`);

  // ---- very short panel: nothing may assume 600px of height ---------------
  await shot('C-05-sidepanel-short-400x420', `${base}/sidepanel.html`, 400, 420);

  // ---- the pop-out, which KEEPS working and now carries the dock control --
  await shot('C-06-popout-800x620-dock-control', `${base}/popout.html`, 800, 620);

  // ---- the embedded sign-in, framed, at panel geometry --------------------
  await shot('C-07-login-framed-400x900', `${base}/sidepanel.html`, 400, 900, { authed: false, settle: 5000 });

  fs.writeFileSync(path.join(OUT, 'C-proof.json'),
    JSON.stringify({ when: new Date().toISOString(), extId, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await ctx.close();
  reaper.reapAndReport('ext-sidepanel-shots');
}

// ── E2E-P5a (f): EXIT, do not merely stop having work to do. ──────────────
// Three harnesses in the P5A gate were recorded as timeouts with a COMPLETE
// summary in their logs. The gate-side cause is fixed and is NOT a hang:
// child.kill() on a shell:true step signals cmd.exe only, so the timeout never
// stopped the work (tests/gate-child-exit.test.mjs). This is the other half:
// once the summary is printed and the finally block has closed the browser and
// reaped, nothing is left to wait for, so say so explicitly rather than hoping
// the event loop drains. exitAfterFlush flushes stdout first — on Windows the
// gate reads this over a pipe, where writes are async and a bare process.exit
// can truncate the very summary line the gate parses.
exitAfterFlush(process.exitCode ?? 0);
