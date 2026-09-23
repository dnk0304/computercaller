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

/**
 * EXT-UI-8 (2c). AC-1's width budget is about a LONG DEVICE NAME, and the pill
 * only renders one when the pair is ACTIVE — ConnectionStatus refuses to paint
 * a name in any other state ("the name would be a placeholder lie"). Before
 * this frame the harness measured an idle pill, i.e. the one state in which the
 * assertion has nothing to assert. 24 characters, which is the length the
 * dispatch names, and long enough that it MUST truncate at both widths.
 */
const DEVICE_NAME = 'Samsung Galaxy S24 Ultra'; // 24 chars

const FRAMES = [
  ['LOBBY_STATUS', { phonePresent: true }],
  ['PAIRING_ACTIVE', { deviceName: DEVICE_NAME }],
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

  // ---- EXT-UI-8 (1) the dial action row ----------------------------------
  // Read off the live DOM in DOM ORDER, which is the point: the brief forbids
  // flex-row-reverse and order:, so DOM order and paint order must agree, and
  // the only way to prove that is to check both.
  const actions = root.querySelector('.cc-dialpad-actions');
  if (actions) {
    const btns = [...actions.querySelectorAll(':scope > button')];
    out.rowOrder = btns.map((b) => b.getAttribute('aria-label'));
    out.rowLeftToRight = [...btns]
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((b) => b.getAttribute('aria-label'));
    const call = btns.find((b) => (b.getAttribute('aria-label') || '').startsWith('Call'));
    out.callW = call ? Math.round(call.getBoundingClientRect().width * 10) / 10 : null;
    // One row = every button shares a CENTRE LINE. Not a top edge: the 30px
    // backspace is centred against its 36px siblings, so its top is 3px lower
    // by design and a top-edge test reports a wrap that is not there.
    const mids = btns.map((b) => { const r = b.getBoundingClientRect(); return r.top + r.height / 2; });
    out.rowWrapped = Math.max(...mids) - Math.min(...mids) > 1;
    const ar = actions.getBoundingClientRect();
    out.rowOverflows = actions.scrollWidth > actions.clientWidth + 1
      || btns.some((b) => {
        const r = b.getBoundingClientRect();
        return r.left < ar.left - 1 || r.right > ar.right + 1;
      });
  }

  // ---- EXT-UI-8 (2b/2c) the header band ----------------------------------
  out.headerSend = !!document.querySelector('[data-cc-ft-action="header-send"]');
  out.headerSendBox = (() => {
    const b = document.querySelector('[data-cc-ft-action="header-send"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  })();
  const hdr = root.querySelector('.cc-ext-header');
  out.headerOverflows = hdr ? hdr.scrollWidth > hdr.clientWidth + 1 : null;
  out.headerWrapped = (() => {
    if (!hdr) return null;
    // Centre lines again, and against the BAND's own centre: the row mixes an
    // 18px mark, a 24px button and a 26px button, all centred, so their top
    // edges legitimately differ. A wrap is a child whose centre has left the
    // band's centre — which is what this measures.
    const kids = [...hdr.children].filter((k) => k.getBoundingClientRect().width > 0);
    if (kids.length < 2) return false;
    const mids = kids.map((k) => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; });
    return Math.max(...mids) - Math.min(...mids) > 1;
  })();

  // CAPACITY, measured rather than assumed. The pill is the ONLY truncating
  // item in the row (extension.css AC-1), so every pixel the new button costs
  // comes out of it. A 24-char device name is written into the live span, the
  // real computed font is fed to a canvas, and the longest prefix that still
  // fits beside the ellipsis is counted. The text is put back immediately —
  // React owns it and would restore it on the next render anyway, but a proof
  // that leaves the page different from the page it measured is not a proof.
  // The pill budget, measured as a function so the SAME code can run twice:
  // once with the row as it ships, and once with the EXT-UI-8 button lifted
  // out of it. Two numbers from one layout is the only honest way to say what
  // the new control actually costs — a base build measured on another day
  // compares two renders, not two rows.
  const measurePill = () => {
    const conn = root.querySelector('.cc-ext-conn');
    if (!conn) return null;
    const pill = conn.querySelector('[role="status"]');
    if (!pill) return null;

    // The name span exists only while a device is ACTIVE (ConnectionStatus:
    // "the name would be a placeholder lie" in every other state), and the
    // stub relay in this harness does not send DEVICE_INFO. So the span is
    // synthesised with the component's own classes when it is absent, which
    // measures the real budget in the real row instead of skipping the check
    // whenever the pill happens to be idle. Removed again immediately.
    const NAME = 'Samsung Galaxy S24 Ultra'; // 24 chars — matches DEVICE_NAME
    let span = pill.querySelector('.truncate');
    let temp = false;
    let prev = null;
    if (span) {
      prev = span.textContent;
    } else {
      span = document.createElement('span');
      span.className = 'min-w-0 truncate font-semibold text-slate-800';
      pill.insertBefore(span, pill.children[1] || null);
      temp = true;
    }
    span.textContent = NAME;
    const avail = span.clientWidth;
    const cs2 = getComputedStyle(span);
    const font = cs2.fontStyle + ' ' + cs2.fontWeight + ' ' + cs2.fontSize + ' ' + cs2.fontFamily;
    const ctx2 = document.createElement('canvas').getContext('2d');
    ctx2.font = font;
    const ell = ctx2.measureText('…').width;
    const full = ctx2.measureText(NAME).width;
    let chars = NAME.length;
    if (full > avail) {
      chars = 0;
      for (let i = 1; i <= NAME.length; i++) {
        if (ctx2.measureText(NAME.slice(0, i)).width + ell <= avail) chars = i; else break;
      }
    }
    const connW = Math.round(conn.clientWidth * 10) / 10;
    const pillW = Math.round(pill.getBoundingClientRect().width * 10) / 10;
    if (temp) span.remove(); else span.textContent = prev;
    return {
      name: NAME.length,
      avail: Math.round(avail * 10) / 10,
      chars,
      truncated: full > avail,
      connW,
      pillW,
      synthesised: temp,
    };
  };
  out.pill = measurePill();
  // A/B. Remove the button, re-measure, put it back. If the two name-slot
  // widths are equal the control costs the pill nothing — which is the actual
  // AC-1 question, and it is answerable without a second build.
  out.pillNoSend = (() => {
    const btn = document.querySelector('[data-cc-ft-action="header-send"]');
    if (!btn) return null;
    const parent = btn.parentNode;
    const next = btn.nextSibling;
    parent.removeChild(btn);
    const m2 = measurePill();
    parent.insertBefore(btn, next);
    return m2;
  })();

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


      // ---- EXT-UI-8 (1) the dial row, at all six combinations -------------
      const ORDER = [
        'Delete last digit',
        'Call',
        'Send a message to this number',
        // Label flips with state; the toggle is closed on a fresh panel.
        'Show keypad',
      ];
      check(
        `${size} @${width}px: dial row DOM order is backspace · Call · SMS · keypad`,
        JSON.stringify(m.rowOrder) === JSON.stringify(ORDER),
        JSON.stringify(m.rowOrder),
      );
      check(
        `${size} @${width}px: painted order equals DOM order (no reverse/order:)`,
        JSON.stringify(m.rowLeftToRight) === JSON.stringify(m.rowOrder),
        JSON.stringify(m.rowLeftToRight),
      );
      check(`${size} @${width}px: dial row is ONE row, no wrap`, m.rowWrapped === false);
      check(`${size} @${width}px: dial row does not overflow`, m.rowOverflows === false);
      check(
        `${size} @${width}px: Call is at least 120px wide`,
        m.callW !== null && m.callW >= 120,
        `${m.callW}px`,
      );

      // ---- EXT-UI-8 (2b/2c) the header ------------------------------------
      check(`${size} @${width}px: the header carries the Send file button`, m.headerSend === true);
      check(
        `${size} @${width}px: Send file is a 24px box`,
        !!m.headerSendBox && Math.abs(m.headerSendBox.w - 24) <= 1 && Math.abs(m.headerSendBox.h - 24) <= 1,
        JSON.stringify(m.headerSendBox),
      );
      check(`${size} @${width}px: header does not wrap`, m.headerWrapped === false);
      check(`${size} @${width}px: header does not overflow`, m.headerOverflows === false);
      // WHAT THIS ASSERTS — REWRITTEN BY T-EXT-TEXTS-OVERFLOW.
      //
      // The block that stood here asserted that the Send file button costs the
      // device name ZERO pixels, and its stated reason was that "the pill stops
      // at its OWN max-w-[210px] ... there are 35-75px of slack ahead of it".
      // That premise died twice over:
      //   1. EXT-UI-4 M7 released the 210px cap inside this panel on purpose.
      //   2. What actually made the delta zero at the time this ran was the
      //      DEFECT: `.cc-ext-header .cc-ext-conn { min-width: auto }` froze the
      //      slot at the pill's max-content (314px at 360 AND at 400), so the
      //      pill was not sharing the row's width with anything and removing a
      //      24px button changed nothing. The assertion passed BECAUSE the
      //      header overflowed by 21px. A green arm sitting on top of a red one
      //      is worse than no arm.
      //
      // The honest rule, now that the name is genuinely the row's elastic item,
      // is the dispatch's original capacity rule: a control in this row costs
      // the name EXACTLY its own box plus one gap, and never more. Measured at
      // the fix: 142 -> 113px at 400 and 103 -> 73px at 360, i.e. 29-30px for a
      // 24px button in a 6px-gap row, identical at every size. The ceiling is
      // stated as the button box + one gap + 2px of rounding, so a control that
      // quietly starts costing the name a second control's worth goes red.
      const sendCost = (m.pill && m.pillNoSend) ? m.pillNoSend.avail - m.pill.avail : null;
      check(
        `${size} @${width}px: the Send file button costs the name its own box and no more`,
        sendCost !== null && sendCost > 0 && sendCost <= 24 + 6 + 2,
        m.pill && m.pillNoSend
          ? `${m.pill.avail}px / ${m.pill.chars} chars with, ${m.pillNoSend.avail}px / ${m.pillNoSend.chars} chars without = ${Math.round(sendCost * 10) / 10}px`
          : 'not measured',
      );
      // T-EXT-TEXTS-OVERFLOW (3). The 8-visible-character floor, asserted for
      // the first time. It was missed at EVERY combination before the fix —
      // not because 8 characters do not fit, but because the name never
      // truncated at all and the panel overflowed instead. With the deficit
      // reaching the name it truncates properly and keeps 16 chars at 400 and
      // 9 at 360, at all three sizes (the pill's type is pinned at 11.5px, so
      // the picker does not move this number). Never lower this floor: a lane
      // that cannot keep 8 characters of a device name has taken the row's
      // width for something else.
      check(
        `${size} @${width}px: the device name keeps at least 8 visible characters`,
        !!m.pill && m.pill.chars >= 8,
        m.pill ? `${m.pill.chars} chars in ${m.pill.avail}px${m.pill.truncated ? ' (truncated)' : ' (fits whole)'}` : 'pill not found',
      );
      check(
        `${size} @${width}px: the pill fits inside its slot, never past it`,
        !!m.pill && m.pill.connW >= m.pill.pillW,
        m.pill ? `${m.pill.chars} chars in ${m.pill.avail}px name-slot (conn slot ${m.pill.connW}px, pill ${m.pill.pillW}px)${m.pill.truncated ? " truncated" : " fits whole"}${m.pill.synthesised ? " [name span synthesised: idle pill]" : ""}` : 'pill not found',
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
  // A2) EXT-UI-8 item 3 — the focus box on a text field.
  //
  //   Dennis 2026-09-22 12:49Z: "when i click to dial number a square marking
  //   that field comes up ... This should not be visible, neither dark nor
  //   light mode."
  //
  // Both halves are asserted, because only asserting the first would let
  // someone "fix" this by deleting the focus cue outright:
  //   pointer  -> computed outline-style 'none' AND no box-shadow
  //   keyboard -> a cue EXISTS (outline or box-shadow)
  //
  // Real Playwright gestures, not dispatched events: `mouse.click` produces a
  // trusted pointerdown, and `keyboard.press('Tab')` a trusted keydown, which
  // is exactly what components/ExtPointerFocus.tsx listens for. A synthetic
  // `new PointerEvent(...)` would pass this test and ship the bug.
  // =========================================================================
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage();
    await page.addInitScript(bootScript({ size: 'medium', theme }));
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`${BASE}/extension`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await settle(page);

    /**
     * "No ring", tolerant of a shadow that is present in the computed style but
     * paints nothing: fully transparent, or every length rounded to zero.
     */
    const noRing = (shadow) => {
      if (!shadow || shadow === 'none') return true;
      const alpha = /rgba\([^)]*,\s*0\s*\)/.test(shadow);
      const lengths = (shadow.match(/-?[\d.e-]+px/g) || []).map(parseFloat);
      return alpha || (lengths.length > 0 && lengths.every((n) => Math.abs(n) < 0.01));
    };

    /** Computed focus paint on whatever is focused right now. */
    const focusPaint = () => page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: null };
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        flagged: el.getAttribute('data-cc-pointer-focus'),
      };
    });

    // --- AUTOFOCUS: the dial field takes the caret on every panel open, with
    // no gesture behind it. That is the state the panel spends most of its life
    // in, and nothing should be lit up because of it.
    {
      const a = await focusPaint();
      check(
        `${theme}: the autofocused number field paints no cue on open`,
        a.tag === 'input' && (a.outlineStyle === 'none' || parseFloat(a.outlineWidth) === 0) && noRing(a.boxShadow),
        `${a.tag}#${a.id}: outline ${a.outlineStyle} ${a.outlineWidth}, shadow ${a.boxShadow}`,
      );
    }

    const fields = [
      ['number field', 'input[placeholder="Enter Number"]'],
      ['Texts search', 'input[aria-label="Search messages"]'],
    ];

    for (const [what, sel] of fields) {
      if (what === 'Texts search') {
        await page.getByRole('tab', { name: /texts/i }).click();
        await page.waitForTimeout(500);
      }
      const box = await page.locator(sel).first().boundingBox();
      if (!box) { check(`${theme}: ${what} is on screen`, false, sel); continue; }

      // --- POINTER: click straight into the field. No box.
      // The number input carries Tailwind `transition-all`, so box-shadow is an
      // ANIMATED property on it: read 150ms after the click and the computed
      // value is a shadow mid-fade — `rgba(37,99,235,0) 0 -1.7e-9px` — which is
      // invisible on screen but is not the string 'none'. Settle first, and
      // treat a zero-alpha / zero-length shadow as the absence it looks like.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);
      const p1 = await focusPaint();
      check(
        `${theme}: ${what} — pointer click paints NO outline`,
        p1.outlineStyle === 'none' || parseFloat(p1.outlineWidth) === 0,
        `outline ${p1.outlineStyle} ${p1.outlineWidth}`,
      );
      check(
        `${theme}: ${what} — pointer click paints NO ring`,
        noRing(p1.boxShadow),
        p1.boxShadow,
      );
      check(
        `${theme}: ${what} — the pointer-focus flag is set`,
        p1.flagged === '1',
        String(p1.flagged),
      );
      await page.screenshot({
        path: path.join(SHOTS, `ext-ui8-focus-pointer-${what.split(' ')[0].toLowerCase()}-${theme}-360.png`),
      });

      // --- KEYBOARD: typing after that click must bring the cue BACK.
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(600);
      const p2 = await focusPaint();
      const hasCue = (p2.outlineStyle !== 'none' && parseFloat(p2.outlineWidth) > 0)
        || !noRing(p2.boxShadow);
      check(
        `${theme}: ${what} — a key press restores a visible focus cue`,
        !!hasCue,
        `outline ${p2.outlineStyle} ${p2.outlineWidth}, shadow ${p2.boxShadow}`,
      );
      check(
        `${theme}: ${what} — and the cue is NOT the button rectangle`,
        p2.outlineStyle === 'none' || parseFloat(p2.outlineWidth) === 0,
        `outline ${p2.outlineStyle} ${p2.outlineWidth}`,
      );
      await page.screenshot({
        path: path.join(SHOTS, `ext-ui8-focus-keyboard-${what.split(' ')[0].toLowerCase()}-${theme}-360.png`),
      });
    }

    // --- TAB ARRIVAL: a keyboard user must see the cue the moment focus lands,
    // not after they start typing. Shift+Tab back onto the number field from
    // the control after it.
    await page.getByRole('tab', { name: /dial/i }).click();
    await page.waitForTimeout(400);
    await page.locator('input[placeholder="Enter Number"]').first().click();
    await page.waitForTimeout(200);
    let arrived = null;
    for (let i = 0; i < 12 && !arrived; i++) {
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(120);
      const f = await focusPaint();
      if (f.tag === 'input' || f.tag === 'textarea') arrived = f;
    }
    if (!arrived) {
      for (let i = 0; i < 12 && !arrived; i++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(120);
        const f = await focusPaint();
        if (f.tag === 'input' || f.tag === 'textarea') arrived = f;
      }
    }
    await page.waitForTimeout(600);
    const arrivedNow = arrived ? await focusPaint() : null;
    check(
      `${theme}: a field reached by Tab shows its cue ON ARRIVAL`,
      !!arrivedNow && !noRing(arrivedNow.boxShadow) && arrivedNow.flagged !== '1',
      arrivedNow ? `${arrivedNow.tag}#${arrivedNow.id} shadow ${arrivedNow.boxShadow}, flag ${arrivedNow.flagged}`
        : 'no field reached by Tab',
    );

    // A button, same page, same gesture: the brand ring is UNTOUCHED. This is
    // the regression guard on "fixed it by deleting the focus ring".
    await page.getByRole('tab', { name: /dial/i }).click();
    await page.waitForTimeout(400);
    // Walk there with real Tab presses. `el.focus()` would work today, but it
    // leans on Chromium's "last input was a keyboard" carry-over, and a proof
    // that depends on a heuristic is a proof that will lie one Chrome ago.
    let btn = null;
    for (let i = 0; i < 40 && !btn; i++) {
      await page.keyboard.press('Tab');
      btn = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !el.closest || !el.closest('.cc-dialpad-actions')) return null;
        if (el.tagName.toLowerCase() !== 'button') return null;
        const cs = getComputedStyle(el);
        return {
          label: el.getAttribute('aria-label'),
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
        };
      });
    }
    check(
      `${theme}: a dial-row BUTTON still takes the brand focus ring`,
      !!btn && btn.outlineStyle !== 'none' && parseFloat(btn.outlineWidth) > 0,
      btn ? `${btn.label}: outline ${btn.outlineStyle} ${btn.outlineWidth}` : 'no dial-row button reached by Tab',
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

  // UI-HEADER (ratified R-BO, 2026-09-21) made the wordmark ONE word everywhere
  // — manifest name + default_title included. This assertion still demanded the
  // two-word spelling and so failed on a value the product is now REQUIRED to
  // have; it was the only failure in this harness's first run on 8cb6f82. It
  // was missed because this harness is in no gate phase (tools/lib/harness-list.mjs
  // lists it nowhere), so nothing re-ran it when the wordmark changed.
  check(
    'manifest name is the product name, one word (PIXEL-S2 (d), re-pinned by UI-HEADER/R-BO)',
    mf.name === 'ComputerCaller' && mf.action.default_title === 'ComputerCaller',
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
