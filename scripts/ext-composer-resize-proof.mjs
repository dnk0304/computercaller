#!/usr/bin/env node
/**
 * ext-composer-resize-proof.mjs — the composer's height, both halves of it.
 *
 * Dennis, 2026-09-23 11:06: "in the extension, when i now write a message, the
 * text field expands, i want it to expand 20% more. Or is it possible to make
 * it so user can drag to expand it and it gets saved in his settings (that i
 * remembers it)?" Niki answered: both. So this proves both.
 *
 *   A1  the derived auto-grow cap moved +20% on every term:
 *       clamp(96, h*0.4, 168)  ->  clamp(115, h*0.48, 202)
 *   A2  a drag handle on the composer's top edge whose height is remembered
 *       per account, with a keyboard equivalent and live DOM bounds
 *
 * MODELLED ON scripts/ext-text-size-proof.mjs, including its two load-bearing
 * habits: the module under test is read (and here transpiled) at RUN TIME
 * rather than copied — a copy keeps passing after the original changes — and
 * the page is stubbed at the network boundary (fetch + WebSocket) so no DB row
 * and no relay are required to render a thread.
 *
 * WHY A TRANSPILE ARM AT ALL, instead of asserting everything through the
 * page: the per-account keying cannot be exercised from a bare /extension tab.
 * The account reaches the app through the extension shell's `shell-hello`
 * postMessage, and a bare page has no shell, so the component legitimately
 * sees email=null and only ever touches the anon key. Driving the real
 * exported functions directly is the only way to test two emails that is not
 * really testing the harness.
 *
 *   PREREQ:  a PRODUCTION server on CC_BASE_URL (default http://localhost:3123):
 *              bun run build && NODE_ENV=production PORT=3123 node server.js
 *            NODE_ENV=production is not a nicety. In dev, Next's bundles eval
 *            their source maps, the app's own CSP (script-src 'self'
 *            'unsafe-inline') refuses it, React never hydrates, and the page
 *            serves as inert HTML — every click succeeds and does nothing, so
 *            a harness pointed at a dev server fails with a selector timeout
 *            and lies to you about which selector is wrong.
 *   RUN:     node scripts/ext-composer-resize-proof.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
);
const BASE = process.env.CC_BASE_URL || 'http://localhost:3123';
const SHOTS = process.env.CC_SHOTS || path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/** A FLOOR, not a target: a run that skipped arms must fail, not pass quietly. */
export const MIN_CHECKS = 58;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** The A1 formula, restated here ON PURPOSE so the harness has its own copy to
 *  disagree with the module about. A harness that imports the number it is
 *  checking proves only that a variable equals itself. */
const expectedCap = (h) => Math.max(115, Math.min(202, Math.round(h * 0.48)));
const MIN_PX = 36;

// ===========================================================================
// A) THE MODULE — transpiled from the real .ts at run time and imported.
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-composer-proof-'));
{
  const src = path.join(REPO, 'lib', 'extensionComposerHeight.ts');
  // `node <tsc's JS entry>`, not the .bin shim: spawning a .cmd without a
  // shell is EINVAL on Node >= 20 on Windows, and spawning it WITH a shell is
  // a quoting hazard for no benefit.
  execFileSync(
    process.execPath,
    [
      path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'),
      src, '--outDir', TMP,
      '--target', 'es2020', '--module', 'es2020', '--moduleResolution', 'bundler', '--skipLibCheck',
    ],
    { stdio: 'pipe' },
  );
  const mod = await import(pathToFileURL(path.join(TMP, 'extensionComposerHeight.js')).href);

  check('COMPOSER_MIN_PX is still 36 — one line, untouched by this dispatch', mod.COMPOSER_MIN_PX === MIN_PX, String(mod.COMPOSER_MIN_PX));
  check('autoCapFor(560) = 202 — the +20% ceiling in a 560px panel', mod.autoCapFor(560) === 202, String(mod.autoCapFor(560)));
  check('autoCapFor(400) = 192 — the A1 formula, neither clamp engaged', mod.autoCapFor(400) === expectedCap(400) && mod.autoCapFor(400) === 192, String(mod.autoCapFor(400)));
  check('autoCapFor(200) = 115 — the +20% FLOOR in a short pop-out', mod.autoCapFor(200) === 115, String(mod.autoCapFor(200)));
  check('autoCapFor(1400) = 202 — the ceiling holds on a tall window', mod.autoCapFor(1400) === 202, String(mod.autoCapFor(1400)));
  check('autoCapFor(NaN) falls back to the 560px panel, not to NaN', mod.autoCapFor(Number.NaN) === 202, String(mod.autoCapFor(Number.NaN)));
  check(
    'every derived cap is exactly 1.2x the 2026-09-16 cap it replaces',
    [360, 400, 560, 900].every((h) => {
      const old = Math.max(96, Math.min(168, Math.round(h * 0.4)));
      return mod.autoCapFor(h) === Math.max(115, Math.min(202, Math.round(h * 0.48))) && mod.autoCapFor(h) > old;
    }),
  );

  // A localStorage stand-in. The functions are the shipped ones; only the
  // storage under them is local, which is the only part a node process lacks.
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };

  const A = 'alice@computercaller.com';
  const B = 'bob@computercaller.com';
  mod.writeStoredHeight(A, 120);
  mod.writeStoredHeight(B, 200);
  check('per-account isolation — two emails keep two heights', mod.readStoredHeight(A) === 120 && mod.readStoredHeight(B) === 200, `${mod.readStoredHeight(A)} / ${mod.readStoredHeight(B)}`);
  check('the keys are the text-size plumbing, per email', store.has(`cc:composer:${A}`) && store.has(`cc:composer:${B}`) && store.has('cc:composer:last'), [...store.keys()].join(','));
  check('the key is case-folded, as cc:size: is', mod.readStoredHeight('ALICE@ComputerCaller.com') === 120);
  check('an unknown account reads null, not the last account\'s height', mod.readStoredHeight('nobody@computercaller.com') === null);
  check('no email at all is the anon key, not a crash', mod.readStoredHeight(null) === null);

  store.set(`cc:composer:${A}`, 'not-a-number');
  check('a non-numeric record is ignored, not coerced', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '10');
  check('a record below the 36px minimum is ignored', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '99999');
  check('an absurd record is ignored rather than filling the panel', mod.readStoredHeight(A) === null);
  store.set(`cc:composer:${A}`, '148.7');
  check('a fractional record is read as whole px', mod.readStoredHeight(A) === 148);

  mod.writeStoredHeight(A, 150);
  mod.clearStoredHeight(A);
  check('clearStoredHeight returns that account to auto', mod.readStoredHeight(A) === null && mod.readStoredHeight(B) === 200);

  check('clampHeight rounds and clamps in one place', mod.clampHeight(1e4, 36, 202) === 202 && mod.clampHeight(-5, 36, 202) === 36 && mod.clampHeight(90.6, 36, 202) === 91 && mod.clampHeight(Number.NaN, 36, 202) === 36);

  delete globalThis.window;

  // The component must go THROUGH the module. A second hardcoded 0.4 in
  // PhoneModeShell is exactly how the two would drift apart.
  const shellSrc = fs.readFileSync(path.join(REPO, 'components', 'PhoneModeShell.tsx'), 'utf8');
  const autosizeBody = shellSrc.slice(shellSrc.indexOf('function autosize('), shellSrc.indexOf('function formatHmm('));
  check('autosize() derives its cap from autoCapFor, with no second formula', /autoCapFor\(viewport\)/.test(autosizeBody) && !/0\.4\b/.test(autosizeBody) && !/\b168\b/.test(autosizeBody));
  check('the 2026-09-16 comment block survived the edit', /if the message is big\n \* i cannot see it/.test(shellSrc) || /if the message is big/.test(shellSrc));
  check('lib/extensionComposerHeight.ts ships no boot script (the composer is not first paint)', !/BOOT_SCRIPT/.test(fs.readFileSync(path.join(REPO, 'lib', 'extensionComposerHeight.ts'), 'utf8')));

  // /app, by construction rather than by promise.
  const gitOut = execFileSync('git', ['diff', '--name-only', 'origin/e2e/integration', '--', 'components/Dashboard.tsx'], { cwd: REPO, encoding: 'utf8' }).trim();
  check('components/Dashboard.tsx — /app\'s own composer — is byte-identical to base', gitOut === '', gitOut || 'unchanged');
  const css = fs.readFileSync(path.join(REPO, 'app', 'extension', 'extension.css'), 'utf8');
  const gripRules = css.split('\n').filter((l) => /cc-composer-grip/.test(l) && /^\s*[.:@]/.test(l));
  check('every composer-grip rule is scoped under .cc-ext, so /app cannot match one', gripRules.length > 0 && gripRules.every((l) => l.includes('.cc-ext')), `${gripRules.length} selectors`);
  check('--cc-grip is defined in BOTH themes', /--cc-grip:\s*#86868c/.test(css) && /--cc-grip:\s*#72727a/.test(css));
}

// ===========================================================================
// B) THE SURFACE.
// ===========================================================================
const now = Date.now();
const MIN = 60_000;
const contacts = [
  { id: 'k1', name: 'Marta Ruiz', number: '+4745720075' },
  { id: 'k2', name: 'Ola Nordmann', number: '+4791827364' },
];
const messages = [
  { id: 'm1', address: '+4745720075', body: 'Ringte deg nettopp — ta den når du kan.', date: now - 7 * MIN, type: 'inbox', read: true },
  { id: 'm2', address: '+4745720075', body: 'Og send meg adressen når du vet den.', date: now - 6 * MIN, type: 'inbox', read: true },
  { id: 'm3', address: '+4745720075', body: 'Ja, gjør det.', date: now - 5 * MIN, type: 'sent', read: true },
  { id: 'm4', address: '+4745720075', body: 'Takk!', date: now - 4 * MIN, type: 'inbox', read: true },
  { id: 'm5', address: '+4791827364', body: 'Sounds good, see you at six.', date: now - 55 * MIN, type: 'inbox', read: true },
];
const FRAMES = [
  ['LOBBY_STATUS', { phonePresent: true }],
  ['PAIRING_ACTIVE', { deviceName: 'Samsung Galaxy S24 Ultra' }],
  ['SIM_LIST', { sims: [{ id: 1, slot: 0, name: 'Telia', number: '+4745720075' }] }],
  ['STATUS', { connected: true, battery: 82, signal: 4 }],
  ['CONTACTS', { contacts }],
  ['MESSAGES', { messages }],
  ['CALL_LOGS', { callLogs: [] }],
];

/** @param {{size?:string, theme?:string, height?:number|null, email?:string}} o */
const bootScript = (o) => `
(() => {
  try {
    localStorage.setItem('cc:theme:last', ${JSON.stringify(o.theme || 'light')});
    localStorage.setItem('cc:size:last', ${JSON.stringify(o.size || 'medium')});
    localStorage.setItem('cc:size:anon', ${JSON.stringify(o.size || 'medium')});
    ${o.height != null ? `localStorage.setItem('cc:composer:anon', ${JSON.stringify(String(o.height))});` : ''}
  } catch (e) {}
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(JSON.stringify({ user: { email: 'dennis@computercaller.com' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/auth/relay-ticket')) {
      return Promise.resolve(new Response(JSON.stringify({ ticket: 'stub-ticket' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
  const FRAMES = ${JSON.stringify(FRAMES)};
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen && this.onopen({});
        let t = 40;
        for (const [type, payload] of FRAMES) {
          setTimeout(() => { this.onmessage && this.onmessage({ data: type + ':' + JSON.stringify(payload) }); }, t);
          t += 25;
        }
      }, 30);
    }
    send() {}
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason: 'stub' }); }
    addEventListener(ev, fn) { this['on' + ev] = fn; }
    removeEventListener(ev) { this['on' + ev] = null; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
})();
`;

const settle = async (page, ms = 600) => {
  const x = page.locator('.cc-toast button').last();
  for (let i = 0; i < 4 && (await x.count()); i += 1) {
    await x.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(ms);
};

/** Texts tab -> the Marta Ruiz thread -> the composer. */
const openThread = async (page) => {
  await page.getByRole('tab', { name: /texts/i }).click({ timeout: 8000 }).catch(() => {});
  await settle(page, 900);
  await page.getByRole('button', { name: /Marta Ruiz|Takk!|\+4745720075/ }).first().click({ timeout: 8000 }).catch(() => {});
  await settle(page, 900);
  await page.locator('textarea[aria-label="Message body"]').waitFor({ timeout: 15_000 });
};

const taHeight = (page) =>
  page.locator('textarea[aria-label="Message body"]').evaluate((el) => Math.round(el.getBoundingClientRect().height));
const grip = (page) => page.locator('[data-cc-composer-grip]');

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long message that has to wrap`).join('\n');

const browser = await chromium.launch({ headless: true });
try {
  // ---- B1. the A1 cap, at two panel heights -------------------------------
  for (const [panelH, wantCap] of [[560, 202], [400, expectedCap(400)]]) {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'light' }));
    await page.setViewportSize({ width: 400, height: panelH });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);

    const rest = await taHeight(page);
    check(`${panelH}px panel: an empty composer is one line`, rest === MIN_PX, `${rest}px`);

    await page.locator('textarea[aria-label="Message body"]').fill(LONG);
    await page.waitForTimeout(400);
    const grown = await taHeight(page);
    const scrolls = await page.locator('textarea[aria-label="Message body"]').evaluate((el) => el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY === 'auto');
    check(`${panelH}px panel: auto-grow caps at ${wantCap}px (was ${Math.round(wantCap / 1.2)}px)`, Math.abs(grown - wantCap) <= 1, `${grown}px`);
    check(`${panelH}px panel: past the cap it still scrolls internally (2026-09-16 fix intact)`, scrolls);
    await page.screenshot({ path: path.join(SHOTS, `ext-composer-autogrow-${panelH}.png`) });
    await page.close();
  }

  // ---- B2. the handle: pointer, persistence, keyboard, reset --------------
  {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'light' }));
    await page.setViewportSize({ width: 400, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);

    const g = grip(page);
    check('the handle exists on the extension surface', (await g.count()) === 1, `${await g.count()} found`);
    const aria = await g.evaluate((el) => ({
      role: el.getAttribute('role'),
      orient: el.getAttribute('aria-orientation'),
      label: el.getAttribute('aria-label'),
      min: el.getAttribute('aria-valuemin'),
      max: el.getAttribute('aria-valuemax'),
      now: el.getAttribute('aria-valuenow'),
      tab: el.getAttribute('tabindex'),
      touch: getComputedStyle(el).touchAction,
      cursor: getComputedStyle(el).cursor,
    }));
    check(
      'it is the ARIA separator pattern, focusable, row-resize, touch-action:none',
      aria.role === 'separator' && aria.orient === 'horizontal' && aria.label === 'Resize message box' &&
        aria.tab === '0' && aria.touch === 'none' && aria.cursor === 'row-resize',
      JSON.stringify(aria),
    );
    // NOT "> 202". The live ceiling in a 560px panel is 173 — smaller than the
    // A1 auto cap, because it is what is actually LEFT after the header, the
    // tab strip, the chip strip and three rows of conversation. That it is
    // below the auto cap is the point of measuring it. The 360px arm below
    // proves it is genuinely live by making it move with the text size.
    check('aria-valuemin is the 36px floor and aria-valuemax is a live DOM bound',
      Number(aria.min) === MIN_PX && Number(aria.max) > MIN_PX && Number(aria.max) < 560 &&
        Number(aria.max) !== 202 && Number(aria.max) !== 168,
      `${aria.min}..${aria.max}`);

    // Tab order: the message comes first. Send is DISABLED on an empty draft
    // and is therefore not a tab stop, so walk forward rather than counting
    // presses — counting was the first version and it asserted the state of
    // the Send button, which is not what this check is about.
    await page.locator('textarea[aria-label="Message body"]').focus();
    let reached = false;
    for (let i = 0; i < 4 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await g.evaluate((el) => el === document.activeElement);
    }
    const afterInDom = await page.evaluate(() => {
      const ta = document.querySelector('textarea[aria-label="Message body"]');
      const h = document.querySelector('[data-cc-composer-grip]');
      // DOCUMENT_POSITION_FOLLOWING
      return !!(ta && h) && (ta.compareDocumentPosition(h) & 4) !== 0;
    });
    check('the handle is reachable by Tab and comes AFTER the textarea in the DOM', reached && afterInDom, `tab ${reached}, dom-after ${afterInDom}`);

    // Pointer drag: the handle is on the TOP edge, so up = taller.
    const box = await g.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 6 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await taHeight(page);
    check('pointer drag of 120px sets the composer height', Math.abs(dragged - (MIN_PX + 120)) <= 4, `${dragged}px`);
    const stored = await page.evaluate(() => localStorage.getItem('cc:composer:anon'));
    check('the drag was written to storage', Math.abs(Number(stored) - dragged) <= 2, String(stored));
    check('aria-valuenow tracked the drag', Math.abs(Number(await g.getAttribute('aria-valuenow')) - dragged) <= 2);
    check('the mode flag says a user height is in force', (await g.getAttribute('data-cc-composer-mode')) === 'user');
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-dragged.png') });

    // Thread switch — the component is keyed by threadId, so this is a remount.
    await page.getByRole('button', { name: /back/i }).first().click({ timeout: 6000 }).catch(() => {});
    await settle(page, 700);
    await page.getByRole('button', { name: /Ola Nordmann|see you at six|\+4791827364/ }).first().click({ timeout: 8000 }).catch(() => {});
    await settle(page, 900);
    await page.locator('textarea[aria-label="Message body"]').waitFor({ timeout: 10_000 });
    check('the height survives a thread switch', Math.abs((await taHeight(page)) - dragged) <= 4, `${await taHeight(page)}px`);

    // Reload.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    check('the height survives a reload', Math.abs((await taHeight(page)) - dragged) <= 4, `${await taHeight(page)}px`);

    // Keyboard.
    const g2 = grip(page);
    await g2.focus();
    // From the FLOOR, not from wherever the drag left it: the restored 156px is
    // within 40px of the live 173px ceiling, so "+8 x 5" measured the clamp
    // instead of the step. Home first makes the step the only variable.
    await page.keyboard.press('Home');
    await page.waitForTimeout(250);
    const before = await taHeight(page);
    check('Home puts the box on its 36px floor before the step is measured', before === MIN_PX, `${before}px`);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    check('ArrowUp x5 is +40px (8px a step)', (await taHeight(page)) - before === 40, `${before} -> ${await taHeight(page)}`);
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(250);
    check('Shift+Arrow is the 32px step', (await taHeight(page)) - before === 72, `${await taHeight(page)}`);
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(250);
    check('Shift+Arrow is symmetric downward', (await taHeight(page)) - before === 40, `${await taHeight(page)}`);
    await page.keyboard.press('Home');
    await page.waitForTimeout(250);
    check('Home is the 36px minimum', (await taHeight(page)) === MIN_PX, `${await taHeight(page)}px`);
    check('aria-valuenow followed the keyboard to the floor', Number(await g2.getAttribute('aria-valuenow')) === MIN_PX);
    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    const atMax = await taHeight(page);
    const bound = Number(await g2.getAttribute('aria-valuemax'));
    check('End is the live maximum', Math.abs(atMax - bound) <= 2, `${atMax} vs aria-valuemax ${bound}`);

    // At the maximum the thread must still be a thread.
    const rows = await page.evaluate(() => {
      const s = document.querySelector('.cc-thread-scroll');
      if (!s) return -1;
      const r = s.getBoundingClientRect();
      return [...s.children].filter((c) => {
        const b = c.getBoundingClientRect();
        return b.height > 4 && b.bottom > r.top && b.top < r.bottom;
      }).length;
    });
    check('at maximum height at least 3 conversation rows are still visible', rows >= 3, `${rows} rows`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('and nothing overflows horizontally', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-max.png') });

    // Double-click resets to auto.
    await g2.dblclick();
    await page.waitForTimeout(400);
    check('double-click returns the box to auto', (await taHeight(page)) === MIN_PX && (await g2.getAttribute('data-cc-composer-mode')) === 'auto', `${await taHeight(page)}px`);
    check('and clears the stored height', (await page.evaluate(() => localStorage.getItem('cc:composer:anon'))) === null);
    check('with a polite announcement for someone who cannot see it happen',
      (await page.locator('[role="status"][aria-live="polite"]').last().innerText()).includes('Message box size reset'));
    await page.close();
  }

  // ---- B3. bounds hold at 360px and at every text size --------------------
  const boundsBySize = {};
for (const size of ['small', 'medium', 'large']) {
    const page = await browser.newPage();
    // 480px is deliberately ABOVE the live max at this panel height — a stored
    // value out of bounds must be re-clamped, never discarded.
    await page.addInitScript(bootScript({ theme: 'light', size, height: 480 }));
    await page.setViewportSize({ width: 360, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    const h = await taHeight(page);
    const bound = Number(await grip(page).getAttribute('aria-valuemax'));
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const rows = await page.evaluate(() => {
      const s = document.querySelector('.cc-thread-scroll');
      if (!s) return -1;
      const r = s.getBoundingClientRect();
      return [...s.children].filter((c) => { const b = c.getBoundingClientRect(); return b.height > 4 && b.bottom > r.top && b.top < r.bottom; }).length;
    });
    check(`${size} @360px: an out-of-bounds stored height is re-clamped, not discarded`, h > MIN_PX && h <= bound + 2, `${h}px, bound ${bound}`);
    check(`${size} @360px: still >=3 thread rows and no horizontal overflow`, rows >= 3 && ov <= 0, `${rows} rows, ${ov}px`);
    boundsBySize[size] = bound;
    await page.screenshot({ path: path.join(SHOTS, `ext-composer-360-${size}.png`) });
    await page.close();
  }
  check(
    'the maximum is genuinely computed, not a constant: it shrinks as the type grows',
    boundsBySize.small > boundsBySize.medium && boundsBySize.medium > boundsBySize.large,
    JSON.stringify(boundsBySize),
  );

  // ---- B4. dark theme contrast of the affordance --------------------------
  {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ theme: 'dark' }));
    await page.setViewportSize({ width: 400, height: 560 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await settle(page, 2500);
    await openThread(page);
    const seen = await page.evaluate(() => {
      const el = document.querySelector('[data-cc-composer-grip] .cc-composer-grip-pill');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
    });
    check('the dark-theme grip resolves to the 3:1 token, not to a hairline', !!seen && /114,\s*114,\s*122/.test(seen.bg), JSON.stringify(seen));
    await page.screenshot({ path: path.join(SHOTS, 'ext-composer-dark.png') });
    await page.close();
  }

  // ---- B5. /app is untouched, proved by discrimination --------------------
  {
    const measureApp = async (seed) => {
      const page = await browser.newPage();
      await page.addInitScript(`(() => { try {
        ${seed != null ? `localStorage.setItem('cc:composer:anon', '${seed}');
        localStorage.setItem('cc:composer:dennis@computercaller.com', '${seed}');` : ''}
      } catch (e) {} })();`);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const out = await page.evaluate(() => {
        const t = [...document.querySelectorAll('textarea')].filter((e) => e.offsetParent !== null);
        return {
          heights: t.map((e) => Math.round(e.getBoundingClientRect().height)),
          grips: document.querySelectorAll('[data-cc-composer-grip]').length,
          ext: document.querySelectorAll('.cc-ext').length,
        };
      });
      await page.close();
      return out;
    };
    const clean = await measureApp(null);
    const seeded = await measureApp(420);
    check('/app renders no .cc-ext and therefore no composer grip', clean.grips === 0 && clean.ext === 0, JSON.stringify(clean));
    check(
      "/app composer height is IDENTICAL with and without a stored extension height — the pref cannot reach it",
      JSON.stringify(clean.heights) === JSON.stringify(seeded.heights),
      `${JSON.stringify(clean.heights)} vs ${JSON.stringify(seeded.heights)}` +
        (clean.heights.length === 0
          ? '  [VACUOUS: /app rendered no composer for an unauthenticated harness. The /app non-regression here rests on the two checks above — Dashboard.tsx byte-identical to base, and every grip selector scoped under .cc-ext.]'
          : ''),
    );
  }
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (floor ${MIN_CHECKS}, screenshots: ${SHOTS})`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
if (results.length < MIN_CHECKS) console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
process.exit(failed.length || results.length < MIN_CHECKS ? 1 : 0);
