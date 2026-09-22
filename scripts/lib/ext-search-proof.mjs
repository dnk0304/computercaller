/**
 * EXT-SEARCH browser arm — searching message bodies, on both surfaces.
 *
 * WHY EVERY CLAIM HERE IS MEASURED, NOT LOOKED AT
 * -----------------------------------------------
 * The defect this lane fixes was invisible: the extension's search returned
 * rows, highlighted nothing, and simply never saw a message older than the
 * newest one in a thread. A screenshot of it looks exactly like a screenshot of
 * the fix. So the seed below is built so that the OLD behaviour cannot pass:
 * the message that must be found is neither the newest in its thread nor an
 * inbox message, and the only thread whose newest message matches is a decoy
 * that must NOT come first.
 *
 * FIVE THINGS THAT CAN GO WRONG AND STILL LOOK FINE
 *   1. the scan narrows again — to the preview, to inbox only, to one thread.
 *      Asserted by requiring specific message ids in the rendered results, with
 *      a positive control in the same run so "found nothing" cannot pass as
 *      "rendered nothing".
 *   2. the highlight renders but is illegible, or is the UA's default yellow in
 *      a dark panel. Asserted by computing the contrast ratio from the PAINTED
 *      colours of a real <mark>, in both themes, rather than from the token
 *      values we wrote into the stylesheet.
 *   3. clicking a hit opens the thread but lands at the bottom, which is the
 *      old behaviour wearing the new UI. Asserted by measuring the target
 *      bubble's rectangle against the scroller's — it must be IN the viewport —
 *      and by requiring the cue class on it.
 *   4. the scope line lies. It is the one sentence that tells the user an empty
 *      result may mean "not loaded yet"; its three states (online, offline,
 *      nothing older on the phone) are each reached by driving the product into
 *      them, never by asserting them into existence.
 *   5. it all works at 360 px and overflows at 360 px x 1.4 browser zoom, which
 *      is a real side panel at Chrome's "Large" text setting.
 *
 * STUBS: none beyond the harness's own relay stand-in. `__ccSend` is the stub
 * socket's inbound pump, so seeding is the phone speaking; the hook, the
 * components and the CSS under test are all the shipped ones.
 */

/**
 * The seed, built to defeat the OLD predicate.
 *
 *   thread A (+4791000001): 41 messages. The match ("parcel") is `es-old-1`,
 *     the OLDEST message in the thread AND a SENT one. Its newest message says
 *     something else entirely. A last-message scan finds nothing here; an
 *     inbox-only scan finds nothing here.
 *   thread B (+4791000002): the match IS the newest message, and it is inbox.
 *     This is the control the old code would have found, and it also pins the
 *     ordering rule (threads by newest MATCHING message, so B sorts above A).
 *   thread C (+4791000003): no match at all. It must be absent from results and
 *     present in the plain list — the positive control for every absence here.
 *   thread D (+4791000004): an accented body, for the folding assertion.
 */
const SEED = `
(seed) => {
  const base = seed.base;
  const send = (id, from, body, time, type) => window.__ccSend('SMS_RECEIVED:' + JSON.stringify({
    id, from, body, time, type,
  }));
  send('es-old-1', '+4791000001', 'I left the parcel by the back door', base + 1000, 'sent');
  // 40 fillers AFTER it, so the thread is taller than the panel. Without them
  // the whole conversation fits on screen, "scrolled to the bottom" and
  // "scrolled to the match" are the same rectangle, and the check that the
  // thread did NOT just open at the bottom could not tell the two apart.
  for (let i = 0; i < 40; i++) {
    send('es-a-' + i, '+4791000001', 'Filler message number ' + i + ' in this conversation',
      base + 2000 + i * 100, i % 2 === 0 ? 'inbox' : 'sent');
  }
  send('es-b-1',   '+4791000002', 'Morning', base + 6000, 'inbox');
  send('es-new-1', '+4791000002', 'Did the parcel arrive?', base + 7000, 'inbox');
  send('es-c-1',   '+4791000003', 'Completely unrelated conversation', base + 8000, 'inbox');
  send('es-c-2',   '+4791000003', 'Nothing to see here', base + 9000, 'sent');
  send('es-d-1',   '+4791000004', 'Ol\\u00e1, tudo bem?', base + 500, 'inbox');
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

/**
 * The "nothing older on the phone" frame. Pressing the load-more button arms
 * `globalOlderFetchInFlightRef` with the requested 500; a completion carrying
 * FEWER rows than that is how usePhoneBridge learns it has reached the start of
 * history (hooks/usePhoneBridge.ts, MESSAGES_CHUNK completion). Driving the
 * product into the state beats asserting the state into existence.
 */
const SEED_EXHAUSTED = `
() => {
  window.__ccSend('MESSAGES_CHUNK:' + JSON.stringify({
    page: 1, total_pages: 1, total_count: 1,
    messages: [{ id: 'es-tail-1', address: '+4791000001', body: 'oldest of all', date: 1, type: 'inbox' }],
  }));
}
`;

const fn = (src) => new Function(`return (${src})`)();
const LM = (id) => `[data-cc-load-more="${id}"]`;

const textOf = async (loc) =>
  (await loc.count()) === 0 ? '' : (await loc.innerText()).trim();
const attrOf = async (loc, a) => ((await loc.count()) === 0 ? null : loc.getAttribute(a));

/** Type into a search box and wait past the 150 ms debounce. */
async function type(page, locator, value, settle) {
  await locator.fill(value, { timeout: 8000 }).catch(() => {});
  await settle(page, 700);
}

/**
 * @param {object} o
 * @param {(o:object)=>Promise<{ctx:any,page:any}>} o.open
 * @param {(p:any,ms:number)=>Promise<void>} o.settle
 * @param {(name:string,pass:boolean,detail?:string)=>void} o.check
 * @param {(page:any,name:string)=>Promise<number>} o.shot
 * @param {(page:any,file:string)=>Promise<void>} o.rawShot  writes docs/screenshots/<file>
 */
export async function runExtSearchProof({ open, settle, check, shot, rawShot }) {
  const base = Date.now() - 86400000;

  // ═══ EXTENSION, both themes ═════════════════════════════════════════════
  for (const theme of ['light', 'dark']) {
    // holdPairing: PAIRING_ACTIVE is the ONE frame that marks the bridge
    // connected, so withholding it gives the arm the product's real offline
    // state rather than an asserted one.
    const { ctx, page } = await open({
      route: '/extension', width: 360, height: 900, theme, holdPairing: true,
    });
    await settle(page, 1500);
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { base });
    await settle(page, 900);
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1000);

    const search = page.getByLabel('Search messages');
    const results = page.locator('[data-cc-search-results]');
    const rows = page.locator('.cc-card-list > li');

    // ── (s1) results mode is ABSENT with an empty field ────────────────────
    check(`(s) [${theme}] the Texts list rendered (positive control for every absence below)`,
      (await rows.count()) >= 4, `${await rows.count()} rows`);
    check(`(s) [${theme}] with no query there is NO results view — today's list, unchanged`,
      (await results.count()) === 0, `${await results.count()} found`);

    // ── (s2) results mode with a query, and THE DEFECT ─────────────────────
    await type(page, search, 'parcel', settle);
    check(`(s) [${theme}] a query replaces the list with the results view`,
      (await results.count()) === 1, `${await results.count()} found`);
    check(`(s) [${theme}] the plain thread list is gone while results are shown`,
      (await rows.count()) === 0, `${await rows.count()} rows still there`);
    const hitIds = await page.locator('[data-cc-search-hit]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-cc-search-hit')));
    check(`(s) [${theme}] a SENT message matches — half of Dennis's ask`,
      hitIds.includes('es-old-1'), hitIds.join(','));
    check(`(s) [${theme}] and it is the OLDEST message in its thread, which the old predicate could never see`,
      hitIds.includes('es-old-1'));
    check(`(s) [${theme}] a RECEIVED message matches — the other half`,
      hitIds.includes('es-new-1'), hitIds.join(','));
    check(`(s) [${theme}] a non-matching conversation is absent from the results`,
      !hitIds.some((id) => String(id).startsWith('es-c-')), hitIds.join(','));
    const groups = page.locator('[data-cc-search-thread]');
    check(`(s) [${theme}] hits are GROUPED by conversation, not listed flat`,
      (await groups.count()) === 2, `${await groups.count()} groups`);
    check(`(s) [${theme}] threads are ordered by their newest MATCHING message`,
      (await attrOf(groups.first(), 'data-cc-search-thread')) === '+4791000002',
      String(await attrOf(groups.first(), 'data-cc-search-thread')));
    check(`(s) [${theme}] each group states its own match count`,
      (await textOf(page.locator('.cc-search-count').first())) === '1 match',
      JSON.stringify(await textOf(page.locator('.cc-search-count').first())));
    check(`(s) [${theme}] the count is announced to screen readers, politely`,
      (await textOf(page.locator('[data-cc-search-results] [aria-live="polite"]')))
        === '2 matches in 2 conversations',
      JSON.stringify(await textOf(page.locator('[data-cc-search-results] [aria-live="polite"]'))));

    // ── (s3) THE HIGHLIGHT, MEASURED FROM THE PAINT ────────────────────────
    const mark = page.locator('.cc-search-mark').first();
    check(`(s) [${theme}] the match is wrapped in a real <mark>`,
      (await mark.count()) === 1 && await mark.evaluate((el) => el.tagName === 'MARK'));
    check(`(s) [${theme}] and the marked text is the query, in the message's own casing`,
      (await textOf(mark)).toLowerCase() === 'parcel', JSON.stringify(await textOf(mark)));
    const painted = (await mark.count()) === 0
      ? { bg: 'rgb(0,0,0)', fg: 'rgb(0,0,0)' }
      : await mark.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, fg: s.color };
        });
    const ratio = await page.evaluate(fn(CONTRAST), painted);
    check(`(s) [${theme}] the highlight's painted contrast clears WCAG AA 4.5:1`,
      ratio >= 4.5, `${ratio.toFixed(2)}:1  ${painted.fg} on ${painted.bg}`);
    check(`(s) [${theme}] the highlight is a token, not the UA's default yellow`,
      painted.bg.replace(/\s/g, '') !== 'rgb(255,255,0)', painted.bg);
    check(`(s) [${theme}] the highlight really is painted — it differs from the unmarked ground`,
      await page.evaluate(() => {
        const m = document.querySelector('.cc-search-mark');
        const p = m && m.parentElement;
        if (!m || !p) return false;
        return getComputedStyle(m).backgroundColor !== getComputedStyle(p).backgroundColor;
      }));

    // ── (s4) SCOPE LINE + BUTTON STATES ────────────────────────────────────
    const scope = page.locator('.cc-search-scope-line');
    check(`(s) [${theme}] the scope line names the scope, in the spec's words`,
      /^Searching \d+ messages loaded on this computer\.$/.test(await textOf(scope)),
      JSON.stringify(await textOf(scope)));
    const fetchBtn = page.locator(LM('ext-search-fetch'));
    check(`(s) [${theme}] the recovery action sits under it — the EXT-HIST button, same copy`,
      (await textOf(fetchBtn)) === 'Load older messages from phone',
      JSON.stringify(await textOf(fetchBtn)));
    check(`(s) [${theme}] with no phone connected it is DISABLED`,
      (await fetchBtn.count()) === 1 && await fetchBtn.isDisabled());
    check(`(s) [${theme}] and it says WHY rather than failing silently`,
      (await attrOf(fetchBtn, 'title')) === 'Connect your phone to load older messages',
      String(await attrOf(fetchBtn, 'title')));
    check(`(s) [${theme}] it is not busy while it is merely offline`,
      (await attrOf(fetchBtn, 'aria-busy')) === 'false');

    // The phone arrives — the same frame the product gets in the field.
    await page.evaluate(() => window.__ccPairNow());
    await settle(page, 900);
    check(`(s) [${theme}] once the phone is connected the button is ENABLED`,
      (await fetchBtn.count()) === 1 && await fetchBtn.isEnabled());
    check(`(s) [${theme}] an enabled control carries no stale "connect your phone" tooltip`,
      (await attrOf(fetchBtn, 'title')) === null);
    if (theme === 'light') await rawShot(page, 'ext-search-results-light-360.png');
    if (theme === 'dark') await rawShot(page, 'ext-search-results-dark-360.png');

    // ── (s5) EMPTY RESULT — a statement, with the recovery action kept ─────
    await type(page, search, 'zzqqxx', settle);
    check(`(s) [${theme}] no match is a statement, not an empty box`,
      (await textOf(page.locator('.cc-search-empty'))) === 'No messages match',
      JSON.stringify(await textOf(page.locator('.cc-search-empty'))));
    check(`(s) [${theme}] the scope line survives the empty state`,
      (await page.locator('.cc-search-scope-line').count()) === 1);
    check(`(s) [${theme}] and so does the one control that can widen the search`,
      (await page.locator(LM('ext-search-fetch')).count()) === 1);
    if (theme === 'light') await rawShot(page, 'ext-search-empty-light-360.png');

    // ── (s6) EXHAUSTED — driven, not asserted ──────────────────────────────
    await page.locator(LM('ext-search-fetch')).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 400);
    await page.evaluate(fn(SEED_EXHAUSTED));
    await settle(page, 900);
    check(`(s) [${theme}] once the phone reports start-of-history the button is gone`,
      (await page.locator(LM('ext-search-fetch')).count()) === 0);
    check(`(s) [${theme}] and the terminal sentence replaces it, verbatim`,
      (await textOf(page.locator('.cc-search-exhausted'))) === 'That is everything on the phone.',
      JSON.stringify(await textOf(page.locator('.cc-search-exhausted'))));

    // ── (s7) FOLDING, on the real surface ──────────────────────────────────
    await type(page, search, 'ola', settle);
    check(`(s) [${theme}] an unaccented query finds an accented message ("ola" finds "Olá")`,
      (await page.locator('[data-cc-search-hit="es-d-1"]').count()) === 1);

    // ── (s8) CLICK A HIT -> THE THREAD, AT THAT MESSAGE ────────────────────
    await type(page, search, 'parcel', settle);
    await page.locator('[data-cc-search-hit="es-old-1"]').click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);
    const landed = await page.evaluate(() => {
      const scroller = document.querySelector('.cc-thread-scroll');
      const el = document.querySelector('[data-cc-msg-id="es-old-1"]');
      if (!scroller || !el) return { found: false };
      const s = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        found: true,
        inView: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
        cued: el.classList.contains('cc-bubble-hit'),
        outline: getComputedStyle(el).outlineWidth,
        atBottom: scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2,
      };
    });
    check(`(s) [${theme}] the click opened the conversation (positive control)`,
      landed.found === true);
    check(`(s) [${theme}] the clicked message is IN the viewport, not merely on the page`,
      landed.inView === true, JSON.stringify(landed));
    check(`(s) [${theme}] and the thread did NOT simply open at the bottom, which is the old behaviour`,
      landed.atBottom === false, JSON.stringify(landed));
    check(`(s) [${theme}] the landed message carries the hit cue`, landed.cued === true);
    check(`(s) [${theme}] the cue is a painted outline, not a repainted bubble fill`,
      parseFloat(landed.outline || '0') >= 2, String(landed.outline));

    await ctx.close();
  }

  // ═══ (s9) 360 px x 1.4 — a real side panel at Chrome's "Large" text ══════
  {
    const { ctx, page } = await open({ route: '/extension', width: 360, height: 700, zoom: 1.4 });
    await settle(page, 1500);
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { base });
    await settle(page, 900);
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1000);
    await type(page, page.getByLabel('Search messages'), 'parcel', settle);

    check('(s) [360x1.4] the results view renders at the narrowest real panel',
      (await page.locator('[data-cc-search-results]').count()) === 1);
    check('(s) [360x1.4] the results do not scroll sideways',
      await page.evaluate(() => {
        const el = document.querySelector('[data-cc-search-results]');
        return !!el && el.scrollWidth <= el.clientWidth + 1;
      }));
    check('(s) [360x1.4] the document does not scroll sideways either',
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    check('(s) [360x1.4] a hit line clears the 32 px tap floor',
      await (async () => {
        const b = await page.locator('[data-cc-search-hit]').first().boundingBox();
        return !!b && b.height >= 32;
      })());
    check('(s) [360x1.4] a long unbroken snippet does not push the panel sideways',
      await page.evaluate(() => {
        const el = document.querySelector('.cc-search-hits');
        return !!el && el.scrollWidth <= el.clientWidth + 1;
      }));
    await ctx.close();
  }

  // ═══ (s10) WEB PARITY — /app column 2 ════════════════════════════════════
  {
    const { ctx, page } = await open({ route: '/app', width: 1440, height: 900 });
    await settle(page, 2000);
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate(fn(SEED), { base });
    await settle(page, 1200);

    const search = page.getByLabel('Search conversations');
    check('(s) [web] the /app thread search is reachable', (await search.count()) === 1);
    check('(s) [web] with no query there is NO results view',
      (await page.locator('[data-cc-search-results]').count()) === 0);
    await type(page, search, 'parcel', settle);
    check('(s) [web] a query renders the SAME results view the extension uses',
      (await page.locator('[data-cc-search-results]').count()) === 1);
    const webIds = await page.locator('[data-cc-search-hit]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-cc-search-hit')));
    check('(s) [web] the sent, oldest-in-thread message matches here too',
      webIds.includes('es-old-1'), webIds.join(','));
    check('(s) [web] and the received one', webIds.includes('es-new-1'), webIds.join(','));
    const webMark = page.locator('.cc-search-mark').first();
    const webPainted = (await webMark.count()) === 0
      ? { bg: 'rgb(0,0,0)', fg: 'rgb(0,0,0)' }
      : await webMark.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, fg: s.color };
        });
    const webRatio = await page.evaluate(fn(CONTRAST), webPainted);
    check('(s) [web] the highlight is painted on /app too — the rule is not .cc-ext-scoped',
      webPainted.bg.replace(/\s/g, '') !== 'rgba(0,0,0,0)', webPainted.bg);
    check('(s) [web] and it clears WCAG AA 4.5:1 there',
      webRatio >= 4.5, `${webRatio.toFixed(2)}:1  ${webPainted.fg} on ${webPainted.bg}`);
    check('(s) [web] the scope line is the same sentence',
      /^Searching \d+ messages loaded on this computer\.$/.test(
        await textOf(page.locator('.cc-search-scope-line'))),
      JSON.stringify(await textOf(page.locator('.cc-search-scope-line'))));
    await rawShot(page, 'web-search-results.png');

    await page.locator('[data-cc-search-hit="es-old-1"]').click({ timeout: 6000 }).catch(() => {});
    await settle(page, 1200);
    const webLanded = await page.evaluate(() => {
      const el = document.querySelector('[data-cc-msg-id="es-old-1"]');
      if (!el) return { found: false };
      const scroller = el.closest('.overflow-y-auto');
      if (!scroller) return { found: false };
      const s = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        found: true,
        inView: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
        cued: el.classList.contains('cc-bubble-hit'),
      };
    });
    check('(s) [web] clicking a hit opens that conversation', webLanded.found === true);
    check('(s) [web] scrolled to the clicked message, in the viewport',
      webLanded.inView === true, JSON.stringify(webLanded));
    check('(s) [web] and the same hit cue is painted on it', webLanded.cued === true);
    await shot(page, 's-web-search-results');
    await ctx.close();
  }
}
