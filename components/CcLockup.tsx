/**
 * CcLockup — the official ComputerCaller brand lockup: the mark with the
 * wordmark set beneath it.
 *
 * WHY (dispatch PIXEL-J, Dennis 2026-09-15): "the official logo is not in the
 * extension view. We also have our logo with the 'computercaller' title
 * beneath, the one we used for the android app listing. I would like to use
 * that one both on the web and the extension and phone mode as well."
 *
 * Until now there was no vector wordmark anywhere in the repo — only the
 * mark-only SVGs and <CcMark>. Surfaces that wanted the lockup either shipped
 * a PNG (which the extension cannot load: no content_security_policy key in
 * manifest.json means the MV3 default `img-src 'self'` applies, so anything on
 * computercaller.com is blocked) or set the name in the page's UI face, which
 * is not the brand's wordmark at all. lib/brand/wordmark.ts is the trace; this
 * component is the assembly.
 *
 * COMPOSITION, NOT A SECOND COPY OF THE MARK
 * The mark comes from <CcMark>, unmodified. Two SVGs side by side in a flex
 * box rather than one merged SVG: merging would have meant transcribing the
 * mark's twelve shapes a third time (CcMark.tsx, the static .svg files, and
 * here), and three transcriptions of one drawing is how the extension ended up
 * showing a blank gradient tile in the first place.
 *
 * SIZING
 * `size` is the MARK's edge length in px, matching <CcMark size>. The wordmark
 * is sized off it, so swapping <CcMark size={18}/> for <CcLockup size={18}/>
 * keeps the mark identical and only adds the name underneath.
 *
 * ACCESSIBILITY
 * The whole lockup is one labelled image; the mark and the wordmark are both
 * aria-hidden inside it. The wordmark is a picture of the word "ComputerCaller"
 * — unlike <CcMark>, which sits beside real text, this one carries the name
 * itself, so it always needs an accessible name and `title` defaults to the
 * product name rather than to nothing.
 */

import React from 'react';
import { CcMark } from '@/components/CcMark';
import {
  CAP,
  STROKE,
  WORDMARK_ASPECT,
  WORDMARK_COLORS,
  WORDMARK_D_FIRST,
  WORDMARK_D_SECOND,
  WORDMARK_W,
} from '@/lib/brand/wordmark';

export interface CcLockupProps {
  /** The MARK's edge length in px. The wordmark scales from it. */
  size?: number;
  /**
   * Which ground it sits on.
   *   'auto' (default) — the ink comes from --cc-wordmark-1/-2, which
   *       app/extension/extension.css redefines under its dark gate. That is
   *       what makes the lockup follow the extension's System/Light/Dark
   *       toggle without this component knowing the toggle exists.
   *   'light' / 'dark' — literal ink, for callers painting on a ground the
   *       theme system does not describe (a gradient splash, a PNG export).
   * 'dark' lifts the navy half to near-white: #0b2d5c on a #18181b card is
   * 1.4:1, i.e. invisible.
   */
  tone?: 'auto' | 'light' | 'dark';
  /** 'stacked' = wordmark beneath (the official lockup). 'inline' = beside. */
  layout?: 'stacked' | 'inline';
  /**
   * Which cut of the mark. Explicit rather than inferred from `size` — see the
   * note in CcMark.tsx: the cuts are different artwork, not two scales, and
   * nudging a header by 2px must not silently redraw the logo.
   */
  mark?: 'mini' | 'full';
  /** Accessible name. Set to null only if adjacent text already names it. */
  title?: string | null;
  className?: string;
}

/**
 * Wordmark cap height as a fraction of the mark's edge.
 *
 * Stacked 0.36 is a deliberate departure from the source lockup's own ratio.
 * In computercaller-icon-square.png the wordmark sits under a WIDE monitor +
 * phone drawing ~400px across; here it sits under the square app tile, and
 * keeping the source's cap-to-artwork ratio against a 18px tile put the cap at
 * 5.6px — a wordmark you can see but not read. 0.36 gives 6.5px at the
 * extension header's 18px mark, in a block 92px wide: still 20px narrower than
 * the mark + text pair it replaced, so the 40px row's space budget (AC-1 of
 * dispatch B2) is better off, not worse.
 * Inline 0.34 is the same optical weight against a mark it stands beside.
 */
const CAP_RATIO = { stacked: 0.36, inline: 0.34 } as const;
const GAP_RATIO = { stacked: 0.18, inline: 0.34 } as const;

export function CcLockup({
  size = 20,
  tone = 'auto',
  layout = 'stacked',
  mark = 'mini',
  title = 'ComputerCaller',
  className,
}: CcLockupProps) {
  const cap = size * CAP_RATIO[layout];
  const wordmarkWidth = cap * WORDMARK_ASPECT;
  const colors =
    tone === 'auto'
      ? {
          first: `var(--cc-wordmark-1, ${WORDMARK_COLORS.light.first})`,
          second: `var(--cc-wordmark-2, ${WORDMARK_COLORS.light.second})`,
        }
      : WORDMARK_COLORS[tone];
  const labelled = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true as const };

  const wordmark = (
    <svg
      width={wordmarkWidth}
      height={cap}
      viewBox={`0 0 ${WORDMARK_W} ${CAP}`}
      // The stroke is centred on the glyph centrelines, so half of it and the
      // round letters' overshoot fall outside the cap-height box. Without this
      // the top of the C and the bottom of the O are clipped at small sizes.
      style={{ overflow: 'visible' }}
      fill="none"
      strokeWidth={STROKE}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      focusable="false"
      aria-hidden="true"
    >
      {/* style, not a stroke ATTRIBUTE: var() is a CSS value, and SVG
          presentation attributes are not CSS — `stroke="var(--x)"` is parsed
          as an invalid paint and silently falls back to black. */}
      <path d={WORDMARK_D_FIRST} style={{ stroke: colors.first }} />
      <path d={WORDMARK_D_SECOND} style={{ stroke: colors.second }} />
    </svg>
  );

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        flexDirection: layout === 'stacked' ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: `${size * GAP_RATIO[layout]}px`,
        lineHeight: 0,
      }}
      {...labelled}
    >
      <CcMark size={size} variant={mark} />
      {wordmark}
    </span>
  );
}
