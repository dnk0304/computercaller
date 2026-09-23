// RULE 29 LIVE-ACCEPTANCE driver (T-LIVE-ACCEPTANCE-DRIVER).
//
// OUR bundled Playwright Chromium + the unpacked extension from the deploy
// tip worktree. Never Dennis's Chrome, never his profile, never his account.
//
// Command loop: append one JSON line to <LA_OUT>/cmd.jsonl; every op logs a
// `>> op` / `<< op OK|FAIL` pair to <LA_OUT>/res.log. Runs until {"op":"quit"}
// or --quit-timeout expires, whichever comes first — so no driver (and no
// watcher) can outlive the run (RULE 26/27).
//
// Hardening over the 20260923T1512Z session driver:
//  - sendfile sets the hidden <input type=file> directly ([data-cc-ft-input])
//    instead of racing a filechooser event, and normalises the path to forward
//    slashes so a Windows path survives JSON.
//  - the Send-file control is the real header control (SendFileControl.tsx
//    mounted in PhoneModeHeader EXT-UI-8 (b)): button[aria-label="Send file"],
//    whose data-cc-ft-action is "header-send" in that instance.
//  - threads/openthread use the extension's own list (`li` rows), not
//    [aria-label="Conversations"] which only exists in /app's Dashboard.
//  - composer is [aria-label="Message body"], send is [aria-label="Send message"].
//  - waitconnected reads the live `.cc-conn-pill` status region.
//  - EVERY op runs under a per-op timeout (default 120 s, --op-timeout), so an
//    unanswered page.evaluate / sendMessage cannot wedge the command loop.
//  - reattach: closes the persistent context and relaunches on the SAME
//    profile dir, which is how the side panel comes back after
//    chrome.runtime.reload() without waiting out the relay's 180 s soft hold.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.env.LA_ROOT || 'C:/Users/D/worktrees/computercaller/deploy9';
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright');
const EXT = process.env.LA_EXT || path.join(ROOT, 'chrome-extension');

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const QUIT_TIMEOUT_MS = Number(argOf('--quit-timeout', '3600')) * 1000;
const OP_TIMEOUT_MS = Number(argOf('--op-timeout', '120')) * 1000;

const OUT = process.env.LA_OUT;
if (!OUT) { console.error('LA_OUT is required'); process.exit(2); }
const PROF = path.join(OUT, 'profile');
const CMD = path.join(OUT, 'cmd.jsonl');
const RES = path.join(OUT, 'res.log');
const SWLOG = path.join(OUT, 'sw-console.log');
const EXT_ID_FILE = path.join(OUT, 'ext-id.txt');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(CMD)) fs.writeFileSync(CMD, '');

const red = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<email>');
const log = (m) => {
  const l = `${new Date().toISOString()} ${m}`;
  fs.appendFileSync(RES, l + '\n');
  console.log(l);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Forward slashes only: a Windows backslash path handed through JSON arrives
// as an escape sequence and the chooser silently gets nothing.
const fwd = (p) => String(p).replace(/\\/g, '/');

// The run's own hard stop. Nothing this process started may outlive it.
const quitTimer = setTimeout(() => {
  log(`QUIT-TIMEOUT after ${QUIT_TIMEOUT_MS / 1000}s — closing`);
  void shutdown(3);
}, QUIT_TIMEOUT_MS);
quitTimer.unref?.();

let ctx = null;
let page = null;
let extId = null;

async function shutdown(code) {
  clearTimeout(quitTimer);
  try { await ctx?.close(); } catch { /* already gone */ }
  log('closed');
  process.exit(code);
}

const hookSw = (w) =>
  w.on('console', (m) =>
    fs.appendFileSync(SWLOG, `${new Date().toISOString()} [${m.type()}] ${red(m.text())}\n`));
const hookPage = (p) => {
  p.on('console', (m) =>
    fs.appendFileSync(SWLOG, `${new Date().toISOString()} [page:${m.type()}] ${red(m.text())}\n`));
  p.on('close', () => log('PAGE CLOSED event'));
};

async function launch(label) {
  ctx = await chromium.launchPersistentContext(PROF, {
    headless: false,
    viewport: { width: 420, height: 760 },
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; i < 60 && !sw; i++) { await sleep(500); sw = ctx.serviceWorkers()[0]; }
  // After chrome.runtime.reload() the MV3 worker is not running when the next
  // context attaches, so waiting for it first deadlocks the reattach. The id is
  // stable for a given unpacked path + profile, so once we know it, OPENING the
  // side panel is what wakes the worker.
  // A reloaded MV3 worker is idle at the next launch, so the id may not be
  // discoverable from a running worker. It is stable for a given unpacked path
  // + profile, so remember it on disk (and accept --ext-id) and use it to open
  // the panel, which is what starts the worker.
  if (!sw && !extId) {
    extId = argOf('--ext-id', process.env.LA_EXT_ID)
      || (fs.existsSync(EXT_ID_FILE) ? fs.readFileSync(EXT_ID_FILE, 'utf8').trim() : null);
  }
  if (!sw && extId) {
    log('no SW yet — opening the panel to wake it');
    await openPanel();
    for (let i = 0; i < 40 && !sw; i++) { await sleep(500); sw = ctx.serviceWorkers()[0]; }
  }
  if (!sw) throw new Error('no service worker after launch');
  extId = new URL(sw.url()).host;
  fs.writeFileSync(EXT_ID_FILE, extId);
  hookSw(sw);
  ctx.on('serviceworker', (w) => { log('SW (re)started ' + w.url()); hookSw(w); });
  ctx.on('page', async (p) => {
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    log('new page opened: ' + p.url() + ' — adopting it');
    page = p;
    hookPage(p);
  });
  log(`${label}: ext id ${extId}`);
  if (!page || page.isClosed()) await openPanel();
}

async function openPanel() {
  page = await ctx.newPage();
  hookPage(page);
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  log('sidepanel opened');
}

// evaluate() takes an EXPRESSION string. A bare "()=>{...}" evaluates to a
// function object, which serialises as undefined — every eval in the 1512Z
// driver silently returned undefined. Invoke it.
const callable = (js) => (/^\s*(async\s*)?(\(|function)/.test(js) ? `(${js})()` : js);

const app = () => page.frameLocator('#cc-frame');
const login = () => page.frameLocator('#cc-login-frame');
const appFrame = () => page.frames().find((f) => /computercaller\.com\/extension/.test(f.url()));

const ops = {
  async signin({ email, password }) {
    const e = login().locator('#login-email');
    await e.waitFor({ state: 'visible', timeout: 60000 });
    await e.fill(email);
    await login().locator('#login-password').fill(password);
    await login().locator('button[type=submit]').click();
    log('signin submitted (typed)');
    await app().locator('body').waitFor({ timeout: 60000 });
    await sleep(4000);
    return ops.header();
  },

  async header() {
    const txt = await app().locator('body').innerText().catch((e) => 'ERR ' + e.message);
    const first = txt.split('\n').filter(Boolean).slice(0, 12).join(' | ');
    const bad = /not verified|register-fail|Re-pair needed|unverified/i.test(txt);
    log(`header/body head: ${red(first)}`);
    log(`header clean: ${!bad}`);
    return { first, bad };
  },

  async connect() {
    const b = app().getByRole('button', { name: 'Connect' });
    await b.waitFor({ timeout: 60000 });
    for (let i = 0; i < 60; i++) {
      if ((await b.getAttribute('aria-disabled')) !== 'true' && !(await b.isDisabled())) break;
      await sleep(1000);
    }
    await b.click();
    log('Connect clicked');
  },

  // The /app-only [aria-label="Connection details"] row does not exist in the
  // extension shell; the live status region is the pill.
  async waitconnected({ timeout = 90000 } = {}) {
    const s = app().locator('.cc-conn-pill').first();
    await s.waitFor({ timeout });
    for (let i = 0; i < Math.ceil(timeout / 1000); i++) {
      const t = (await s.innerText().catch(() => '')).replace(/\n/g, ' | ');
      if (/connected|active|encrypted/i.test(t)) { log('connected: ' + red(t)); return { t }; }
      await sleep(1000);
    }
    const t = (await s.innerText().catch(() => '')).replace(/\n/g, ' | ');
    throw new Error('status never reached connected — last: ' + t);
  },

  async find({ text, timeout = 60000 }) {
    await app().getByText(text, { exact: false }).first().waitFor({ timeout });
    log(`found text: ${text}`);
  },

  // Extension thread rows are plain <li>. No [aria-label="Conversations"] here.
  async threads() {
    const rows = app().locator('li');
    const n = await rows.count();
    const out = [];
    for (let i = 0; i < Math.min(n, 25); i++) {
      const t = (await rows.nth(i).innerText().catch(() => '')).replace(/\n/g, ' ').trim();
      if (t) out.push(`[${i}] ${t.slice(0, 120)}`);
    }
    log('threads(' + n + '): ' + red(out.join(' || ')).slice(0, 900));
    return { count: n };
  },

  async openthread({ text }) {
    await app().locator('li').filter({ hasText: text }).first().click();
    log('thread opened ' + text);
  },

  async sendsms({ text }) {
    const c = app().locator('[aria-label="Message body"]').first();
    await c.waitFor({ timeout: 30000 });
    await c.fill(text);
    await app().locator('[aria-label="Send message"]').first().click();
    log('sms sent: ' + text);
  },

  // Real header control (SendFileControl.tsx). Setting the hidden input
  // directly is deterministic where waitForEvent('filechooser') races the click.
  async sendfile({ file }) {
    const f = fwd(file);
    if (!fs.existsSync(f)) throw new Error('file does not exist: ' + f);
    // The header instance of SendFileControl carries data-cc-ft-action
    // "header-send" (not the "send-file" spelling in the component's other
    // branch), so key on the stable aria-label and keep both tokens.
    const btn = app().locator(
      'button[aria-label="Send file"], [data-cc-ft-action="header-send"], [data-cc-ft-action="send-file"]'
    ).first();
    await btn.waitFor({ timeout: 30000 });
    const disabled = await btn.isDisabled();
    log('Send-file control present, disabled=' + disabled);
    const input = app().locator('[data-cc-ft-input="true"]').first();
    await input.waitFor({ state: 'attached', timeout: 30000 });
    await input.setInputFiles(f);
    log('file chosen ' + f + ' (' + fs.statSync(f).size + ' bytes)');
  },

  async waitprogress({ timeout = 120000 } = {}) {
    const pb = app().locator('[role=progressbar]');
    await pb.first().waitFor({ timeout: 30000 })
      .then(() => log('progressbar visible'))
      .catch(() => log('no progressbar seen (may have completed fast)'));
    await pb.first().waitFor({ state: 'detached', timeout })
      .then(() => log('progressbar detached'))
      .catch(() => log('progressbar still present after ' + timeout + 'ms'));
    const t = await app().locator('body').innerText();
    log('after-send body has sent/complete: ' + /sent|complete|delivered/i.test(t));
  },

  async acceptfile({ timeout = 120000 } = {}) {
    const d = app().locator('[role=alertdialog]');
    await d.waitFor({ timeout });
    log('offer dialog: ' + red((await d.innerText()).replace(/\n/g, ' | ')).slice(0, 400));
    await d.getByRole('button', { name: /accept/i }).click();
    log('file offer accepted');
    const toast = app().locator('[data-cc-ft-received="true"]');
    await toast.waitFor({ timeout });
    log('File received toast: ' + red((await toast.innerText()).replace(/\n/g, ' ')));
  },

  async shot({ name }) {
    const p = path.join(OUT, name + '.png');
    await page.screenshot({ path: p });
    log('shot ' + p);
  },

  async reloadext() {
    await page.evaluate(() => chrome.runtime.reload()).catch((e) => log('reload eval: ' + e.message));
    log('chrome.runtime.reload() issued');
  },

  // A persistent profile dir takes one lock at a time, so "a NEW context on the
  // SAME profile" means close-then-relaunch. Keeps the rejoin inside the
  // relay's 180 s soft-hold window instead of waiting the driver out.
  // The repair a real user performs: chrome.runtime.reload() closes the panel,
  // and reopening it in the SAME browser is what rejoins. Use this inside the
  // relay's soft-hold window; `reattach` (whole-browser) is the heavier probe.
  async reopen() {
    for (let i = 0; i < 20; i++) {
      try { await openPanel(); return; }
      catch (e) { log('reopen retry ' + (i + 1) + ': ' + String(e.message).slice(0, 120)); await sleep(1500); }
    }
    throw new Error('panel never reopened');
  },

  async reattach() {
    const t0 = Date.now();
    try { await ctx.close(); } catch (e) { log('ctx close: ' + e.message); }
    await sleep(1500);
    await launch('reattach');
    log(`reattached in ${Date.now() - t0}ms`);
  },

  async body() {
    const t = await app().locator('body').innerText().catch((e) => 'ERR ' + e.message);
    log('body: ' + red(t.replace(/\n/g, ' | ')).slice(0, 1800));
  },

  async click({ sel, name }) {
    const l = sel ? app().locator(sel).first() : app().getByRole('button', { name }).first();
    await l.waitFor({ timeout: 30000 });
    await l.click();
    log(`clicked ${sel || name}`);
  },

  async evalapp({ js }) {
    const fr = appFrame();
    if (!fr) throw new Error('no app frame');
    const r = await fr.evaluate(callable(js));
    log('eval: ' + red(JSON.stringify(r)).slice(0, 900));
    return r;
  },

  async evalpage({ js }) {
    const r = await page.evaluate(callable(js));
    log('evalpage: ' + red(JSON.stringify(r)).slice(0, 900));
    return r;
  },

  async key({ k }) { await page.keyboard.press(k); log('key ' + k); },
  async sleep({ ms = 1000 }) { await sleep(ms); log('slept ' + ms); },
  async quit() { await shutdown(0); },
};

// Every op is raced against its own timeout. An op that hangs fails loudly and
// the loop keeps reading commands — the 1512Z driver wedged here.
async function runOp(c) {
  const limit = Number(c.timeout_s ? c.timeout_s * 1000 : OP_TIMEOUT_MS);
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`OP TIMEOUT after ${limit}ms`)), limit);
  });
  try { return await Promise.race([ops[c.op](c), guard]); }
  finally { clearTimeout(t); }
}

await launch('start');

let off = fs.readFileSync(CMD, 'utf8').length;
log(`READY (quit-timeout ${QUIT_TIMEOUT_MS / 1000}s, op-timeout ${OP_TIMEOUT_MS / 1000}s)`);
for (;;) {
  await sleep(700);
  const buf = fs.readFileSync(CMD, 'utf8');
  if (buf.length <= off) continue;
  const lines = buf.slice(off).split('\n').filter(Boolean);
  off = buf.length;
  for (const l of lines) {
    let c;
    try { c = JSON.parse(l); } catch { log('bad cmd ' + l); continue; }
    if (!ops[c.op]) { log('<< unknown op ' + c.op); continue; }
    log('>> ' + c.op);
    try { await runOp(c); log('<< ' + c.op + ' OK'); }
    catch (e) { log('<< ' + c.op + ' FAIL ' + red(e.message).split('\n')[0]); }
  }
}
