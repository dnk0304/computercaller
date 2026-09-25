import React from 'react';
import { CcMark } from '@/components/CcMark';
import { STACKED_WORD_CUT, brandSrc, brandSrcSet } from '@/lib/brand/wordmark';

/**
 * SidebarLockup — the expanded /app sidebar's brand: the official mark beside
 * the official wordmark split onto two rows, COMPUTER over CALLER (Dennis
 * 2026-09-25: "In sidebar, keep the sentences on 2 rows").
 *
 * Every pixel is the artwork's: the rows are the one-line wordmark cut at its
 * word gap (scripts/build-brand-lockup.ts, "stacked word cuts"). Both rows are
 * sized by the same width, so CALLER matches COMPUTER's width by construction
 * and, scaled uniformly, stands ~1.5x taller (the V1 Dennis picked).
 *
 * Deliberately NOT a CcLockup layout: CcLockup is shared with the extension
 * header (PhoneModeHeader), which must stay byte-identical. Light only — /app
 * has no dark variant (globals.css D4), so there is no tone switch here.
 */
export interface SidebarLockupProps {
  /** Mark height in px — the same anchor as <CcMark size>. */
  size?: number;
  /** Shared width of both wordmark rows, in px. */
  wordWidth?: number;
  className?: string;
}

export function SidebarLockup({ size = 24, wordWidth = 128, className }: SidebarLockupProps) {
  const rows = [STACKED_WORD_CUT.computer, STACKED_WORD_CUT.caller];
  return (
    <span
      role="img"
      aria-label="ComputerCaller"
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 0 }}
    >
      <CcMark size={size} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((cut) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={cut.name}
            src={brandSrc(cut.name)}
            srcSet={brandSrcSet(cut.name)}
            width={wordWidth}
            height={Math.round((wordWidth * cut.h) / cut.w)}
            alt=""
            decoding="async"
            draggable={false}
            data-wordmark-row={cut.name}
            style={{ display: 'block', width: wordWidth, height: 'auto' }}
          />
        ))}
      </span>
    </span>
  );
}
