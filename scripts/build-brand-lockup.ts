/**
 * Emits the two STATIC cuts of the brand lockup from the same geometry the
 * React <CcLockup> renders:
 *
 *   public/brand/computercaller-lockup.svg  — full mark + wordmark, for any
 *       surface that can reference a URL (og:image fallbacks, docs, email).
 *   chrome-extension/lockup.svg             — mini mark + wordmark, for the
 *       extension shell header. It lives INSIDE chrome-extension/ because an
 *       MV3 page declares no content_security_policy in manifest.json, so it
 *       inherits the default `img-src 'self'` and cannot load anything from
 *       computercaller.com. It also carries its own @media
 *       (prefers-color-scheme: dark) block: the shell paints it with
 *       background-image, which puts it in a separate document that the
 *       parent's CSS cannot reach into.
 *
 * Run: bun scripts/build-brand-lockup.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAP,
  STROKE,
  WORDMARK_ASPECT,
  WORDMARK_COLORS,
  WORDMARK_D_FIRST,
  WORDMARK_D_SECOND,
  WORDMARK_W,
} from '../lib/brand/wordmark';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The mark, transcribed from components/CcMark.tsx. Kept in sync by eye —
 *  it is 12 shapes that have not moved since the mark was drawn. */
const MARK_FULL = `<defs><linearGradient id="ccm" x1="14" y1="14" x2="114" y2="114" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#35c977"/><stop offset="0.55" stop-color="#22a89a"/><stop offset="1" stop-color="#1e8fb2"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="27" fill="url(#ccm)"/><rect x="4.5" y="4.5" width="119" height="119" rx="26.5" fill="none" stroke="#ffffff" stroke-opacity="0.14"/><g fill="none" stroke="#ffffff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"><rect x="24" y="34" width="52" height="40" rx="6"/><path d="M42 82h16M50 74v8"/><rect x="84" y="40" width="26" height="48" rx="6"/><path d="M92 46h10" stroke-width="4"/><circle cx="97" cy="82.5" r="2.4" fill="#ffffff" stroke="none"/><path d="M44 60q20-18 44-6" stroke-width="5"/></g><g transform="translate(56 52)"><circle cx="9" cy="9" r="15" fill="#ffffff"/><path d="M4.4 5.1c-.5.4-.8 1-.7 1.7.3 2.2 1.4 4.3 3 5.9 1.6 1.6 3.7 2.7 5.9 3 .7.1 1.3-.2 1.7-.7l.9-1.2c.3-.5.2-1.1-.2-1.4l-2-1.4c-.4-.3-.9-.2-1.2.1l-.7.8c-1.2-.6-2.2-1.6-2.8-2.8l.8-.7c.3-.3.4-.8.1-1.2l-1.4-2c-.3-.4-.9-.5-1.4-.2z" fill="#1e8fb2"/></g>`;

const MARK_MINI = `<defs><linearGradient id="ccm" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#35c977"/><stop offset="0.55" stop-color="#22a89a"/><stop offset="1" stop-color="#1e8fb2"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="8" fill="url(#ccm)"/><path d="M11.2 8.6c-1 .8-1.5 2-1.3 3.3.5 3.9 2.5 7.5 5.3 10.3 2.8 2.8 6.4 4.8 10.3 5.3 1.3.2 2.5-.3 3.3-1.3l1.6-2.1c.6-.8.4-2-.4-2.6l-3.5-2.5c-.7-.5-1.7-.4-2.3.3l-1.3 1.4c-2.2-1.1-4-2.9-5.1-5.1l1.4-1.3c.7-.6.8-1.6.3-2.3l-2.5-3.5c-.6-.8-1.8-1-2.6-.4z" fill="#ffffff" transform="translate(3.1 3.4) scale(0.72)"/>`;

/**
 * Stacked proportions — must match CAP_RATIO.stacked / GAP_RATIO.stacked in
 * components/CcLockup.tsx, or the shell's title bar and the hosted app's
 * header (which sit 40px apart on the same surface) draw two different
 * lockups. 5.09 = 0.36 cap × the wordmark's 14.13 aspect.
 */
const WORDMARK_SCALE = 5.09;
const GAP_SCALE = 0.18;

function buildStacked(markViewBox: string, markBody: string, withDarkCut: boolean) {
  const mark = 100; // mark edge, in the lockup's own units
  const wmW = mark * WORDMARK_SCALE;
  const wmCap = wmW / WORDMARK_ASPECT;
  const gap = mark * GAP_SCALE;
  const totalH = mark + gap + wmCap;
  const markX = (wmW - mark) / 2;
  const scale = wmCap / CAP;

  const darkCss = withDarkCut
    ? `<style>@media (prefers-color-scheme: dark){.wm-a{stroke:${WORDMARK_COLORS.dark.first}}.wm-b{stroke:${WORDMARK_COLORS.dark.second}}}</style>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(wmW)} ${r(totalH)}" role="img" aria-label="ComputerCaller">${darkCss}<g transform="translate(${r(markX)} 0) scale(${r(mark / markSide(markViewBox))})">${markBody}</g><g transform="translate(0 ${r(mark + gap)}) scale(${r(scale)})" fill="none" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter"><path class="wm-a" d="${WORDMARK_D_FIRST}" stroke="${WORDMARK_COLORS.light.first}"/><path class="wm-b" d="${WORDMARK_D_SECOND}" stroke="${WORDMARK_COLORS.light.second}"/></g></svg>\n`;
}

function markSide(viewBox: string) {
  return parseFloat(viewBox.split(' ')[2]);
}

function r(n: number) {
  return Math.round(n * 100) / 100;
}

writeFileSync(
  join(ROOT, 'public/brand/computercaller-lockup.svg'),
  buildStacked('0 0 128 128', MARK_FULL, false),
);
writeFileSync(
  join(ROOT, 'chrome-extension/lockup.svg'),
  buildStacked('0 0 32 32', MARK_MINI, true),
);

console.log(`wordmark: ${WORDMARK_W} × ${CAP} (aspect ${WORDMARK_ASPECT}; source measures 14.05)`);
console.log('wrote public/brand/computercaller-lockup.svg and chrome-extension/lockup.svg');
