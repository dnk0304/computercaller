/**
 * PIXEL-S proof harness — the extension's Small / Medium / Large type picker.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. Be precise; a proof that quietly tests
 * its own stub is worse than no proof.
 *
 *   REAL  /extension out of THIS branch's production build, served by the
 *         repo's own server.js. PhoneProvider, PhoneModeShell, the account
 *         menu, app/extension/extension.css and the blocking boot scripts are
 *         all the shipped code. Every font size below is read as COMPUTED px
 *         off the live DOM — never off a class name, so a token the picker
 *         failed to reach shows up as a number, not as a passing assertion.
 *   REAL  chrome-extension/{shell.css,shell.js,popup.html,manifest.json},
 *         loaded UNMODIFIED as an actual unpacked MV3 extension for part C.
 *         Only the webapp ORIGIN is repointed, at the network boundary.
 *   STUB  two things, both at the network boundary and neither of them UI:
 *         /api/auth/me and /api/auth/relay-ticket answer 200, and
 *         window.WebSocket is a fake relay that replays the bridge frames a
 *         connected phone would send. Without them there is no thread list and
 *         no notification card, and a screenshot of three empty states proves
 *         nothing about type size. Same stubs as
 *         scripts/ext-recent-history-fonts-proof.mjs.
 *
 * THE /app ASSERTION IS THE POINT OF PART D, and it is deliberately two
 * different kinds of evidence, because either alone is weak:
 *   - STATIC: every selector in the built CSS that mentions --cc-size or
 *     data-cc-size also names .cc-ext. A rule that escaped the scope is a
 *     string, and a string can be searched for exhaustively.
 *   - RUNTIME: a real non-extension page is measured with data-cc-size="large"
 *     forced onto its <html>, and every computed font size on it must be
 *     byte-identical to the same page without the attribute.
 *
 *   node server.js &                                   (PORT=3123)
 *   node scripts/ext-text-size-proof.mjs
 *
 * Env: CC_BASE_URL (default http://localhost:3123), CC_SHOTS (default
 * docs/screenshots).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

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

/** The factors, restated here ONLY so a drift between CSS and TS is caught. */
const FACTOR = { small: 1, medium: 1.2, large: 1.4 };
const SIZES = ['small', 'medium', 'large'];
const TOL = 0.02;

// ---------------------------------------------------------------------------
// The module under test is read at run time, never copied — a copy keeps
// passing after the original changes.
// ---------------------------------------------------------------------------
const sizeSrc = fs.readFileSync(path.join(REPO, 'lib/extensionTextSize.ts'), 'utf8');
const boot = sizeSrc.match(/export const SIZE_BOOT_SCRIPT = `([\s\S]*?)`;/);
check('SIZE_BOOT_SCRIPT exists in lib/extensionTextSize.ts', !!boot);
check(
  'the boot script stamps data-cc-size and posts it to the shell',
  !!boot &&
    /setAttribute\('data-cc-size'/.test(boot[1]) &&
    /postMessage\(\{source:'cc-ext',type:'size'/.test(boot[1]),
);
check(
  'medium is the declared default in the module',
  /CC_DEFAULT_SIZE: CcSize = 'medium'/.test(sizeSrc),
);
for (const s of SIZES) {
  check(
    `CC_SIZE_FACTOR.${s} agrees with the CSS (${FACTOR[s]}x)`,
    new RegExp(`${s}:\\s*${String(FACTOR[s])},`).test(sizeSrc),
  );
}

const extCss = fs.readFileSync(path.join(REPO, 'app/extension/extension.css'), 'utf8');
for (const s of SIZES) {
  check(
    `[data-cc-size=${s}] sets --cc-size: ${FACTOR[s]}`,
    new RegExp(`\\[data-cc-size=${s}\\]\\s*\\.cc-ext\\s*\\{\\s*--cc-size:\\s*${FACTOR[s]};`).test(extCss),
  );
}
check(
  'the CSS default is SMALL, not medium — /app can never grow by accident',
  /\.cc-ext \{\s*\n\s*--cc-size: 1;/.test(extCss),
);

// ---------------------------------------------------------------------------
// Stubs — identical in intent to ext-recent-history-fonts-proof.mjs.
// ---------------------------------------------------------------------------
const now = Date.now();
const MIN = 60_000;
const contacts = [
  { id: 'k1', name: 'Marta Ruiz', number: '+4745720075' },
  { id: 'k2', name: 'Ola Nordmann', number: '+4791827364' },
  { id: 'k3', name: 'Skatteetaten', number: '+4740201122' },
];
const messages = [
  { id: 'm1', address: '+4745720075', body: 'Ringte deg nettopp — ta den når du kan.', date: now - 7 * MIN, type: 'inbox', read: true },
  { id: 'm2', address: '+4791827364', body: 'Sounds good, see you at six.', date: now - 55 * MIN, type: 'inbox', read: true },
  { id: 'm3', address: '+4740201122', body: 'Your reference number is 8842-19. Keep this message for your records.', date: now - 5 * 60 * MIN, type: 'inbox', read: true },
];
const callLogs = [
  { id: 'c1', number: '+4745720075', name: 'Marta Ruiz', date: now - 8 * MIN, duration: 154, type: 'outgoing', simId: '1' },
  { id: 'c3', number: '+4791827364', name: 'Ola Nordmann', date: now - 40 * MIN, duration: 41, type: 'incoming', simId: '1' },
  { id: 'c5', number: '+4740201122', name: 'Skatteetaten', date: now - 3 * 60 * MIN, duration: 620, type: 'outgoing' },
];
const notifications = [
  { id: 'n1', appName: 'WhatsApp', packageName: 'com.whatsapp', title: 'Marta Ruiz', body: 'Ringte deg nettopp — ta den når du kan.', timestamp: now - 6 * MIN, hasReply: true, replyKey: 'r', notificationKey: 'k1' },
  { id: 'n2', appName: 'Gmail', packageName: 'com.google.android.gm', title: 'Skatteetaten', body: 'Your tax assessment for 2025 is now available in Altinn.', timestamp: now - 70 * MIN, hasReply: false, replyKey: '', notificationKey: 'k2' },
];
const simList = [{ id: 1, slot: 0, name: 'Telia', number: '+4745720075' }];

const FRAMES = [
  ['LOBBY_STATUS', { phonePresent: true }],
  ['SIM_LIST', { sims: simList, simList }],
  ['STATUS', { connected: true, battery: 82, signal: 4 }],
  ['CONTACTS', { contacts }],
  ['MESSAGES', { messages }],
  ['CALL_LOGS', { callLogs }],
  ...notifications.map((n) => ['PHONE_NOTIFICATION', n]),
];

/**
 * @param {{size?:string|null, theme?:string, email?:string}} o
 *   `size: null` means WRITE NOTHING — that is how "Medium is the default with
 *   no stored value" is tested, and it has to be an absence, not a value.
 */
const bootScript = (o) => `
(() => {
  try {
    ${o.size ? `if (!sessionStorage.getItem('cc-proof-seeded')) {
      sessionStorage.setItem('cc-proof-seeded', '1');
      localStorage.setItem('cc:size:last', ${JSON.stringify(o.size)});
      localStorage.setItem('cc:size:' + ${JSON.stringify((o.email || 'dennis@computercaller.com').toLowerCase())}, ${JSON.stringify(o.size)});
      // The ANON key too. <SizeChoice> reads per-account, and the account
      // arrives from the extension SHELL's shell-hello — which does not exist
      // on a bare page, so the component legitimately sees email=null here.
      // Seeding only the addressed key would test the harness, not the code.
      localStorage.setItem('cc:size:anon', ${JSON.stringify(o.size)});
    }` : ''}
    localStorage.setItem('cc:theme:last', ${JSON.stringify(o.theme || 'light')});
  } catch (e) {}
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/auth/me')) {
      return Promise.resolve(new Response(JSON.stringify({ user: { email: ${JSON.stringify(o.email || 'dennis@computercaller.com')} } }),
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

/**
 * Computed px for a fixed sample of the surface's type, plus the overflow
 * numbers. The sample deliberately spans FOUR different ways a size can be
 * set — inherited body type, a Tailwind utility, an explicit .cc-* rule, and
 * an <input> — because the picker had to reach all four.
 */
/**
 * The in-app notification toast is a real feature and a real nuisance for
 * evidence: a PHONE_NOTIFICATION frame floats a card over the header for a few
 * seconds, and a screenshot taken in that window shows the toast instead of
 * the thing under test. Dismissed rather than suppressed — suppressing it
 * would mean the shots were taken on a surface the user never sees.
 */
const settle = async (page) => {
  const x = page.locator('.cc-toast button').last();
  for (let i = 0; i < 4 && (await x.count()); i += 1) {
    await x.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
};

const MEASURE = `
(() => {
  const px = (el) => el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 1000) / 1000 : null;
  const root = document.querySelector('.cc-ext') || document.body;
  const active = document.querySelector('.cc-msg-view, .cc-dial-column') || root;
  const doc = document.documentElement;
  const out = {
    attr: doc.getAttribute('data-cc-size'),
    theme: doc.getAttribute('data-cc-theme'),
    body: px(root),
    tab: px(document.querySelector('[role="tab"]')),
    rowTitle: px(active.querySelector('li p.truncate')),
    rowMeta: px(active.querySelector('li p + p, li span')),
    input: px(active.querySelector('input')),
    heading: px(active.querySelector('h2')),
    panelWidth: Math.round(root.getBoundingClientRect().width),
    rootScrollW: root.scrollWidth,
    rootClientW: root.clientWidth,
    docScrollW: doc.scrollWidth,
    docClientW: doc.clientWidth,
  };
  // Every control the row offers, smallest hit box first.
  out.minControl = Math.min(...[...root.querySelectorAll('button')]
    .map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); })
    .filter((n) => n > 0));
  const cs = getComputedStyle(root);
  out.tokens = {
    ink: cs.getPropertyValue('--cc-ink').trim(),
    sec: cs.getPropertyValue('--cc-sec').trim(),
    mut: cs.getPropertyValue('--cc-mut').trim(),
    l3: cs.getPropertyValue('--cc-l3').trim(),
    l1: cs.getPropertyValue('--cc-l1').trim(),
    w1: cs.getPropertyValue('--cc-w-1').trim(),
    w3: cs.getPropertyValue('--cc-w-3').trim(),
  };
  return out;
})()
`;

// ---- contrast, computed from the tokens the page actually resolved --------
const srgb = (hex) => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c) : h.match(/../g);
  return n.map((p) => {
    const v = parseInt(p, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
};
const lum = (hex) => {
  const [r, g, b] = srgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

const browser = await chromium.launch({ headless: true });
const shotName = (stem, width) => path.join(SHOTS, `${stem}${width === 360 ? '-360' : ''}.png`);

try {
  // =========================================================================
  // A) The picker moves type by exactly 1.0 / 1.2 / 1.4, at 400 and 360 px,
  //    and nothing overflows at any of the six combinations.
  // =========================================================================
  const measured = {};
  for (const width of [400, 360]) {
    measured[width] = {};
    for (const size of SIZES) {
      const page = await browser.newPage();
      await page.addInitScript(bootScript({ size }));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await settle(page);

      const m = await page.evaluate(MEASURE);
      measured[width][size] = m;
      console.log(`  dial ${size} @${width}px  ` + JSON.stringify(m));

      check(`${size} @${width}px: <html> carries data-cc-size`, m.attr === size, `got ${m.attr}`);
      check(
        `${size} @${width}px: panel width unchanged by the picker`,
        m.panelWidth === width,
        `${m.panelWidth}px`,
      );
      check(
        `${size} @${width}px: no horizontal overflow`,
        m.rootScrollW <= m.rootClientW && m.docScrollW <= m.docClientW,
        `root ${m.rootScrollW}/${m.rootClientW}, doc ${m.docScrollW}/${m.docClientW}`,
      );
      // NOT "every control clears 24px": two on this surface are below it and
      // were before this dispatch — ConnectionStatus's 16px disconnect button
      // and the 22px avatar, both inherited, both in a panel with no touch
      // input. What this dispatch owes is that growing the type never SHRINKS
      // a target, so the assertion is monotonic against Small and the raw
      // numbers are printed either way.
      const smallBase = measured[width].small;
      check(
        `${size} @${width}px: no control is smaller than at Small`,
        !smallBase || m.minControl >= smallBase.minControl - 0.5,
        `smallest ${Math.round(m.minControl * 10) / 10}px vs ${smallBase ? smallBase.minControl : '—'}px at Small`,
      );

      await page.screenshot({ path: shotName(`ext-text-size-${size}`, width) });
      await page.close();
    }

    // The ratios, per sampled token, against Small at the SAME width.
    const small = measured[width].small;
    for (const size of ['medium', 'large']) {
      const m = measured[width][size];
      for (const key of ['body', 'tab', 'rowMeta', 'input']) {
        if (small[key] == null || m[key] == null) continue;
        const r = m[key] / small[key];
        check(
          `${size} @${width}px: ${key} is ${FACTOR[size]}x Small`,
          Math.abs(r - FACTOR[size]) <= TOL * FACTOR[size],
          `${small[key]}px → ${m[key]}px = ${Math.round(r * 1000) / 1000}x`,
        );
      }
    }
  }

  // ---- contrast, both themes, body + label (addendum (c)) -----------------
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ size: 'medium', theme }));
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const m = await page.evaluate(MEASURE);
    const t = m.tokens;
    const pairs = [
      [`body ink on a card`, t.ink, t.l3],
      [`secondary label on a card`, t.sec, t.l3],
      [`muted label on a card`, t.mut, t.l3],
      [`body ink on a band`, t.ink, t.l1],
      [`secondary label on a band`, t.sec, t.l1],
    ];
    for (const [what, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      check(`${theme}: ${what} >= 4.5:1`, r >= 4.5, `${fg} on ${bg} = ${r}:1`);
    }
    check(
      `${theme}: the weight tokens stepped up one notch`,
      t.w1 === '500' && t.w3 === '700',
      `--cc-w-1 ${t.w1}, --cc-w-3 ${t.w3}`,
    );
    await page.close();
  }

  // =========================================================================
  // B) Default, persistence, per-account isolation, and the picker itself.
  // =========================================================================
  {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ size: null }));
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(MEASURE);
    check('with NO stored value the surface is Medium', m.attr === 'medium', `got ${m.attr}`);

    // ...and Medium is really 1.2x of the Small measured above, not just a word.
    const small400 = measured[400].small;
    check(
      'that default is genuinely 1.2x Small',
      Math.abs(m.body / small400.body - 1.2) <= TOL * 1.2,
      `${small400.body}px → ${m.body}px`,
    );
    await page.close();
  }

  {
    // The picker, driven the way a user drives it: open the account menu and
    // click the segment. Nothing here touches localStorage or the attribute
    // directly — if either moves, the shipped code moved it.
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ size: 'small' }));
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    await settle(page);
    await page.getByRole('button', { name: /Account menu/ }).click();
    await page.waitForTimeout(300);
    const group = page.getByRole('group', { name: 'Text size' });
    check('the account menu carries a Text size group', (await group.count()) === 1);
    check(
      'three segments, one menuitemradio each',
      (await group.getByRole('menuitemradio').count()) === 3,
    );
    check(
      'the current size is the checked segment',
      (await group.getByRole('menuitemradio', { name: 'Small' }).getAttribute('aria-checked')) === 'true',
    );
    const seg = await group.getByRole('menuitemradio', { name: 'Medium' }).boundingBox();
    check(
      'the picker segments themselves clear 24x24',
      seg.width >= 24 && seg.height >= 24,
      `${Math.round(seg.width)}x${Math.round(seg.height)}`,
    );
    await page.screenshot({ path: path.join(SHOTS, 'ext-text-size-picker.png') });

    await group.getByRole('menuitemradio', { name: 'Large' }).click();
    await page.waitForTimeout(400);
    check(
      'clicking Large stamps the attribute',
      (await page.locator(':root').getAttribute('data-cc-size')) === 'large',
    );
    const stored = await page.evaluate(() => ({
      last: localStorage.getItem('cc:size:last'),
      // email is null on a bare page (no extension shell → no shell-hello), so
      // the account key the component writes is the anon one. Inside the real
      // popup this is `cc:size:<email>`; the per-account SHAPE is proved by
      // the isolation block below.
      account: localStorage.getItem('cc:size:anon'),
    }));
    check(
      'and writes BOTH the account key and LAST_KEY',
      stored.account === 'large' && stored.last === 'large',
      JSON.stringify(stored),
    );

    // Persistence across a reload, with nothing seeded on this pass.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    check(
      'the choice survives a reload',
      (await page.locator(':root').getAttribute('data-cc-size')) === 'large',
    );
    await page.close();
  }

  {
    // Per-account isolation. A shared browser profile is the normal case for a
    // Chrome extension; one person's Large must not follow the next person in.
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ size: 'large', email: 'a@computercaller.com' }));
    await page.setViewportSize({ width: 400, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cc:size:')));
    check(
      'the size is stored under a per-account key',
      keys.some((k) => k === 'cc:size:a@computercaller.com'),
      keys.join(', '),
    );
    const other = await page.evaluate(() => localStorage.getItem('cc:size:b@computercaller.com'));
    check('a second account has no stored size of its own', other === null, String(other));
    await page.close();
  }

  // =========================================================================
  // C) Texts as Alerts-style cards — 360 and 400, both themes, all sizes.
  // =========================================================================
  for (const theme of ['light', 'dark']) {
    for (const width of [400, 360]) {
      for (const size of SIZES) {
        const page = await browser.newPage();
        await page.addInitScript(bootScript({ size, theme }));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await settle(page);
        await page.getByRole('tab', { name: /Texts/ }).click();
        await page.waitForTimeout(700);

        const card = await page.evaluate(() => {
          const li = document.querySelector('.cc-card-list > li');
          const note = document.querySelector('.cc-note-card');
          const cs = li ? getComputedStyle(li) : null;
          const root = document.querySelector('.cc-ext');
          return {
            hasCardList: !!document.querySelector('ul.cc-card-list'),
            radius: cs && cs.borderTopLeftRadius,
            border: cs && cs.borderTopWidth,
            bg: cs && cs.backgroundColor,
            l3: root && getComputedStyle(root).getPropertyValue('--cc-l3').trim(),
            noteRadius: note && getComputedStyle(note).borderTopLeftRadius,
            noteBorder: note && getComputedStyle(note).borderTopWidth,
            scrollW: root.scrollWidth,
            clientW: root.clientWidth,
          };
        });

        check(
          `texts ${size} ${theme} @${width}px: thread rows are L3 cards`,
          card.hasCardList && card.border === '1px' && parseFloat(card.radius) >= 12,
          `radius ${card.radius}, border ${card.border}, bg ${card.bg}`,
        );
        check(
          `texts ${size} ${theme} @${width}px: no horizontal overflow`,
          card.scrollW <= card.clientW,
          `${card.scrollW}/${card.clientW}`,
        );
        if (size === 'medium' && width === 400) {
          // The one assertion that ties the two tabs together: same radius, same
          // hairline. If Alerts is restyled and Texts is not, this fails.
          const alerts = await (async () => {
            await page.getByRole('tab', { name: /Alerts/ }).click();
            await page.waitForTimeout(600);
            return page.evaluate(() => {
              const n = document.querySelector('.cc-note-card');
              if (!n) return null;
              const cs = getComputedStyle(n);
              return { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth };
            });
          })();
          check(
            `texts cards match the Alerts cards (${theme})`,
            !!alerts && alerts.radius === card.radius && alerts.border === card.border,
            `texts ${card.radius}/${card.border} vs alerts ${alerts && alerts.radius}/${alerts && alerts.border}`,
          );
          await page.getByRole('tab', { name: /Texts/ }).click();
          await page.waitForTimeout(500);
        }

        await page.screenshot({
          path: path.join(SHOTS, `ext-text-size-texts-${size}-${theme}-${width}.png`),
        });
        await page.close();
      }
    }
  }

  // =========================================================================
  // D) /app is untouched — statically and at run time.
  // =========================================================================
  {
    const cssFiles = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.css')) cssFiles.push(f);
      }
    };
    const staticDir = path.join(REPO, '.next', 'static');
    if (fs.existsSync(staticDir)) walk(staticDir);
    check('found the built stylesheets to scan', cssFiles.length > 0, `${cssFiles.length} files`);

    const escapees = [];
    for (const f of cssFiles) {
      const css = fs.readFileSync(f, 'utf8');
      // Split on rule boundaries and look at the selector of every rule that
      // mentions the size machinery at all.
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, sel, body] = m;
        if (!/--cc-size|data-cc-size/.test(sel + body)) continue;
        if (/\.cc-ext/.test(sel)) continue;
        escapees.push(`${path.basename(f)}: ${sel.trim().slice(0, 90)}`);
      }
    }
    check(
      'no built rule touches --cc-size outside .cc-ext',
      escapees.length === 0,
      escapees.slice(0, 4).join(' | '),
    );
  }

  {
    // Runtime half: a real, public, NON-extension page, measured with and
    // without the attribute forced on. Every computed size must be identical.
    const readAll = `
      (() => [...document.querySelectorAll('body *')]
        .slice(0, 400)
        .map((el) => getComputedStyle(el).fontSize + '/' + getComputedStyle(el).fontWeight)
        .join('|'))()
    `;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(readAll);
    await page.evaluate(() => document.documentElement.setAttribute('data-cc-size', 'large'));
    await page.waitForTimeout(400);
    const after = await page.evaluate(readAll);
    check(
      'a non-extension page is byte-identical with data-cc-size=large forced on',
      before === after && before.length > 0,
      `${before.split('|').length} elements sampled`,
    );
    check(
      'that page renders no .cc-ext at all',
      (await page.locator('.cc-ext').count()) === 0,
    );
    await page.close();
  }
} finally {
  await browser.close();
}

// =========================================================================
// E) THE SHELL. chrome-extension/{shell.css,shell.js} loaded as a real
//    unpacked MV3 extension, byte-identical, origin repointed at a local
//    stand-in. Two things are proved: the inbound `size` message stamps the
//    shell's own <html>, and the NEXT open paints from chrome.storage.local
//    with the app origin unreachable — the cache, isolated.
// =========================================================================
{
  const BOOT = boot ? boot[1] : '';
  const IFRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script>${BOOT}</script>
<style>html,body{margin:0;height:100%;font:12.5px system-ui}
.cc-ext{height:100%;display:grid;place-items:center;color:#8a8a8a}</style>
</head><body><div class="cc-ext">[app surface — stubbed, see header]</div></body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/api/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ user: { email: 'dennis@computercaller.com' } }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(IFRAME_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;

  const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-size-'));
  fs.cpSync(path.join(REPO, 'chrome-extension'), EXT, { recursive: true });
  const cfg = path.join(EXT, 'config.js');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replaceAll('https://computercaller.com', ORIGIN));
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  mf.host_permissions = [`${ORIGIN}/*`];
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));

  check(
    'manifest name is the product name in normal case (PIXEL-S2 (d))',
    mf.name === 'Computer Caller' && mf.action.default_title === 'Computer Caller',
    `${mf.name} / ${mf.action.default_title}`,
  );
  for (const f of ['shell.css', 'shell.js']) {
    check(
      `${f} is shipped byte-for-byte in the proof`,
      fs.readFileSync(path.join(EXT, f)).equals(fs.readFileSync(path.join(REPO, 'chrome-extension', f))),
    );
  }

  const EXT_ID = crypto
    .createHash('sha256')
    .update(Buffer.from(mf.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prof-size-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 600 });
    await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await page.waitForTimeout(1500);

    check(
      'the shell paints a size before anything tells it one',
      (await page.locator(':root').getAttribute('data-cc-size')) === 'medium',
    );

    // The framed page does what lib/extensionTextSize.ts does on a pick.
    await page.frameLocator('#cc-frame').locator('body').waitFor({ timeout: 10_000 });
    await page.frame({ url: (u) => u.href.startsWith(ORIGIN) }).evaluate(() => {
      localStorage.setItem('cc:size:last', 'large');
      document.documentElement.setAttribute('data-cc-size', 'large');
      window.parent.postMessage({ source: 'cc-ext', type: 'size', size: 'large' }, '*');
    });
    await page.waitForTimeout(600);
    check(
      'the shell follows the pick over postMessage',
      (await page.locator(':root').getAttribute('data-cc-size')) === 'large',
    );
    const shellType = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontSize,
      factor: getComputedStyle(document.documentElement).getPropertyValue('--cc-size').trim(),
    }));
    check(
      'and shell.css actually scaled off it',
      shellType.factor === '1.4' && Math.abs(parseFloat(shellType.body) - 12.5 * 1.4) < 0.3,
      `--cc-size ${shellType.factor}, body ${shellType.body}`,
    );
    await page.screenshot({ path: path.join(SHOTS, 'ext-text-size-shell-large.png') });

    // Next open, app unreachable: the chrome.storage.local cache alone.
    await page.route(`${ORIGIN}/**`, (r) => r.abort());
    await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await page.waitForTimeout(1500);
    check(
      'next open paints the stored size with the app unreachable',
      (await page.locator(':root').getAttribute('data-cc-size')) === 'large',
    );
    await page.screenshot({ path: path.join(SHOTS, 'ext-text-size-shell-cold.png') });
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(EXT, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (screenshots: ${SHOTS})`);
process.exit(failed.length ? 1 : 0);
