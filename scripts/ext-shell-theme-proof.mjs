/**
 * PIXEL-R proof harness — the extension SHELL follows the in-app theme toggle.
 *
 * THE BUG (Dennis, via Pixel-Q): the popup is two documents. The iframe
 * (computercaller.com/extension) has followed `data-cc-theme` since dispatch J;
 * chrome-extension/shell.css still asked the OS. Force Light from the account
 * menu on a dark OS and the iframe turned light while the shell chrome around
 * it — the title band and the ring of page colour — stayed dark.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. Be precise, because a proof that quietly
 * tests its own stub is worse than no proof.
 *   REAL: chrome-extension/{shell.css,shell.js,popup.html,sidepanel.html} are
 *         loaded UNMODIFIED as an actual unpacked MV3 extension, so the
 *         synchronous matchMedia stamp, the chrome.storage.local read, the
 *         postMessage gate and the whole shell.css cascade are the shipped code.
 *   REAL: the framed page runs THEME_BOOT_SCRIPT extracted VERBATIM out of
 *         lib/extensionTheme.ts at run time (no copy in this file — a copy
 *         would keep passing after the original changed), and paints the same
 *         page colours app/extension/extension.css paints, read out of that
 *         file at run time too.
 *   STUB: the React tree inside the iframe. This dispatch does not touch it and
 *         a running Next server is not available from a worktree. The one thing
 *         it would add — that the app's own surfaces are themed — is dispatch
 *         J's proof, not this one.
 *
 * Only two things are patched into the temp copy of the extension, both at the
 * network boundary: WEBAPP_ORIGIN points at this harness's local server, and
 * host_permissions follows it. shell.css and shell.js are byte-identical.
 *
 *   node scripts/ext-shell-theme-proof.mjs
 *
 * Env: CC_OUT_TAG (default "layering/shell").
 */
import { chromium } from 'playwright';
import { Reaper } from './lib/reap.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const TAG = process.env.CC_OUT_TAG || 'layering/shell';
const OUT = path.join(
  'C:/Users/D/.claude/agent-memory/ken/PROJECTS/computercaller/wave-2026-09-15-b/evidence',
  TAG,
);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---- 1) The REAL boot script + the REAL app page colours -------------------
const themeSrc = fs.readFileSync(path.join(REPO, 'lib/extensionTheme.ts'), 'utf8');
const bootMatch = themeSrc.match(/export const THEME_BOOT_SCRIPT = `([\s\S]*?)`;/);
if (!bootMatch) throw new Error('THEME_BOOT_SCRIPT not found in lib/extensionTheme.ts');
const BOOT = bootMatch[1];
check(
  'boot script posts the resolved theme to the shell',
  /postMessage\(\{source:'cc-ext',type:'theme'/.test(BOOT),
  'lib/extensionTheme.ts THEME_BOOT_SCRIPT',
);

const extCss = fs.readFileSync(path.join(REPO, 'app/extension/extension.css'), 'utf8');
const appLight = (extCss.match(/html:has\(\.cc-ext\)[\s\S]*?background:\s*([^;]+);/) || [])[1]?.trim();
const appDark = (extCss.match(/html\[data-cc-theme=dark\]:has\(\.cc-ext\)[\s\S]*?background:\s*([^;]+);/) || [])[1]?.trim();
check('read the app surface colours out of extension.css', !!appLight && !!appDark, `${appLight} / ${appDark}`);

// ---- 2) A local stand-in for computercaller.com/extension ------------------
const IFRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script>${BOOT}</script>
<style>
  html,body{margin:0;height:100%;font:12.5px system-ui}
  html:has(.cc-ext),body:has(.cc-ext){background:${appLight}}
  html[data-cc-theme=dark]:has(.cc-ext),html[data-cc-theme=dark] body:has(.cc-ext){background:${appDark}}
  .cc-ext{height:100%;display:grid;place-items:center;color:#8a8a8a}
</style></head><body><div class="cc-ext">[app surface — stubbed, see header]</div></body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/auth/me') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ user: { email: 'dennis@computercaller.com' } }));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(IFRAME_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---- 3) A temp copy of the extension, origin repointed, nothing else ------
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-theme-'));
fs.cpSync(path.join(REPO, 'chrome-extension'), EXT, { recursive: true });
for (const f of ['config.js']) {
  const p = path.join(EXT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('https://computercaller.com', ORIGIN));
}
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mf.host_permissions = [`${ORIGIN}/*`];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
/**
 * The extension id, derived from manifest.json's pinned `key` rather than read
 * off a running service worker. An MV3 worker only starts when something wakes
 * it, so waiting for one is a race that fails on a cold profile — and the id is
 * a pure function of the key, which is exactly why the key is pinned.
 * First 16 bytes of SHA-256 over the DER public key, hex mapped 0-f → a-p.
 */
const EXT_ID = crypto
  .createHash('sha256')
  .update(Buffer.from(mf.key, 'base64'))
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

for (const f of ['shell.css', 'shell.js']) {
  check(
    `${f} is shipped byte-for-byte in the proof`,
    fs.readFileSync(path.join(EXT, f)).equals(fs.readFileSync(path.join(REPO, 'chrome-extension', f))),
  );
}

// ---- 4) Capture --------------------------------------------------------------
const COMBOS = [
  ['os-dark-forced-light', 'dark', 'light', 'light'],
  ['os-light-forced-dark', 'light', 'dark', 'dark'],
  ['os-dark-system', 'dark', 'system', 'dark'],
  ['os-light-system', 'light', 'system', 'light'],
];

const MEASURE = `(() => {
  const html = document.documentElement;
  const cs = getComputedStyle(html);
  const f = document.getElementById('cc-frame');
  return {
    attr: html.getAttribute('data-cc-theme'),
    shellPage: getComputedStyle(document.body).backgroundColor,
    token: cs.getPropertyValue('--cc-page').trim(),
    ink: cs.getPropertyValue('--cc-ink').trim(),
    colorScheme: cs.colorScheme,
    frameVisible: !!f && getComputedStyle(f).display !== 'none',
  };
})()`;

for (const [name, os_, choice, expected] of COMBOS) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prof-'));
  // P5a(c) / WORKTREE_STANDARD rule 14. This loop launches a FRESH persistent
  // context per combination and had no teardown guard at all: an assertion
  // throwing at combo 2 of 4 left that Chromium, and every later one, running
  // forever — a standing contributor to the orphan pile that makes these same
  // harnesses flaky. The exit hook covers the throw path (and Ctrl-C); the
  // close + reap at the bottom of the loop covers the normal path.
  const reaper = new Reaper().installExitHook('ext-shell-theme-proof');
  const beforeLaunch = reaper.mark();
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chromium',
    colorScheme: os_,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  reaper.adoptBrowser(beforeLaunch);


  const page = await ctx.newPage();
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.waitForTimeout(1500);

  // THE CHOICE IS MADE WHERE THE USER MAKES IT: inside the framed app. It has
  // to be, and that is not a harness detail — Chrome PARTITIONS a third-party
  // frame's localStorage by top-level site, so `cc:theme:last` written by a
  // first-party visit to computercaller.com is a different bucket from the one
  // the boot script reads inside the popup. Seeding from the outside passes
  // nothing through and would have proved only that the OS still works.
  //
  // These two lines are exactly what lib/extensionTheme.ts does on a toggle:
  // writeStoredTheme() then applyTheme(). Nothing here touches chrome.storage
  // or the shell's DOM — if the shell repaints, the postMessage wire carried it.
  await page.frameLocator('#cc-frame').locator('body').waitFor({ timeout: 10_000 });
  await page.frame({ url: (u) => u.href.startsWith(ORIGIN) }).evaluate(
    ([choice, resolved]) => {
      localStorage.setItem('cc:theme:last', choice);
      document.documentElement.setAttribute('data-cc-theme', resolved);
      window.parent.postMessage({ source: 'cc-ext', type: 'theme', theme: resolved }, '*');
    },
    [choice, expected],
  );
  await page.waitForTimeout(600);

  const live = await page.evaluate(MEASURE);
  const iframeAttr = await page
    .frameLocator('#cc-frame')
    .locator(':root')
    .getAttribute('data-cc-theme')
    .catch(() => null);

  check(`${name}: shell follows the toggle live`, live.attr === expected, `got ${live.attr}`);
  check(`${name}: iframe agrees — no mismatched ring`, iframeAttr === expected, `got ${iframeAttr}`);
  check(
    `${name}: shell palette followed the attribute`,
    expected === 'dark' ? live.token === '#18181b' : live.token === '#f1f1f2',
    `--cc-page ${live.token}, --cc-ink ${live.ink}, color-scheme ${live.colorScheme}`,
  );

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  -> ${file}`);

  // ---- The other half: the NEXT open, before the iframe exists -------------
  // postMessage only corrects the shell once computercaller.com has answered.
  // Without the chrome.storage.local cache every open would show the OS theme
  // for those hundreds of milliseconds — the same mismatched ring, just brief.
  // So reopen with the app origin BLOCKED: nothing can tell the shell anything,
  // and it must still paint the user's choice. That is the cache, isolated.
  await page.route(`${ORIGIN}/**`, (r) => r.abort());
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await page.waitForTimeout(1500);
  const cold = await page.evaluate(MEASURE);
  check(
    `${name}: next open paints from cache with the app unreachable`,
    cold.attr === expected,
    `got ${cold.attr}`,
  );

  // This is the frame that ACTUALLY SHOWS the bug. #cc-frame is width/height
  // 100%, so once the app has painted it covers the shell entirely and the two
  // themes can only be compared as numbers. What Dennis saw was the shell ALONE
  // — the pre-paint background and the band Chrome paints from `color-scheme` —
  // and that is this capture, with the app deliberately unreachable.
  const coldFile = path.join(OUT, `${name}-shell-only.png`);
  await page.screenshot({ path: coldFile });
  console.log(`  -> ${coldFile}`);

  await ctx.close();
  reaper.reapAndReport(`ext-shell-theme-proof:${name}`);
  fs.rmSync(profile, { recursive: true, force: true });
}

server.close();
fs.rmSync(EXT, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
