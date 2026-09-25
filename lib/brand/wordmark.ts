/**
 * The official ComputerCaller logo, as an asset manifest.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT ISN'T ANY MORE
 * ----------------------------------------------------
 * Until dispatch PIXEL-O this file held a *reconstruction* of the wordmark:
 * fourteen glyphs drawn as stroked centrelines, ~1.6KB of path data, so that
 * the name could be painted as vector anywhere. It was a good trick and it was
 * the wrong artwork. Dennis, 2026-09-16: "You have removed our official logo
 * inside the app, our official logo is not on the the extension either."
 *
 * The official logo is not something this repo gets to draw. It is the artwork
 * on the Play listing — the monitor-and-phone mark with the call arc sweeping
 * between them, over a two-tone "COMPUTER CALLER". So this file no longer
 * contains geometry for anything. It contains the *measurements* of that
 * artwork and the paths of the cuts that `scripts/build-brand-lockup.ts`
 * renders out of it. Every component here is a frame around real pixels.
 *
 * WHY RASTER
 * See the header of scripts/build-brand-lockup.ts. Short version: a faithful
 * vector would have to be hand-redrawn, hand-redrawing is exactly what was
 * just rejected, and the 3x cut is the artwork at native resolution — so
 * nothing on any screen this product runs on is ever upscaled.
 */

/** Ink-box measurements of public/brand/computercaller-icon-square.png. */
export const OFFICIAL = {
  /** The mark alone: monitor, phone, call arc, handset badge. */
  mark: { w: 393, h: 203, aspect: 393 / 203 },
  /** "COMPUTER CALLER", cap height 44. */
  wordmark: { w: 618, h: 44, aspect: 618 / 44 },
  /** Mark baseline to wordmark cap line, in the artwork's own px. */
  stackGap: 38,
} as const;

/** The stacked lockup's aspect — the official composition, 618 x 285. */
export const LOCKUP_ASPECT =
  OFFICIAL.wordmark.w / (OFFICIAL.mark.h + OFFICIAL.stackGap + OFFICIAL.wordmark.h);

/**
 * Inline cut proportions.
 *
 * The artwork only defines the stacked composition. An inline cut is needed
 * because a 27px-tall extension header cannot show a stacked lockup — the
 * wordmark's cap height would land at 4px. Rather than invent a look, the
 * inline cut keeps both pieces at their own artwork and only decides how they
 * sit next to each other: the wordmark's cap height is set to 0.42 of the
 * mark's height (which is what the stacked lockup's ratio works out to,
 * 44/203 = 0.217 of the mark against the mark's full height — doubled, because
 * an inline wordmark has no descender room to borrow) and the gap to 0.22.
 */
export const INLINE = { wordmarkCap: 0.42, gap: 0.22 } as const;

/** The two inks, sampled from the artwork. Exported for non-image surfaces. */
export const BRAND_INK = {
  /** "COMPUTER" */
  first: '#0e2d55',
  /** "CALLER" */
  second: '#1973b7',
  /** Lifted for dark grounds; both >= 4.5:1 on #18181b. */
  firstOnDark: '#f2f6fb',
  secondOnDark: '#5aa9e6',
} as const;

const BASE = '/brand/official';

/** Builds the `srcSet` for one cut. 3x is the artwork's native resolution. */
export function brandSrcSet(name: string): string {
  return `${BASE}/${name}.png 1x, ${BASE}/${name}@2x.png 2x, ${BASE}/${name}@3x.png 3x`;
}

export function brandSrc(name: string): string {
  return `${BASE}/${name}.png`;
}

export type BrandTone = 'auto' | 'light' | 'dark';

/**
 * Which wordmark cut a tone needs.
 *
 * 'auto' resolves to the light cut plus a `dark:` sibling in the markup —
 * there is no CSS that can recolour pixels inside a PNG, so a theme-aware
 * wordmark is two images with one hidden, not one image that adapts.
 */
export const WORDMARK_CUT = { light: 'cc-wordmark', dark: 'cc-wordmark-dark' } as const;
export const LOCKUP_CUT = { light: 'cc-lockup', dark: 'cc-lockup-dark' } as const;
export const MARK_CUT = 'cc-mark';

/**
 * Stacked sidebar word cuts (WEB-HEADER-WORDMARK, Dennis 2026-09-25): the
 * one-line wordmark split at the word gap by scripts/build-brand-lockup.ts.
 * Native (3x) ink boxes, both cap height 44. Light only — /app has no dark
 * variant by design (globals.css D4).
 */
export const STACKED_WORD_CUT = {
  computer: { name: 'cc-wordmark-computer', w: 358, h: 44 },
  caller: { name: 'cc-wordmark-caller', w: 241, h: 44 },
} as const;
