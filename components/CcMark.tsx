/**
 * CcMark — the official ComputerCaller mark.
 *
 * WHAT CHANGED (dispatch PIXEL-O, Dennis 2026-09-16)
 * --------------------------------------------------
 * Dennis: "You have removed our official logo inside the app, our official
 * logo is not on the the extension either."
 *
 * This component used to draw its own mark: a green rounded tile with a white
 * handset on it ('mini'), and a simplified monitor-and-phone line drawing on
 * the same tile ('full'). Neither is the mark. The mark is the artwork the
 * Play listing uses — monitor and phone with the call arc sweeping between
 * them and the handset badge at the centre — and it now ships as that artwork,
 * cut by scripts/build-brand-lockup.ts out of
 * public/brand/computercaller-icon-transparent.png.
 *
 * SO THERE IS ONLY ONE CUT NOW
 * The old `variant="mini" | "full"` existed because the redrawn full mark
 * collapsed into mush below ~40px, so a second, simpler drawing had to exist
 * for headers. The real mark is line art with generous internal spacing and it
 * survives 18px, which is the only size the extension header can afford — see
 * the evidence shots. `variant` is kept as an accepted prop so the two dozen
 * call sites do not all have to change in one commit, but both values render
 * the same artwork. It is deprecated and does nothing.
 *
 * `size` IS NOW A HEIGHT, NOT AN EDGE
 * The old mark was square, so `size` meant "edge". The real mark is 393x203
 * (1.936:1). `size` is its rendered HEIGHT and the width follows; passing the
 * old numbers therefore yields a mark of the same height and roughly twice the
 * width. Every call site in this commit was re-checked against its container.
 *
 * WHY <img> AND NOT INLINE SVG
 * The previous component inlined SVG so the extension surface would not wait
 * on a network round-trip. That reasoning still holds and this still satisfies
 * it: the file is a few KB, it is served same-origin from computercaller.com
 * for every surface that renders React (the extension's own chrome renders the
 * vendored copy in chrome-extension/ instead, which is why that copy exists),
 * and `fetchPriority="high"` plus an explicit width/height means it lands in
 * the first paint with no layout shift. next/image is deliberately not used:
 * it would route a 4KB fixed-size logo through the optimiser and, inside the
 * extension iframe, through a second origin's loader.
 */

import React from 'react';
import { OFFICIAL, MARK_CUT, brandSrc, brandSrcSet } from '@/lib/brand/wordmark';

export interface CcMarkProps {
  /** Rendered HEIGHT in px. Width follows the artwork's 1.936:1. */
  size?: number;
  /** @deprecated There is one mark. Both values render the same artwork. */
  variant?: 'mini' | 'full';
  /**
   * Accessible name. Omit (the default) when a wordmark or heading beside the
   * mark already names the product — a logo that repeats the adjacent text is
   * noise in a screen reader, not information.
   */
  title?: string;
  className?: string;
}

export function CcMark({ size = 18, title, className }: CcMarkProps) {
  const width = Math.round(size * OFFICIAL.mark.aspect);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={brandSrc(MARK_CUT)}
      srcSet={brandSrcSet(MARK_CUT)}
      width={width}
      height={size}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      decoding="async"
      fetchPriority="high"
      className={className}
      style={{ width, height: size }}
    />
  );
}
