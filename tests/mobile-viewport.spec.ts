/**
 * Mobile viewport regression gate.
 *
 * Why this file exists: /app has two UIs (Phone Mode below the threshold, the
 * full dashboard above it) and until 2026-08-10 the band between them rendered
 * the desktop layout clipped inside an `overflow-x-auto` pane.
 *
 * The subtle part: `document.documentElement.scrollWidth <= window.innerWidth`
 * PASSES on that broken layout, because the overflow is trapped in an inner
 * scroller rather than escaping to the document. A document-level check alone
 * is a false green. So we assert two things:
 *
 *   1. the document itself never scrolls horizontally, and
 *   2. at phone widths (where Phone Mode owns the screen and nothing is meant
 *      to scroll sideways) no element's right edge escapes the viewport.
 *
 * Auth: these specs need a signed-in session. Set E2E_EMAIL / E2E_PASSWORD to
 * run them; without credentials they skip rather than fail, so the default
 * suite stays green on a machine with no seeded account.
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

/** Widths a phone browser actually reports, plus the old dead-zone band. */
const PHONE_WIDTHS = [320, 360, 390, 414, 430];
const BAND_WIDTHS = [600, 700, 844, 920, 1000, 1100];

/** Elements allowed to sit outside the viewport by design. */
const OFFSCREEN_ALLOWED = ['[data-offscreen-ok]', '[aria-hidden="true"]'];

async function signIn(page: Page, baseURL: string) {
  const res = await page.request.post(`${baseURL}/api/auth/login`, {
    headers: { 'Content-Type': 'application/json', Origin: baseURL },
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(res.status(), 'login should succeed').toBe(200);
}

/** Widest right-edge among visible elements, and who owns it. */
async function widestOverhang(page: Page, allowed: string[]) {
  return page.evaluate((allowedSel) => {
    const iw = window.innerWidth;
    let worst = { right: 0, sel: '' };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (allowedSel.some((s) => el.matches(s) || el.closest(s))) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right > worst.right) {
        worst = {
          right: Math.round(r.right),
          sel: `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ').slice(0, 3).join('.')}`,
        };
      }
    }
    return { ...worst, innerWidth: iw };
  }, allowed);
}

test.describe('/app renders within the viewport on mobile', () => {
  test.skip(!EMAIL || !PASSWORD, 'set E2E_EMAIL and E2E_PASSWORD to run mobile viewport specs');

  for (const width of [...PHONE_WIDTHS, ...BAND_WIDTHS]) {
    test(`no horizontal document scroll at ${width}px`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: width <= 500 ? 844 : 900 });
      await signIn(page, baseURL!);
      await page.goto('/app');
      await page.waitForLoadState('networkidle');

      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        doc.scrollWidth,
        `document scrolls horizontally at ${width}px`,
      ).toBeLessThanOrEqual(doc.innerWidth + 1);
    });
  }

  // Deliberately spans the band as well as phone widths. The phone widths alone
  // would NOT have caught the 2026-08-10 regression: Phone Mode already fitted
  // below 430px, and the desktop layout's overflow above it was swallowed by an
  // `overflow-x-auto` pane so the document never scrolled. The band widths are
  // the ones that actually fail on the old layout (e.g. content reaching 1170px
  // inside a 700px viewport).
  for (const width of [...PHONE_WIDTHS, ...BAND_WIDTHS]) {
    test(`nothing is clipped off-screen at ${width}px`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: width <= 500 ? 844 : 900 });
      await signIn(page, baseURL!);
      await page.goto('/app');
      await page.waitForLoadState('networkidle');

      const worst = await widestOverhang(page, OFFSCREEN_ALLOWED);
      expect(
        worst.right,
        `${worst.sel} extends to ${worst.right}px in a ${width}px viewport`,
      ).toBeLessThanOrEqual(worst.innerWidth + 1);
    });
  }

  test('phone widths get Phone Mode, laptop widths do not', async ({ page, baseURL }) => {
    await signIn(page, baseURL!);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('button', { name: /expand to full dashboard/i }),
      'Phone Mode should own a 390px viewport',
    ).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('button', { name: /expand to full dashboard/i }),
      'a 1280px laptop must never be pushed into Phone Mode',
    ).toHaveCount(0);
  });

  test('every Phone Mode input is at least 16px so iOS does not zoom on focus', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, baseURL!);
    await page.goto('/app');
    await page.waitForLoadState('networkidle');

    const tooSmall = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, select'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          return parseFloat(getComputedStyle(el).fontSize) < 16;
        })
        .map((el) => `${el.tagName.toLowerCase()}#${el.id || '(no id)'} @ ${getComputedStyle(el).fontSize}`),
    );
    expect(tooSmall, 'inputs below 16px make iOS Safari zoom the page on focus').toEqual([]);
  });
});
