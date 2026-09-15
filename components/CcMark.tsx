/**
 * CcMark — the official ComputerCaller mark, as React.
 *
 * ONE SOURCE, TWO CUTS (dispatch PIXEL-C addendum, 2026-09-15). Dennis:
 * "implement our official logo inside of the extension". Until now the
 * extension surface painted a BLANK green→blue rounded tile as its mark — the
 * brand gradient with no brand in it — and the shell's signed-out header
 * painted the same empty tile in CSS. Three places drew "the logo" and none of
 * them drew the logo.
 *
 * The masters are design/extension-marks/mark-full.svg and mark-mini.svg. They
 * are transcribed here rather than <img>-ed because this mark renders inside
 * an 18px header row on a surface that must not wait on a network round-trip
 * to show its own name, and because an inline SVG inherits the page's
 * rendering (no separate request, no flash of nothing, no broken-image box).
 *
 * WHICH CUT, AND WHY IT IS NOT A SIZE PROP ALIAS
 *   variant="mini"  — the tile + a bold handset. The full mark's monitor,
 *                     phone, call arc and handset badge are five objects in a
 *                     128px square; at 18px they collapse into green mush.
 *                     Mini is the mark redrawn for that size, not scaled down.
 *   variant="full"   — the complete mark. Correct at 40px and up, which on
 *                     these surfaces means the signed-out hero only.
 * The cut is chosen by the caller because the caller knows the context;
 * inferring it from `size` would silently change the artwork when someone
 * nudges a header by 2px.
 *
 * The gradient needs a document-unique id — two marks on one page sharing
 * `id="cc"` means the second one's fill resolves to the first one's element,
 * which is invisible until it isn't. useId() is the supported way to get one
 * that also matches between server and client render.
 */

import React, { useId } from 'react';

export interface CcMarkProps {
  /** Rendered edge length in px. Square. */
  size?: number;
  /** Which cut of the mark. See the note above — this is artwork, not scale. */
  variant?: 'mini' | 'full';
  /**
   * Accessible name. Omit (the default) when a wordmark or heading beside the
   * mark already names the product — a logo that repeats the adjacent text is
   * noise in a screen reader, not information.
   */
  title?: string;
  className?: string;
}

export function CcMark({ size = 18, variant = 'mini', title, className }: CcMarkProps) {
  const gradientId = `cc-mark-${useId()}`;
  const labelled = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true as const };

  if (variant === 'full') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={className}
        focusable="false"
        {...labelled}
      >
        <defs>
          <linearGradient id={gradientId} x1="14" y1="14" x2="114" y2="114" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#35c977" />
            <stop offset="0.55" stopColor="#22a89a" />
            <stop offset="1" stopColor="#1e8fb2" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="120" height="120" rx="27" fill={`url(#${gradientId})`} />
        <rect
          x="4.5"
          y="4.5"
          width="119"
          height="119"
          rx="26.5"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.14"
          strokeWidth="1"
        />
        <g fill="none" stroke="#ffffff" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round">
          <rect x="24" y="34" width="52" height="40" rx="6" />
          <path d="M42 82 h16 M50 74 v8" />
          <rect x="84" y="40" width="26" height="48" rx="6" />
          <path d="M92 46 h10" strokeWidth="4" />
          <circle cx="97" cy="82.5" r="2.4" fill="#ffffff" stroke="none" />
          <path d="M44 60 q20 -18 44 -6" strokeWidth="5" />
        </g>
        <g transform="translate(56 52)">
          <circle cx="9" cy="9" r="15" fill="#ffffff" />
          <path
            d="M4.4 5.1c-.5.4-.8 1-.7 1.7.3 2.2 1.4 4.3 3 5.9 1.6 1.6 3.7 2.7 5.9 3 .7.1 1.3-.2 1.7-.7l.9-1.2c.3-.5.2-1.1-.2-1.4l-2-1.4c-.4-.3-.9-.2-1.2.1l-.7.8c-1.2-.6-2.2-1.6-2.8-2.8l.8-.7c.3-.3.4-.8.1-1.2l-1.4-2c-.3-.4-.9-.5-1.4-.2z"
            fill="#1e8fb2"
          />
        </g>
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      focusable="false"
      {...labelled}
    >
      <defs>
        <linearGradient id={gradientId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#35c977" />
          <stop offset="0.55" stopColor="#22a89a" />
          <stop offset="1" stopColor="#1e8fb2" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${gradientId})`} />
      <path
        d="M11.2 8.6c-1 .8-1.5 2-1.3 3.3.5 3.9 2.5 7.5 5.3 10.3 2.8 2.8 6.4 4.8 10.3 5.3 1.3.2 2.5-.3 3.3-1.3l1.6-2.1c.6-.8.4-2-.4-2.6l-3.5-2.5c-.7-.5-1.7-.4-2.3.3l-1.3 1.4c-2.2-1.1-4-2.9-5.1-5.1l1.4-1.3c.7-.6.8-1.6.3-2.3l-2.5-3.5c-.6-.8-1.8-1-2.6-.4z"
        fill="#ffffff"
        transform="translate(3.1 3.4) scale(0.72)"
      />
    </svg>
  );
}
