/**
 * PIXEL-S3 proof harness — the Dial view's collapsible keypad.
 *
 * Dennis 2026-09-17 14:46 (verbatim): "I would like to hide the numbers pad in
 * dial tab. I would like it to be reduced into a button thats next to the
 * message button thats next to the call button. If user clicks on it, it then
 * expands and the numbers for dialing appear, click again, hides it."
 *
 * WHAT IS REAL, AND WHAT IS NOT — a proof that tests its own stub is worse
 * than no proof:
 *   REAL  /extension and /app out of THIS branch's build, served by the repo's
 *         own server. PhoneModeShell, Dialpad, CollapsePanel, lib/dialpadPref
 *         and app/extension/extension.css are all the shipped code. Every
 *         assertion below is read off the LIVE DOM — key VISIBILITY comes from
 *         Playwright's own visibility model, which respects the
 *         `visibility: hidden` CollapsePanel sets, so a pad that is merely
 *         clipped (and therefore still focusable, still in the a11y tree)
 *         would FAIL here rather than quietly pass.
 *   REAL  the /app session. /app is cookie-gated by proxy.ts and this harness
 *         passes that gate the way a logged-in user does, by minting with the
 *         app's own signers — same approach as app-in-call-shots.mjs.
 *   STUB  three things, all at the network/socket boundary and none of them
 *         UI: /api/auth/me, /api/auth/relay-ticket and /api/entitlement answer
 *         200, and window.WebSocket is a fake relay. The fake relay RECORDS
 *         what the page sends it, which is how "Enter dials with the pad
 *         hidden" is proved: the assertion is a real MAKE_CALL frame carrying
 *         the typed number, not a spy on a React handler.
 *
 *   PORT=3123 bun run dev          (or node server.js)
 *   node scripts/dialpad-toggle-proof.mjs
 *
 * Env: CC_BASE_URL (default http://localhost:3123), CC_SHOTS (default
 * docs/screenshots), CC_SHOT_EMAIL.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
);
const BASE = process.env.CC_BASE_URL || 'http://localhost:3123';
const SHOTS = process.env.CC_SHOTS || path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
// A) The preference module, read at run time — never copied. A copy keeps
//    passing after the original changes.
// ---------------------------------------------------------------------------
const prefSrc = fs.readFileSync(path.join(REPO, 'lib/dialpadPref.ts'), 'utf8');
check(
  'lib/dialpadPref.ts keys per account, same shape as lib/extensionTheme.ts',
  /`cc:dialpad:\$\{email\.toLowerCase\(\)\}`/.test(prefSrc) &&
    /const LAST_KEY = 'cc:dialpad:last'/.test(prefSrc),
);
// Structural, not a count: every `window.localStorage` in the module must sit
// inside a try block. Counting accesses would have to be re-tuned every time a
// line is added, which is how a guard quietly stops guarding.
{
  const lines = prefSrc.split(String.fromCharCode(10));
  const unguarded = [];
  let depth = 0;
  for (const line of lines) {
    if (/(^|\s)try\s*\{/.test(line)) depth += 1;
    if (depth > 0 && /^\s*\} catch/.test(line)) depth -= 1;
    if (/window\.localStorage/.test(line) && depth === 0) unguarded.push(line.trim());
  }
  const total = (prefSrc.match(/window\.localStorage/g) || []).length;
  check('every localStorage access is wrapped in try/catch', total > 0 && unguarded.length === 0,
    `${total} accesses, ${unguarded.length} unguarded${unguarded.length ? ': ' + unguarded[0] : ''}`);
}
check(
  'nothing stored anywhere resolves to COLLAPSED',
  // `[\s\S]` rather than a literal `\n`: this file is read off disk and git
  // hands it back with CRLF on Windows. A guard that passes or fails on line
  // endings is not guarding the thing it names.
  /if \(!email\) \{[\s\S]*?\}[\s\S]*?return false;/.test(prefSrc) &&
    /const own = parse\(window\.localStorage\.getItem/.test(prefSrc),
);

// ---------------------------------------------------------------------------
// Stubs. Identical in intent to ext-text-size-proof.mjs, plus a `sent` buffer
// on the socket so an outbound MAKE_CALL is evidence rather than a guess.
// ---------------------------------------------------------------------------
const now = Date.now();
const MIN = 60_000;
const contacts = [{ id: 'k1', name: 'Marta Ruiz', number: '+4745720075' }];
const callLogs = [
  { id: 'c1', number: '+4745720075', name: 'Marta Ruiz', date: now - 8 * MIN, duration: 154, type: 'outgoing', simId: '1' },
  { id: 'c2', number: '+4791827364', name: 'Ola Nordmann', date: now - 40 * MIN, duration: 41, type: 'incoming', simId: '1' },
  { id: 'c3', number: '+4740201122', name: 'Skatteetaten', date: now - 3 * 60 * MIN, duration: 620, type: 'outgoing' },
];
const simList = [{ id: 1, slot: 0, name: 'Telia', number: '+4745720075' }];
const FRAMES = [
  ['LOBBY_STATUS', { phonePresent: true }],
  ['PAIRING_ACTIVE', { deviceName: 'Pixel 8' }],
  ['SIM_LIST', { sims: simList, simList }],
  ['STATUS', { connected: true, battery: 82, signal: 4 }],
  ['CONTACTS', { contacts }],
  ['MESSAGES', { messages: [] }],
  ['CALL_LOGS', { callLogs }],
];

/**
 * @param {{open?:'open'|'closed'|null, size?:string, theme?:string, email?:string}} o
 *   `open: null` means WRITE NOTHING — that is how "collapsed is the default
 *   with no stored value" is tested, and it has to be an ABSENCE, not a value.
 *   Seeding is guarded on a sessionStorage flag so a RELOAD inside the same
 *   context does not re-seed, which is what makes the persistence check real:
 *   the value the second load reads is the one the UI itself wrote.
 */
const bootScript = (o) => `
(() => {
  const EMAIL = ${JSON.stringify((o.email || 'dennis@computercaller.com').toLowerCase())};
  try {
    ${o.open ? `if (!sessionStorage.getItem('cc-s3-seeded')) {
      sessionStorage.setItem('cc-s3-seeded', '1');
      localStorage.setItem('cc:dialpad:last', ${JSON.stringify(o.open)});
      localStorage.setItem('cc:dialpad:' + EMAIL, ${JSON.stringify(o.open)});
      localStorage.setItem('cc:dialpad:anon', ${JSON.stringify(o.open)});
    }` : `if (!sessionStorage.getItem('cc-s3-seeded')) {
      sessionStorage.setItem('cc-s3-seeded', '1');
      localStorage.removeItem('cc:dialpad:last');
      localStorage.removeItem('cc:dialpad:' + EMAIL);
      localStorage.removeItem('cc:dialpad:anon');
    }`}
    localStorage.setItem('cc:theme:last', ${JSON.stringify(o.theme || 'light')});
    localStorage.setItem('cc:theme:' + EMAIL, ${JSON.stringify(o.theme || 'light')});
    localStorage.setItem('cc:theme:anon', ${JSON.stringify(o.theme || 'light')});
    ${o.size ? `localStorage.setItem('cc:size:last', ${JSON.stringify(o.size)});
    localStorage.setItem('cc:size:' + EMAIL, ${JSON.stringify(o.size)});
    localStorage.setItem('cc:size:anon', ${JSON.stringify(o.size)});` : ''}
  } catch (e) {}

  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(JSON.stringify({ user: { email: EMAIL } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/auth/relay-ticket')) {
      return Promise.resolve(new Response(JSON.stringify({ ticket: 'stub-ticket' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/entitlement')) {
      return Promise.resolve(new Response(JSON.stringify({
        tier: 'pro', unlimited: true, active: true,
        limits: { templates: 50, quickReplies: 5, syncRangeMax: '1y', contactSync: true },
        usage: { templates: 0, quickReplies: 0 },
        upgrade: { reason: null, cta: null, targetTier: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };

  // sessionStorage, not a window global: the persistence check reloads the
  // page, and a global would be wiped by the navigation exactly when we need
  // to read what the PREVIOUS load sent.
  const record = (data) => {
    try {
      const a = JSON.parse(sessionStorage.getItem('cc-s3-sent') || '[]');
      a.push(String(data));
      sessionStorage.setItem('cc-s3-sent', JSON.stringify(a));
    } catch (e) {}
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
    send(data) { record(data); }
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason: 'stub' }); }
    addEventListener(ev, fn) { this['on' + ev] = fn; }
    removeEventListener(ev) { this['on' + ev] = null; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
})();
`;

/**
 * The PHONE_NOTIFICATION toast is a real feature and a real nuisance for
 * evidence. Dismissed rather than suppressed — suppressing it would mean the
 * shots were taken on a surface the user never sees.
 */
const settle = async (page) => {
  const x = page.locator('.cc-toast button').last();
  for (let i = 0; i < 4 && (await x.count()); i += 1) {
    await x.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
};

// ---- the vocabulary of the thing under test -------------------------------
const toggle = (page) => page.getByRole('button', { name: /^(Show|Hide) keypad$/ });
/** The 12 keys, scoped to the collapse panel itself — the extension pad's keys
 *  carry no aria-label and /app's do, so the panel is the only thing both have
 *  in common, and scoping here also means a stray button elsewhere on the Dial
 *  view can never be counted as a keypad key. */
const keys = (page) => page.locator('#cc-ext-keypad button, #cc-app-keypad button');
/** Keys that are genuinely PERCEIVABLE — Playwright's visibility model, so
 *  `visibility: hidden` counts as hidden. A clipped-but-visible pad fails. */
const visibleKeys = async (page) => {
  const all = await keys(page).all();
  let n = 0;
  for (const k of all) if (await k.isVisible()) n += 1;
  return n;
};
const pressed = (page) => toggle(page).getAttribute('aria-pressed');
/** The document must never scroll sideways. Read off the live layout. */
const overflow = (page) =>
  page.evaluate(() => {
    const d = document.documentElement;
    const root = document.querySelector('.cc-ext') || document.body;
    return {
      doc: d.scrollWidth - d.clientWidth,
      root: root.scrollWidth - root.clientWidth,
      size: d.getAttribute('data-cc-size'),
    };
  });
const sentFrames = (page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('cc-s3-sent') || '[]'));
const shot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot ${name}  ${fs.statSync(file).size} B`);
  return file;
};

/**
 * Type a number on the KEYBOARD with the pad hidden, backspace one digit off,
 * then Enter — and prove the wire saw the call. This is AC-3 of the brief and
 * the single most important assertion in the file: collapsing the pad must not
 * cost anyone the ability to dial.
 */
async function keyboardDials(page, label) {
  const field = page.locator('input[type="text"], input[inputmode="tel"]').first();
  await field.click();
  await field.fill('');
  await page.keyboard.type('4512345678');
  await page.keyboard.press('Backspace');
  const typed = await field.inputValue();
  check(`${label}: keyboard typing reaches the number field with the pad hidden`,
    typed === '451234567', `field = "${typed}"`);
  check(`${label}: Backspace removed exactly one digit`, typed.length === 9, `len ${typed.length}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const frames = await sentFrames(page);
  const call = frames.filter((f) => f.startsWith('MAKE_CALL:'));
  check(`${label}: Enter dialled with the pad hidden (real MAKE_CALL on the wire)`,
    call.length >= 1 && call.some((f) => f.includes('451234567')),
    call.length ? call[call.length - 1].slice(0, 90) : 'no MAKE_CALL frame sent');
  check(`${label}: the 12 keys were hidden for the whole keyboard sequence`,
    (await visibleKeys(page)) === 0, `${await visibleKeys(page)} visible`);
}

const browser = await chromium.launch({ headless: true });

try {
  // =========================================================================
  // B) EXTENSION surface — /extension at the popup's own 400px.
  // =========================================================================
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: { width: 400, height: 900 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await page.addInitScript(bootScript({ open: null, theme }));
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await settle(page);

    const L = `ext ${theme}`;

    // -- default collapsed --------------------------------------------------
    check(`${L}: the keypad toggle is in the Dial action row`, (await toggle(page).count()) === 1);
    check(`${L}: DEFAULT IS COLLAPSED — 0 of 12 keys visible`,
      (await visibleKeys(page)) === 0, `${await visibleKeys(page)} visible`);
    check(`${L}: collapsed toggle reads aria-pressed=false, "Show keypad"`,
      (await pressed(page)) === 'false' &&
        (await toggle(page).getAttribute('aria-label')) === 'Show keypad',
      `${await pressed(page)} / ${await toggle(page).getAttribute('aria-label')}`);
    check(`${L}: the number field stays visible while collapsed`,
      await page.locator('.cc-dial-column input').first().isVisible());
    check(`${L}: the recent-calls list stays visible while collapsed`,
      await page.getByText('Marta Ruiz').first().isVisible());
    check(`${L}: Call is still the single primary in the row`,
      (await page.getByRole('button', { name: 'Call', exact: true }).count()) === 1);
    check(`${L}: every control in the action row is >= 24px`,
      await page.evaluate(() => {
        const row = document.querySelector('.cc-dialpad-actions');
        if (!row) return false;
        return [...row.querySelectorAll('button')]
          .map((b) => b.getBoundingClientRect())
          .filter((r) => r.width > 0)
          .every((r) => Math.min(r.width, r.height) >= 24);
      }));
    const o1 = await overflow(page);
    check(`${L}: no horizontal overflow collapsed @400px`, o1.doc <= 0 && o1.root <= 0, JSON.stringify(o1));
    await shot(page, `s3-ext-dial-collapsed-${theme}`);

    // -- open ---------------------------------------------------------------
    await toggle(page).click();
    await page.waitForTimeout(450);
    check(`${L}: tapping the button EXPANDS the pad — 12 of 12 keys visible`,
      (await visibleKeys(page)) === 12, `${await visibleKeys(page)} visible`);
    check(`${L}: expanded toggle reads aria-pressed=true, "Hide keypad"`,
      (await pressed(page)) === 'true' &&
        (await toggle(page).getAttribute('aria-label')) === 'Hide keypad',
      `${await pressed(page)} / ${await toggle(page).getAttribute('aria-label')}`);
    const o2 = await overflow(page);
    check(`${L}: no horizontal overflow expanded @400px`, o2.doc <= 0 && o2.root <= 0, JSON.stringify(o2));
    await shot(page, `s3-ext-dial-expanded-${theme}`);

    // -- close again --------------------------------------------------------
    await toggle(page).click();
    // 800ms, not 450: `visibility` flips only AFTER the 180ms collapse, and on
    // a loaded box the two are far enough apart that a 450ms sample caught the
    // keys still visible — then the failure detail, read a moment later,
    // reported 0 and contradicted its own assertion. Sample ONCE, after the
    // transition can no longer be in flight.
    await page.waitForTimeout(800);
    const closedKeys = await visibleKeys(page);
    const closedPressed = await pressed(page);
    check(`${L}: tapping again HIDES the pad`,
      closedKeys === 0 && closedPressed === 'false',
      `${closedKeys} visible, aria-pressed=${closedPressed}`);

    // -- persistence, across a real reload ----------------------------------
    await toggle(page).click();
    await page.waitForTimeout(450);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await settle(page);
    check(`${L}: OPEN survives a reload (per-account localStorage)`,
      (await pressed(page)) === 'true' && (await visibleKeys(page)) === 12,
      `pressed=${await pressed(page)}, ${await visibleKeys(page)} keys`);
    await toggle(page).click();
    await page.waitForTimeout(450);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await settle(page);
    check(`${L}: CLOSED survives a reload too`,
      (await pressed(page)) === 'false' && (await visibleKeys(page)) === 0,
      `pressed=${await pressed(page)}, ${await visibleKeys(page)} keys`);

    // -- keyboard still dials with the pad hidden ---------------------------
    if (theme === 'light') await keyboardDials(page, L);

    await ctx.close();
  }

  // -- 360px x Large 1.4x, both states ---------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(bootScript({ open: null, size: 'large' }));
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await settle(page);

    const a = await overflow(page);
    check('ext 360px x Large 1.4x: size token really is large', a.size === 'large', String(a.size));
    check('ext 360px x Large 1.4x: no horizontal overflow, pad CLOSED',
      a.doc <= 0 && a.root <= 0, JSON.stringify(a));
    await shot(page, 's3-ext-dial-collapsed-360-large');

    await toggle(page).click();
    await page.waitForTimeout(450);
    const b = await overflow(page);
    check('ext 360px x Large 1.4x: no horizontal overflow, pad OPEN',
      b.doc <= 0 && b.root <= 0, JSON.stringify(b));
    check('ext 360px x Large 1.4x: all 12 keys fit and are visible',
      (await visibleKeys(page)) === 12, `${await visibleKeys(page)} visible`);
    await shot(page, 's3-ext-dial-expanded-360-large');
    await ctx.close();
  }

  // =========================================================================
  // C) /app phone mode + the desktop quick-dial regression guard.
  //    /app is cookie-gated by proxy.ts; mint a REAL session the way
  //    app-in-call-shots.mjs does rather than bypassing the gate.
  // =========================================================================
  const jwt = (await import('jsonwebtoken')).default;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const user = await db.user.findFirst({
    where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
    select: { id: true, email: true, sessionVersion: true },
  });
  if (!user) throw new Error('no user to mint an /app session for');
  const secret = process.env.JWT_SECRET;
  const host = new URL(BASE).hostname;
  const cookies = [
    { name: 'auth_token', value: jwt.sign({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0, purpose: 'access' }, secret, { expiresIn: '30d' }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    { name: 'idle_token', value: jwt.sign({ userId: user.id, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 }), domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  ];

  async function appPage(width, height, opts = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      colorScheme: opts.theme || 'light',
      bypassCSP: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.addInitScript(bootScript({ open: null, email: user.email, ...opts }));
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3500);
    await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 3000 }).catch(() => {});
    await page.waitForSelector('[role="tablist"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    await settle(page);
    return { ctx, page };
  }

  // -- /app phone mode, 390x844 ---------------------------------------------
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await appPage(390, 844, { theme });
    const L = `app phone ${theme}`;

    check(`${L}: the keypad toggle is in the Dial action row`, (await toggle(page).count()) === 1);
    check(`${L}: DEFAULT IS COLLAPSED — 0 of 12 keys visible`,
      (await visibleKeys(page)) === 0, `${await visibleKeys(page)} visible`);
    check(`${L}: the number field stays visible while collapsed`,
      await page.getByLabel('Phone number to dial').isVisible());
    check(`${L}: the recent-calls list stays visible while collapsed`,
      await page.getByText('Marta Ruiz').first().isVisible());

    await toggle(page).click();
    await page.waitForTimeout(450);
    check(`${L}: tapping the button EXPANDS the pad — 12 of 12 keys visible`,
      (await visibleKeys(page)) === 12, `${await visibleKeys(page)} visible`);
    check(`${L}: expanded toggle reads aria-pressed=true, "Hide keypad"`,
      (await pressed(page)) === 'true', String(await pressed(page)));
    const ao = await overflow(page);
    check(`${L}: no horizontal overflow expanded`, ao.doc <= 0, JSON.stringify(ao));
    await shot(page, `s3-app-dial-expanded-${theme}`);

    await toggle(page).click();
    await page.waitForTimeout(450);
    check(`${L}: tapping again HIDES the pad`, (await visibleKeys(page)) === 0);
    await shot(page, `s3-app-dial-collapsed-${theme}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.waitForSelector('[role="tablist"]', { timeout: 15000 }).catch(() => {});
    await settle(page);
    check(`${L}: CLOSED survives a reload`,
      (await pressed(page)) === 'false' && (await visibleKeys(page)) === 0,
      `pressed=${await pressed(page)}`);

    if (theme === 'light') await keyboardDials(page, L);
    await ctx.close();
  }

  // -- /app phone mode at 360px ----------------------------------------------
  {
    const { ctx, page } = await appPage(360, 780);
    const a = await overflow(page);
    check('app phone 360px: no horizontal overflow, pad CLOSED', a.doc <= 0, JSON.stringify(a));
    await toggle(page).click();
    await page.waitForTimeout(450);
    const b = await overflow(page);
    check('app phone 360px: no horizontal overflow, pad OPEN', b.doc <= 0, JSON.stringify(b));
    check('app phone 360px: all 12 keys fit and are visible',
      (await visibleKeys(page)) === 12, `${await visibleKeys(page)} visible`);
    await ctx.close();
  }

  // -- /app DESKTOP quick-dial is UNTOUCHED -----------------------------------
  //    The non-compact <Dialpad /> must keep all 12 keys on screen with no
  //    toggle at all: nothing in /app passes isCompact, and the brief says
  //    the desktop quick-dial is out of scope. This is the regression guard.
  {
    const { ctx, page } = await appPage(1440, 900);
    check('app desktop 1440px: NOT in phone mode (no Dial tablist shell)',
      (await page.locator('.cc-dial-column').count()) === 0);
    // The desktop Quick Dial card has had its OWN pad toggle since long
    // before this dispatch (Dashboard.tsx, aria-label "Show dialpad" —
    // lowercase d, a different control from the Dial view's "Show keypad")
    // and its pad is collapsed by default there too. So the regression guard
    // is not "12 keys on screen"; it is that this card still behaves exactly
    // as it did: its own toggle, its own collapsed default, its own 12 keys
    // when opened, and NOTHING of S3 grafted onto it.
    const deskToggle = page.getByRole('button', { name: /^(Show|Hide) dialpad$/ });
    // Counted by what the buttons ARE — a dial glyph in a 3-column grid —
    // rather than by a Tailwind utility class, which is a build detail and
    // not a fact about the UI.
    const countVisible = () => page.evaluate(() =>
      [...document.querySelectorAll('div.grid-cols-3 > button')]
        .filter((b) => /^[0-9*#]$/.test((b.textContent || '').trim().charAt(0)))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
        }).length);
    check('app desktop quick-dial: still has its OWN pre-existing dialpad toggle',
      (await deskToggle.count()) === 1, `${await deskToggle.count()} found`);
    check('app desktop quick-dial: its pad is collapsed by default, as before',
      (await countVisible()) === 0, `${await countVisible()} keys visible`);
    await deskToggle.click();
    await page.waitForTimeout(400);
    check('app desktop quick-dial: its own toggle still reveals all 12 keys',
      (await countVisible()) === 12, `${await countVisible()} keys visible`);
    await shot(page, 's3-app-desktop-quickdial-unchanged');
    await ctx.close();
  }

  await db.$disconnect();
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL  ${r.name}  ${r.detail}`);
  process.exit(1);
}
