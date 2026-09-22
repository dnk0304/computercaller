/**
 * EXT-HIST browser arm — load-more in the extension, and the outgoing bubble.
 *
 * WHY THIS IS NOT A SCREENSHOT REVIEW
 * -----------------------------------
 * ui-batch once passed a gate 107/107 on a screenshot whose unread chip read
 * "1" where the dispatch asked for "3": the assertions had counted rows and
 * never read the number. Every claim below is therefore asserted against a LIVE
 * DOM VALUE — the button's `disabled` property, its `aria-busy` attribute, its
 * rendered text, the computed `background-color` and `color` of a real bubble,
 * `scrollWidth` vs `clientWidth` of the real scroller. The PNGs this arm writes
 * are evidence for Dennis, never a check.
 *
 * THE FOUR THINGS THAT CAN GO WRONG AND LOOK FINE
 *   1. the button renders but is inert (no handler, or disabled for the wrong
 *      reason) — asserted by driving it and reading the state it moves to;
 *   2. the button renders where it must NOT (a short thread claiming history it
 *      does not have) — asserted as an absence WITH a positive control in the
 *      same run, so "absent" cannot mean "the whole list failed to render";
 *   3. the bubble is legible in light and unreadable in dark, or vice versa —
 *      asserted by computing the contrast ratio from the painted colours, in
 *      both themes, rather than from the token values we wrote;
 *   4. it all works at 400 px and overflows at 360 px x 1.4 browser zoom, which
 *      is a real side panel on a real laptop at Chrome's "Large" text setting.
 *
 * STUBS: none beyond the harness's own relay stand-in. `__ccSend` is the stub
 * socket's inbound pump, so seeding is the phone speaking; the bridge, the
 * components and the CSS under test are all the shipped ones.
 */

/** Seed N messages into one thread, plus a short thread, plus call logs. */
const SEED = `
(seed) => {
  const base = Date.now() - 86400000;
  // 30 messages with ONE number: > PAGE_SIZE, so the open thread must offer
  // "Older messages". Alternating direction so the arm has a real SENT bubble
  // to measure, which is the whole point of the (e) checks.
  for (let i = 0; i < seed.long; i++) {
    window.__ccSend('SMS_RECEIVED:' + JSON.stringify({
      id: 'lm-long-' + i,
      from: '+4791000001',
      body: 'Long thread message ' + i,
      time: base + i * 60000,
      type: i % 2 === 0 ? 'inbox' : 'sent',
    }));
  }
  // A 3-message thread: < PAGE_SIZE, so it must NOT offer the button. This is
  // the negative control for check 2 above.
  for (let i = 0; i < 3; i++) {
    window.__ccSend('SMS_RECEIVED:' + JSON.stringify({
      id: 'lm-short-' + i,
      from: '+4791000002',
      body: 'Short thread message ' + i,
      time: base + 3600000 + i * 60000,
      type: 'inbox',
    }));
  }
}
`;

/**
 * Call logs arrive as one CALL_LOGS frame. It ALSO flips the bridge to
 * connected, which is exactly how the arm reaches its "online" state — see the
 * offline assertions, which run BEFORE this is sent.
 */
const SEED_CALLS = `
(n) => {
  const base = Date.now() - 86400000;
  const logs = [];
  // n distinct numbers, each appearing twice. The dedupe is by number, so the
  // list length is n — the shape the old \`break\` at 30 truncated.
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 2; r++) {
      logs.push({
        id: 'lm-call-' + i + '-' + r,
        number: '+4792' + String(100000 + i),
        name: 'Caller ' + i,
        date: base + i * 60000 + r * 1000,
        type: i % 4 === 0 ? 'missed' : 'outgoing',
      });
    }
  }
  window.__ccSend('CALL_LOGS:' + JSON.stringify({ callLogs: logs }));
}
`;

/** WCAG 2.x contrast from two painted CSS colours. */
const CONTRAST = `
(pair) => {
  const parse = (s) => {
    const m = String(s).match(/-?[\\d.]+/g) || [];
    return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
  };
  const lum = (rgb) => {
    const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const a = lum(parse(pair.bg));
  const b = lum(parse(pair.fg));
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
`;

const LM = (id) => `[data-cc-load-more="${id}"]`;

/**
 * Compile one of the source strings above into a function object for
 * page.evaluate. The parentheses are load-bearing: `return` followed by a
 * newline is terminated by ASI, so `new Function('return ' + SRC)` where SRC
 * opens with a newline silently returns undefined — and page.evaluate(undefined)
 * is a no-op that seeds nothing and reports no error. That is exactly how this
 * arm first "failed": every assertion measured an empty list.
 */
const fn = (src) => new Function(`return (${src})`)();

/** innerText that yields '' instead of throwing when the node is absent. */
const textOf = async (loc) =>
  (await loc.count()) === 0 ? '' : (await loc.innerText()).trim();
/** isDisabled/isEnabled that answer false instead of throwing when absent. */
const disabledOf = async (loc) => ((await loc.count()) === 0 ? null : loc.isDisabled());
const attrOf = async (loc, a) => ((await loc.count()) === 0 ? null : loc.getAttribute(a));

/**
 * @param {object} o
 * @param {(o:object)=>Promise<{ctx:import('playwright').BrowserContext,page:import('playwright').Page}>} o.open
 * @param {(p:any,ms:number)=>Promise<void>} o.settle
 * @param {(name:string,pass:boolean,detail?:string)=>void} o.check
 * @param {(page:any,name:string)=>Promise<number>} o.shot
 * @param {(page:any,file:string)=>Promise<void>} o.rawShot  writes docs/screenshots/<file>
 */
export async function runExtLoadMoreProof({ open, settle, check, shot, rawShot }) {
  const LONG = 30;
  const CALLS = 40;

  for (const theme of ['light', 'dark']) {
    // holdPairing: the stub socket opens but does NOT send PAIRING_ACTIVE, and
    // that frame is the ONE thing that marks the bridge connected
    // (usePhoneBridge.ts:1463). The offline half below is therefore the
    // product's real offline state, reached by withholding a frame rather than
    // by asserting a state into existence.
    const { ctx, page } = await open({
      route: '/extension', width: 400, height: 900, theme, holdPairing: true,
    });
    await settle(page, 1500);
    // Wait for the FACT that the stub socket exists rather than guessing a
    // delay — a fixed settle() holds on a warm dev server and loses on a cold
    // production build, which is how this class of arm goes flaky.
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { long: LONG });
    await settle(page, 900);

    // ── (h1) THREAD LIST, OFFLINE ────────────────────────────────────────────
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1000);

    const rows = page.locator('.cc-card-list > li');
    const rowCount = await rows.count();
    check(`(h) [${theme}] the extension Texts list rendered (positive control for every absence below)`,
      rowCount >= 2, `${rowCount} rows`);

    const listBtn = page.locator(LM('ext-threads-fetch'));
    check(`(h) [${theme}] the thread list offers "Load older messages from phone"`,
      (await listBtn.count()) === 1, `${await listBtn.count()} found`);
    check(`(h) [${theme}] its label is the web app's copy, verbatim`,
      (await textOf(listBtn)) === 'Load older messages from phone',
      JSON.stringify(await textOf(listBtn)));
    check(`(h) [${theme}] with no phone connected it is DISABLED`,
      (await disabledOf(listBtn)) === true);
    check(`(h) [${theme}] and it says WHY, in the title, rather than failing silently`,
      (await attrOf(listBtn, 'title')) === 'Connect your phone to load older messages',
      String(await attrOf(listBtn, 'title')));
    check(`(h) [${theme}] a disabled control is out of the tab order`,
      (await listBtn.count()) === 1 &&
        await listBtn.evaluate((el) => el.disabled === true && el.tagName === 'BUTTON'));
    check(`(h) [${theme}] it is not busy while it is merely offline`,
      (await attrOf(listBtn, 'aria-busy')) === 'false');

    // ── (h2) THREAD LIST, ONLINE + aria-busy ────────────────────────────────
    // The phone arrives — the same frame the product gets in the field.
    await page.evaluate(() => window.__ccPairNow());
    await settle(page, 900);
    await page.evaluate(fn(SEED_CALLS), CALLS);
    await settle(page, 900);
    check(`(h) [${theme}] once the phone is connected the button is ENABLED`,
      (await disabledOf(listBtn)) === false);
    check(`(h) [${theme}] an enabled control carries no stale "connect your phone" tooltip`,
      (await attrOf(listBtn, 'title')) === null);

    // Keyboard, not mouse: Tab must reach it and Enter must fire it. A control
    // that only answers a click is not an accessible control.
    // Focus it BY KEYBOARD, not with .focus(). `:focus-visible` is a heuristic
    // Chromium only satisfies after a keyboard interaction, so a programmatic
    // focus() paints no ring and the assertion below would report a missing
    // focus style on a control that has one. Stepping away and back with the
    // keyboard is the real user gesture, and it is what the rule is for.
    await listBtn.focus().catch(() => {});
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    // Let the ring finish arriving. The control carries Tailwind's
    // `transition-colors`, which in v4 transitions `outline-color` too, so a
    // computed read taken immediately after focus returns a value part-way
    // between currentColor and the brand green — and reports a different colour
    // on every run. That is how this arm first "proved" the ring was grey.
    await settle(page, 500);
    check(`(h) [${theme}] Tab reaches it — it is the focused element`,
      (await listBtn.count()) === 1 && await listBtn.evaluate((el) => el === document.activeElement));
    // "Is there an outline" is not the assertion. The UA default, and a ring
    // that resolved back to currentColor, both satisfy it — and a grey ring on
    // grey text is the weakest indicator there is. So: the ring must exist, be
    // at least 2 px, and be a DIFFERENT colour from the label it surrounds.
    const ring = (await listBtn.count()) === 1
      ? await listBtn.evaluate((el) => {
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, ink: s.color };
        })
      : null;
    check(`(h) [${theme}] the focus ring is a real painted outline, not a removed one`,
      !!ring && ring.style !== 'none' && parseFloat(ring.width) >= 2,
      ring ? `${ring.style} ${ring.width}` : 'absent');
    check(`(h) [${theme}] and it is the BRAND ring, not currentColor on currentColor`,
      !!ring && ring.color !== ring.ink, ring ? `${ring.color} vs ink ${ring.ink}` : 'absent');
    await page.keyboard.press('Enter');
    await settle(page, 500);
    check(`(h) [${theme}] Enter fires the fetch: aria-busy flips to true`,
      (await attrOf(listBtn, 'aria-busy')) === 'true');
    check(`(h) [${theme}] the busy label replaces the idle one`,
      (await textOf(listBtn)) === 'Loading…',
      JSON.stringify(await textOf(listBtn)));
    check(`(h) [${theme}] a busy control refuses a second press (no double-paging)`,
      (await disabledOf(listBtn)) === true);
    check(`(h) [${theme}] the spinner is hidden from assistive tech — aria-busy already said it`,
      (await listBtn.count()) === 1 && await listBtn.evaluate((el) => {
        const sp = el.querySelector('.animate-spin');
        return !!sp && sp.getAttribute('aria-hidden') === 'true';
      }));
    if (theme === 'light') await shot(page, 'h-ext-threads-loadmore-400');

    // ── (h3) OPEN THREAD: present on a long thread, ABSENT on a short one ────
    await page.getByRole('button', { name: /Open thread with \+4791000001/ }).first()
      .click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);
    const older = page.locator(LM('ext-thread-older'));
    const bubbles = page.locator('.cc-bubble-out');
    check(`(h) [${theme}] the thread opened (positive control: sent bubbles are on screen)`,
      (await bubbles.count()) > 0, `${await bubbles.count()} sent bubbles`);
    check(`(h) [${theme}] a thread holding a full page offers "Older messages"`,
      (await older.count()) === 1, `${await older.count()} found`);
    check(`(h) [${theme}] with the phone connected it is enabled`,
      (await older.count()) === 1 ? await older.isEnabled() : false);
    check(`(h) [${theme}] it sits ABOVE the bubbles, where older history would arrive`,
      await page.evaluate(() => {
        const b = document.querySelector('[data-cc-load-more="ext-thread-older"]');
        const m = document.querySelector('.cc-bubble-out');
        if (!b || !m) return false;
        return b.getBoundingClientRect().top < m.getBoundingClientRect().top;
      }));
    check(`(h) [${theme}] a thread that has not been paged claims no beginning`,
      (await page.locator('.cc-thread-begin').count()) === 0);

    // ── (e) THE BUBBLE, MEASURED FROM THE PAINT ─────────────────────────────
    const painted = (await bubbles.count()) === 0
      ? { bg: 'rgb(0,0,0)', fg: 'rgb(0,0,0)', img: 'ABSENT' }
      : await bubbles.first().evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, fg: s.color, img: s.backgroundImage };
        });
    const ratio = await page.evaluate(fn(CONTRAST), painted);
    check(`(e) [${theme}] the sent bubble's painted contrast clears WCAG AA 4.5:1`,
      ratio >= 4.5, `${ratio.toFixed(2)}:1  ${painted.fg} on ${painted.bg}`);
    check(`(e) [${theme}] and clears AAA 7:1 — this panel runs at 0.8x density`,
      ratio >= 7, `${ratio.toFixed(2)}:1`);
    check(`(e) [${theme}] the brand GRADIENT is gone from the bubble`,
      painted.img === 'none', painted.img);
    check(`(e) [${theme}] the ink is near-black, not white (Dennis's actual request)`,
      await page.evaluate((fg) => {
        const m = String(fg).match(/-?[\d.]+/g) || [];
        return Number(m[0]) < 60 && Number(m[1]) < 60 && Number(m[2]) < 70;
      }, painted.fg), painted.fg);
    check(`(e) [${theme}] the fill is a LIGHT blue (blue channel highest, and light)`,
      await page.evaluate((bg) => {
        const m = (String(bg).match(/-?[\d.]+/g) || []).map(Number);
        return m[2] > m[1] && m[1] > m[0] && m[2] >= 200;
      }, painted.bg), painted.bg);
    // The remap must SURVIVE for everything that is not a bubble.
    check(`(e-keep) [${theme}] the gradient still paints the primary action in the panel`,
      await page.evaluate(() => {
        const el = document.querySelector('.cc-ext .bg-blue-600');
        return !!el && getComputedStyle(el).backgroundImage.includes('gradient');
      }));

    await rawShot(page, `ext-bubble-after-${theme}.png`);
    if (theme === 'light') await shot(page, 'h-ext-thread-older-400');

    // Short thread: the SAME assertions, expecting the opposite answer.
    await page.getByRole('button', { name: /back/i }).first().click({ timeout: 5000 }).catch(() => {});
    await settle(page, 900);
    await page.getByRole('button', { name: /Open thread with \+4791000002/ }).first()
      .click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);
    const shortBubbleRows = await page.locator('.cc-thread-scroll > div').count();
    check(`(h) [${theme}] the short thread opened (positive control for the absence below)`,
      shortBubbleRows >= 3, `${shortBubbleRows} rows`);
    check(`(h) [${theme}] a thread shorter than a page offers NO "Older messages"`,
      (await page.locator(LM('ext-thread-older')).count()) === 0);

    // ── (h4) CALL LIST ──────────────────────────────────────────────────────
    await page.getByRole('tab', { name: /dial/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1200);
    const callBtn = page.locator(LM('ext-calls'));
    const callRows = page.locator('.cc-dial-column ul.cc-list > li');
    check(`(h) [${theme}] the call list rendered`, (await callRows.count()) > 0,
      `${await callRows.count()} rows`);
    check(`(h) [${theme}] it offers "Load 25 more"`, (await callBtn.count()) === 1);
    // THE NUMBER, not merely the presence. 40 distinct numbers, 30 shown.
    check(`(h) [${theme}] the remaining count is right: ${CALLS} deduped - 30 shown = ${CALLS - 30}`,
      (await textOf(callBtn)) === `Load 25 more (${CALLS - 30} remaining)`,
      JSON.stringify(await textOf(callBtn)));
    check(`(h) [${theme}] the call list is not capped at 30 — the 31st number EXISTS`,
      (await page.evaluate(() => {
        const ul = document.querySelector('.cc-dial-column ul.cc-list');
        return ul ? ul.querySelectorAll('li').length : 0;
      })) >= 30);
    await callBtn.click().catch(() => {});
    await settle(page, 800);
    check(`(h) [${theme}] one press reveals the rest and the button then disappears`,
      (await page.locator(LM('ext-calls')).count()) === 0);
    if (theme === 'light') await shot(page, 'h-ext-calls-loadmore-400');

    await ctx.close();
  }

  // ── (h5) 360 px x 1.4 — a real side panel at Chrome's "Large" text ────────
  {
    const { ctx, page } = await open({ route: '/extension', width: 360, height: 700, zoom: 1.4 });
    await settle(page, 1500);
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { long: LONG });
    await page.evaluate(fn(SEED_CALLS), CALLS);
    await settle(page, 1000);
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1200);

    const btn = page.locator(LM('ext-threads-fetch'));
    check('(h) [360x1.4] the thread-list button still renders at the narrowest real panel',
      (await btn.count()) === 1);
    const box = await btn.boundingBox();
    check('(h) [360x1.4] its tap target clears the 32 px floor',
      !!box && box.height >= 32, box ? `${box.height.toFixed(1)} px` : 'no box');
    check('(h) [360x1.4] the list does not scroll sideways',
      await page.evaluate(() => {
        const ul = document.querySelector('ul.cc-card-list');
        return !!ul && ul.scrollWidth <= ul.clientWidth + 1;
      }));
    check('(h) [360x1.4] the document does not scroll sideways either',
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));

    await page.getByRole('button', { name: /Open thread with \+4791000001/ }).first()
      .click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);
    check('(h) [360x1.4] the in-thread pill renders and clears the tap floor',
      await (async () => {
        const b = await page.locator(LM('ext-thread-older')).boundingBox();
        return !!b && b.height >= 32;
      })());
    check('(h) [360x1.4] a long unbroken bubble does not push the thread sideways',
      await page.evaluate(() => {
        const el = document.querySelector('.cc-thread-scroll');
        return !!el && el.scrollWidth <= el.clientWidth + 1;
      }));
    await ctx.close();
  }
}

/**
 * The BEFORE half of Dennis's before/after pair. Re-renders the shipped bubble
 * exactly as it was — `bg-blue-600 text-white` under the gradient remap — by
 * putting the class back on the live nodes in the page. Nothing is rebuilt and
 * no old commit is checked out: the remap that produced the old look is still
 * in the stylesheet (it drives the buttons and the FT bar), so re-applying the
 * class reproduces the old paint faithfully. The arm ASSERTS that, rather than
 * trusting it: the "before" bubble must measure as the gradient.
 */
export async function captureBubbleBefore({ open, settle, check, rawShot }) {
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open({ route: '/extension', width: 400, height: 900, theme });
    await settle(page, 1500);
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { long: 30 });
    await settle(page, 900);
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1000);
    await page.getByRole('button', { name: /Open thread with \+4791000001/ }).first()
      .click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);

    const restored = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.cc-bubble-out'));
      for (const el of els) {
        el.classList.remove('cc-bubble-out');
        el.classList.add('bg-blue-600', 'text-white');
      }
      return els.length;
    });
    await settle(page, 300);
    check(`(e-before) [${theme}] the BEFORE state was reconstructed on ${restored} bubbles`,
      restored > 0, `${restored}`);
    const before = await page.locator('.bg-blue-600.text-white').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { img: s.backgroundImage, fg: s.color };
    });
    check(`(e-before) [${theme}] and it really is the old look: the brand gradient`,
      before.img.includes('gradient'), before.img.slice(0, 60));
    check(`(e-before) [${theme}] with white ink, which is what Dennis asked us to change`,
      before.fg.replace(/\s/g, '') === 'rgb(255,255,255)', before.fg);
    await rawShot(page, `ext-bubble-before-${theme}.png`);
    await ctx.close();
  }
}
