'use client';

/**
 * SyncMenuButton — single header "Sync" trigger + popover with Quick/Full
 * options.
 *
 * Why this exists (dispatch #34 item 9, 2026-05-26):
 *   The header used to surface TWO buttons, "Quick" and "Full" sync, eating
 *   ~140-180px of horizontal chrome. Dennis QA: "I would also like to make
 *   a general 'sync button' that then give you option to full or quick sync.
 *   That way the header stays more clear." Combined with dispatch #34 item 5
 *   (Phone Mode entry moves to ProfileMenu), the header gains ~110-130px of
 *   breathing room.
 *
 * Visual language:
 *   - Trigger button mirrors the original Quick button's pill (border-slate-200,
 *     bg hover, text-xs) so the chrome reads the same. RefreshCw icon stays
 *     the dominant cue; we add a ChevronDown to telegraph "this opens a menu".
 *   - Popover styling mirrors ProfileMenu.tsx (white card, shadow-lg, rounded
 *     border, animate-in fade+slide). Same conventions across the dashboard.
 *
 * Dismiss pattern (4 paths — leave any out and we have a UI trap):
 *   1. Click outside the trigger + popover → close
 *   2. Press Escape while open → close
 *   3. Select an option (Quick OR Full) → option handler fires, then close
 *   4. Click the trigger again → toggle close
 *
 * Loading state:
 *   When quick sync is in progress, both the trigger icon AND the Quick row
 *   icon spin. Quick row is also disabled while syncing. Mirrors the
 *   "Syncing…" affordance from the prior two-button design — Dennis sees
 *   activity at-a-glance even after closing the popover.
 *
 * Defensive rendering:
 *   - `isConnected === false` → returns null (no sync surface when there's no
 *     phone to sync FROM).
 *   - Both `onQuickSync` and `onFullSync` undefined → returns null (the hook
 *     hasn't surfaced these in this build — same defensive pattern as the
 *     prior two-button code).
 *   - Only ONE of the two defined → that one row renders, the other is
 *     omitted (no empty disabled row, no "Coming soon" copy).
 *
 * Interaction with dispatch #34 item 8 (auto-open Full Sync on connect):
 *   Auto-open hits `setShowSyncPanel(true)` directly inside usePhoneBridge —
 *   it doesn't go through this menu. If the auto-open fires while this
 *   popover happens to be open, the modal renders on top of the popover.
 *   We don't bother closing the popover automatically in that case — the
 *   modal's overlay swallows the click target anyway, and the user's next
 *   click outside the modal dismisses both. Verified no double-mount risk:
 *   `showSyncPanel` is a single bool source-of-truth.
 */

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, DatabaseBackup, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

interface SyncMenuButtonProps {
  isConnected: boolean;
  isQuickSyncing: boolean;
  onQuickSync?: () => void;
  onFullSync?: () => void;
}

export function SyncMenuButton({
  isConnected,
  isQuickSyncing,
  onQuickSync,
  onFullSync,
}: SyncMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside + Escape dismiss. Bound only while the popover is open so
  // we don't waste listeners or keep allocating handlers across every render.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // No phone, no sync. Return null so the header collapses cleanly — no
  // empty pill / disabled-looking ghost button.
  if (!isConnected) return null;
  // Neither path is wired — return null. (Hook surface may not have these
  // in older builds during a deploy ramp; defensive symmetry with the prior
  // two-button code in AppShell.tsx.)
  if (!onQuickSync && !onFullSync) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium',
          'text-slate-600 hover:text-slate-900 hover:bg-slate-100',
          'rounded-xl transition-colors border border-slate-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
        title={isQuickSyncing ? 'Quick sync in progress…' : 'Sync — choose Quick or Full'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Sync"
        aria-busy={isQuickSyncing}
      >
        <RefreshCw
          className={clsx('w-3 h-3', isQuickSyncing && 'animate-spin')}
          aria-hidden="true"
        />
        Sync
        <ChevronDown
          className={clsx('w-3 h-3 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Sync options"
          className={clsx(
            'absolute top-full right-0 mt-2 w-60',
            'rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10',
            'overflow-hidden z-50',
            'animate-in fade-in slide-in-from-top-1 duration-150',
          )}
        >
          {onQuickSync && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onQuickSync(); }}
              disabled={isQuickSyncing}
              className={clsx(
                'w-full flex items-start gap-3 px-3 py-2.5 text-left',
                'hover:bg-slate-50 transition-colors',
                'focus:outline-none focus:bg-slate-50',
                'disabled:opacity-60 disabled:cursor-progress',
              )}
            >
              <RefreshCw
                className={clsx(
                  'w-4 h-4 mt-0.5 flex-shrink-0 text-slate-500',
                  isQuickSyncing && 'animate-spin',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800">
                  {isQuickSyncing ? 'Syncing…' : 'Quick Sync'}
                </div>
                <div className="text-[11px] text-slate-500">Last 6 hours</div>
              </div>
            </button>
          )}
          {onFullSync && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onFullSync(); }}
              className={clsx(
                'w-full flex items-start gap-3 px-3 py-2.5 text-left',
                'hover:bg-slate-50 transition-colors',
                'focus:outline-none focus:bg-slate-50',
              )}
            >
              <DatabaseBackup
                className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-500"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800">Full Sync</div>
                <div className="text-[11px] text-slate-500">Re-sync everything</div>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
