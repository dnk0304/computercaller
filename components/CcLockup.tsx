/**
 * CcLockup — the official ComputerCaller logo: the mark with the two-tone
 * "COMPUTER CALLER" wordmark.
 *
 * WHAT CHANGED (dispatch PIXEL-O, Dennis 2026-09-16)
 * --------------------------------------------------
 * Dennis, on the extension header: "Here is a screenshot of the wrong logo in
 * the extension. The text beneath is correct though." So: the wordmark's
 * treatment was right, the mark was not. Both now come from the artwork rather
 * than from geometry this repo drew — the mark out of
 * computercaller-icon-transparent.png, the wordmark keyed off the Play-listing
 * lockup, both cut by scripts/build-brand-lockup.ts. The reconstruction that
 * used to live in lib/brand/wordmark.ts is gone; that file is now the
 * measurements of the real thing.
 *
 * STACKED vs INLINE, AND WHY HEADERS GET INLINE
 * The official composition is stacked, and that is what every slot with room
 * for it gets (the sign-in hero, the extension's signed-out hero, the Android
 * sign-in screen). Headers do not have room for it. In a 40px header row the
 * mark can be ~24px tall, and stacked under a 24px mark the wordmark's cap
 * height lands at 5px — below the size at which the real letterforms resolve
 * into anything but a grey smear. Inline, the same 40px row gives the wordmark
 * a 10px cap: twice the size, the same artwork, and the mark stays at full
 * height instead of being halved to make room. That is the one composition
 * decision in this component, it is reversible in one prop, and the evidence
 * shots show both side by side.
 *
 * TONE
 * The wordmark's navy is #0e2d55; on the extension's dark surface (#18181b)
 * that is 1.4:1, i.e. gone. A PNG's pixels cannot be recoloured by CSS, so a
 * theme-aware wordmark is two images with one of them hidden — not one image
 * that adapts. `tone="auto"` renders both and hides one with a rule keyed on
 * the extension's own dark gate, `html[data-cc-theme=dark]`, the same
 * attribute app/extension/extension.css switches on. The rule ships as a
 * React 19 hoisted <style precedence>, so it is deduplicated to one copy in
 * <head> no matter how many lockups a page renders, and this component does
 * not have to reach into a stylesheet another surface owns.
 *
 * The MARK is never toned. Its green-to-blue gradient carries on both grounds,
 * and recolouring it would be redrawing the logo again.
 */

import React from 'react';
import { CcMark } from '@/components/CcMark';
import {
  OFFICIAL,
  INLINE,
  LOCKUP_CUT,
  WORDMARK_CUT,
  brandSrc,
  brandSrcSet,
  type BrandTone,
} from '@/lib/brand/wordmark';

export interface CcLockupProps {
  /**
   * The MARK's rendered height in px — the same anchor <CcMark size> uses, so
   * swapping one for the other keeps the mark identical and only adds the
   * wordmark. Everything else scales off it.
   */
  size?: number;
  /**
   * 'auto' (default) follows the extension's dark gate; 'light' / 'dark' pin
   * the wordmark's ink for callers painting on a ground the theme system does
   * not describe (a gradient splash, a PNG export).
   */
  tone?: BrandTone;
  /** 'stacked' = the official composition. 'inline' = beside, for headers. */
  layout?: 'stacked' | 'inline';
  /** @deprecated There is one mark now. See CcMark. */
  mark?: 'mini' | 'full';
  /** Accessible name. Set to null only if adjacent text already names it. */
  title?: string | null;
  className?: string;
}

/** Hoisted once by React 19's <style precedence>, however many lockups render. */
const TONE_CSS = `
.cc-lockup-dark{display:none}
html[data-cc-theme=dark] .cc-lockup-light{display:none}
html[data-cc-theme=dark] .cc-lockup-dark{display:inline-block}
`;

function ToneStyle() {
  return (
    <style href="cc-lockup-tone" precedence="default">
      {TONE_CSS}
    </style>
  );
}

export function CcLockup({
  size = 20,
  tone = 'auto',
  layout = 'stacked',
  title = 'ComputerCaller',
  className,
}: CcLockupProps) {
  const label = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true as const };

  if (layout === 'stacked') {
    // One image: the official composition, cut as one piece so the mark and
    // the wordmark cannot drift apart at any scale.
    const width = Math.round((size * OFFICIAL.wordmark.w) / OFFICIAL.mark.h);
    const height = Math.round(
      (size * (OFFICIAL.mark.h + OFFICIAL.stackGap + OFFICIAL.wordmark.h)) / OFFICIAL.mark.h,
    );
    return (
      <span className={className} style={{ display: 'inline-block', lineHeight: 0 }} {...label}>
        {tone === 'auto' && <ToneStyle />}
        {tone !== 'dark' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brandSrc(LOCKUP_CUT.light)}
            srcSet={brandSrcSet(LOCKUP_CUT.light)}
            width={width}
            height={height}
            alt=""
            decoding="async"
            fetchPriority="high"
            className={tone === 'auto' ? 'cc-lockup-light' : undefined}
            style={{ width, height }}
          />
        )}
        {tone !== 'light' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brandSrc(LOCKUP_CUT.dark)}
            srcSet={brandSrcSet(LOCKUP_CUT.dark)}
            width={width}
            height={height}
            alt=""
            decoding="async"
            className={tone === 'auto' ? 'cc-lockup-dark' : undefined}
            style={{ width, height }}
          />
        )}
      </span>
    );
  }

  // Inline: the mark at full height, the wordmark beside it.
  const cap = Math.round(size * INLINE.wordmarkCap);
  const wordWidth = Math.round(cap * OFFICIAL.wordmark.aspect);
  const gap = Math.round(size * INLINE.gap);

  const wordmark = (cut: string, cls?: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={cut}
      src={brandSrc(cut)}
      srcSet={brandSrcSet(cut)}
      width={wordWidth}
      height={cap}
      alt=""
      decoding="async"
      className={cls}
      /*
       * width is the NATURAL size; height is derived rather than pinned, and
       * max-width lets a flex parent take some of it back (dispatch PIXEL-S).
       * The extension header is the caller that needs it: at a 360px panel
       * with Large type the row is ~5px over, and addendum (a) says the
       * wordmark gives way before anything else wraps. aspect-ratio is what
       * makes that safe — the letterforms scale, they never squash — and with
       * no pressure the computed height is exactly `cap`, so every other
       * caller renders byte-identically to before.
       */
      style={{
        width: wordWidth,
        height: 'auto',
        aspectRatio: `${wordWidth} / ${cap}`,
        maxWidth: '100%',
        minWidth: 0,
      }}
    />
  );

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap, lineHeight: 0 }}
      {...label}
    >
      {tone === 'auto' && <ToneStyle />}
      <CcMark size={size} />
      {tone !== 'dark' && wordmark(WORDMARK_CUT.light, tone === 'auto' ? 'cc-lockup-light' : undefined)}
      {tone !== 'light' && wordmark(WORDMARK_CUT.dark, tone === 'auto' ? 'cc-lockup-dark' : undefined)}
    </span>
  );
}
