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
 *   - Sync (Quick + Full) buttons — hidden in Phone Mode
 *   - ProfileMenu — hidden in Phone Mode
 *   - Sidebar — hidden in Phone Mode (no nav rail at this width)
 *   The user must Expand to access any of these.
 */

import React from 'react';
import { Maximize2 } from 'lucide-react';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { usePhoneMode } from '@/hooks';

export function PhoneModeHeader() {
  const { expandManually } = usePhoneMode();

  return (
    // Sticky so a long scrollable view (Texts list, thread) keeps the
    // header visible. h-12 (48px) is the iOS HIG mobile header height —
    // tighter than the dashboard's h-20 because the Sidebar is gone and
    // we need every pixel of vertical room.
    <header
      className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-slate-200/60 bg-white/85 px-3 backdrop-blur-sm"
      role="banner"
    >
      {/* Brand dot — matches the gradient brand-dot used elsewhere but at a
          tiny scale so it reads as a glance-mark rather than a logo lockup.
          aria-hidden because the ConnectionStatus pill carries the readable
          brand context. */}
      <span
        aria-hidden="true"
        className="h-6 w-6 flex-shrink-0 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm"
        title="ComputerCaller"
      />

      {/* ConnectionStatus eats remaining width but truncates its own children.
          Wrapping in min-w-0 so flex can actually shrink the pill on 320px. */}
      <div className="min-w-0 flex-1">
        <ConnectionStatus />
      </div>

      {/* Expand — leave Phone Mode and reveal the dashboard chrome. The icon
          alone is enough at 320px; aria-label carries the verbal affordance.
          44x44 hit target (iOS HIG min) even at a 32x32 visual button. */}
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
