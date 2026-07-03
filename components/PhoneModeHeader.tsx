'use client';

/**
 * PhoneModeHeader — compact top strip for Phone Mode.
 *
 * Composition (left → right):
 *   ● brand dot · ConnectionStatus pill · [Expand ⤢]
 *
 * Why a separate component (vs. inlining in PhoneModeShell):
 *   It re-renders independently of view changes (stack push/pop) — keeps
 *   ConnectionStatus's lobby-state subscription quiet during tab swipes.
 *
 * Hidden chrome (per Dennis answer #5):
 *   - Sync (consolidated dropdown) — hidden in Phone Mode
 *   - ProfileMenu — hidden in Phone Mode (Phone Mode entry itself is INSIDE
 *     ProfileMenu — see dispatch #34, item 5)
 *   - Sidebar — hidden in Phone Mode (no nav rail at this width)
 *   The user must Expand to access any of these.
 *
 * Sizing (dispatch #34, 2026-05-26): h-10 (40px) — was h-12 (48px). 15%
 * shrink applied across the whole shell. Cascade: TabBar top-10,
 * sub-headers top-[84px] (40 + 44).
 */

import React from 'react';
import { Maximize2 } from 'lucide-react';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { usePhoneMode } from '@/hooks';

export function PhoneModeHeader() {
  const { expandManually } = usePhoneMode();

  return (
    // Sticky so a long scrollable view (Texts list, thread) keeps the
    // header visible. h-10 (40px) — scaled down from h-12 (48px) as part of
    // the dispatch-#34 "Phone Mode ~15% smaller" pass. The 8px reclaim
    // cascades into every downstream sticky offset (TabBar top-10,
    // sub-headers top-[84px]). Header is decorative chrome (no tap targets
    // need 44px here — the Expand button itself remains a 40×40 hit area,
    // matching iOS HIG comfortably alongside the 44px tab buttons below).
    <header
      className="sticky top-0 z-30 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/85 px-2.5 backdrop-blur-sm"
      role="banner"
    >
      {/* Brand dot — matches the gradient brand-dot used elsewhere but at a
          tiny scale so it reads as a glance-mark rather than a logo lockup.
          aria-hidden because the ConnectionStatus pill carries the readable
          brand context. */}
      <span
        aria-hidden="true"
        className="h-5 w-5 flex-shrink-0 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm"
        title="ComputerCaller"
      />

      {/* Beta tag — Phone Mode is still in beta. flex-shrink-0 so it survives
          at 320px; sits next to the brand dot to avoid crowding the pill. */}
      <span className="flex-shrink-0 inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
        Beta
      </span>

      {/* ConnectionStatus eats remaining width but truncates its own children.
          Wrapping in min-w-0 so flex can actually shrink the pill on 320px. */}
      <div className="min-w-0 flex-1">
        <ConnectionStatus />
      </div>

      {/* Expand — leave Phone Mode and reveal the dashboard chrome. The icon
          alone is enough at 320px; aria-label carries the verbal affordance.
          40×40 hit target — slightly under iOS HIG's 44px floor for THIS
          single chrome control, accepted trade-off so the header stays at
          40px total height. The dialpad keys + call button + tab buttons
          remain ≥44px (the actually-touched targets). */}
      <button
        type="button"
        onClick={expandManually}
        className="-mr-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        aria-label="Expand to full dashboard"
        title="Expand to full dashboard"
      >
        <Maximize2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </header>
  );
}
