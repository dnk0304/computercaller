'use client';

// ---------------------------------------------------------------------------
// DashboardLayoutPreview — the "before you save" live mockup.
// Dispatch pixel/layout-editor-fix (2026-09-02).
//
// A PURE, presentational skeleton of the desktop dashboard, driven entirely by
// a fully-resolved LayoutPrefs. It deliberately mirrors the ARRANGEMENT rules
// that components/Dashboard.tsx applies from the same `layoutResolved` object
// (see Dashboard's "Layout preset assembly" / "Arrange the surfaces per preset"
// blocks) so what the user previews matches what actually renders:
//
//   • preset 'power'/'custom'  → optional left notification strip + 3-column
//                                grid: Calls col (Quick Dial + Recent Calls),
//                                Conversations col, Chat col (always shown).
//   • preset 'phonelink'       → single-focus: a Calls/Messages switch, one
//                                pane at a time, notifications as a side feed.
//   • per-module `visible`     → gates each surface (Calls col shows if EITHER
//                                Quick Dial or Recent Calls is visible).
//   • per-module `variant` / options / density → change the SHAPE of the
//                                skeleton content (grid vs list, detailed vs
//                                minimal, avatars, preview lines, row density).
//
// It renders placeholder/skeleton bars only — NO live call/SMS data, no hooks,
// no side effects. That keeps it cheap to re-render on every keystroke of the
// editor and safe to mount anywhere. Structure is accurate; content is fake.
// ---------------------------------------------------------------------------

import { Phone, MessageSquare, Bell, Star } from 'lucide-react';
import type {
  LayoutPrefs,
  ModuleId,
  ModuleConfig,
  NotificationsConfig,
  QuickdialConfig,
  RecentcallsConfig,
  ThreadsConfig,
} from '@/lib/layoutPrefs';

type Resolved = Required<LayoutPrefs>;

// ---- skeleton primitives ---------------------------------------------------

/** A neutral placeholder bar. `w` accepts a tailwind width class. */
function Bar({ w = 'w-full', className = '' }: { w?: string; className?: string }) {
  return <div className={`h-1.5 rounded-full bg-slate-200 ${w} ${className}`} />;
}

function CardShell({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon: typeof Phone;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white ${className}`}
    >
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-100 bg-slate-50/70 px-2 py-1">
        <Icon className="h-2.5 w-2.5 text-slate-400" aria-hidden="true" />
        <span className="text-[8px] font-semibold text-slate-600">{title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-1.5">{children}</div>
    </div>
  );
}

// ---- module skeletons ------------------------------------------------------

function QuickDialSkeleton({ cfg, gap }: { cfg: QuickdialConfig; gap: string }) {
  return (
    <div className={`flex flex-col ${gap}`}>
      {/* dial input */}
      <div className="h-3 w-full rounded bg-slate-100 ring-1 ring-inset ring-slate-200" />
      {cfg.options.showFavorites &&
        (cfg.variant === 'grid' ? (
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col items-center gap-0.5">
                <div className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-100">
                  <Star className="h-2 w-2 text-slate-300" aria-hidden="true" />
                </div>
                <Bar w="w-4" className="h-1" />
              </div>
            ))}
          </div>
        ) : (
          <div className={`flex flex-col ${gap}`}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Star className="h-2.5 w-2.5 flex-shrink-0 text-slate-300" aria-hidden="true" />
                <Bar w="w-full" />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function RecentCallsSkeleton({ cfg, gap }: { cfg: RecentcallsConfig; gap: string }) {
  const detailed = cfg.variant === 'detailed';
  return (
    <div className={`flex flex-col ${gap}`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className="h-3 w-3 flex-shrink-0 rounded-full bg-slate-100" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Bar w={i % 2 ? 'w-2/3' : 'w-3/4'} />
            {detailed && cfg.options.showTimestamps && <Bar w="w-1/3" className="bg-slate-100" />}
          </div>
          {detailed && cfg.options.showDuration && <Bar w="w-4" className="bg-slate-100" />}
        </div>
      ))}
    </div>
  );
}

function ThreadsSkeleton({ cfg, gap }: { cfg: ThreadsConfig; gap: string }) {
  return (
    <div className={`flex flex-col ${gap}`}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {cfg.options.showAvatars && (
            <div className="h-4 w-4 flex-shrink-0 rounded-full bg-slate-100" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Bar w="w-1/2" />
              {cfg.options.showUnreadBadges && i < 2 && (
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />
              )}
            </div>
            {cfg.previewLines >= 1 && <Bar w="w-full" className="bg-slate-100" />}
            {cfg.previewLines >= 2 && <Bar w="w-2/3" className="bg-slate-100" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Chat pane — always present in the real dashboard (col3). Not configurable. */
function ChatSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex flex-col gap-1">
        <Bar w="w-1/2" className="self-start" />
        <div className="h-4 w-2/3 self-start rounded-lg rounded-tl-sm bg-slate-100" />
        <div className="h-4 w-1/2 self-end rounded-lg rounded-tr-sm bg-blue-100" />
        <div className="h-4 w-3/5 self-start rounded-lg rounded-tl-sm bg-slate-100" />
      </div>
      <div className="mt-auto h-3 w-full flex-shrink-0 rounded bg-slate-100 ring-1 ring-inset ring-slate-200" />
    </div>
  );
}

function NotificationFeedSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-1 rounded border border-slate-100 bg-slate-50/60 p-1">
          <Bell className="mt-0.5 h-2 w-2 flex-shrink-0 text-slate-300" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Bar w="w-2/3" />
            <Bar w="w-full" className="bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function byId<T extends ModuleConfig>(resolved: Resolved, id: ModuleId): T {
  return resolved.modules.find((m) => m.id === id)! as T;
}

/** Density → inter-row gap. Mirrors the compact/comfortable intent. */
function gapFor(density: 'compact' | 'comfortable'): string {
  return density === 'compact' ? 'gap-0.5' : 'gap-1.5';
}

// ---- main ------------------------------------------------------------------

export function DashboardLayoutPreview({ prefs }: { prefs: Resolved }) {
  const notif = byId<NotificationsConfig>(prefs, 'notifications');
  const quickdial = byId<QuickdialConfig>(prefs, 'quickdial');
  const recentcalls = byId<RecentcallsConfig>(prefs, 'recentcalls');
  const threads = byId<ThreadsConfig>(prefs, 'threads');

  const callsColVisible = quickdial.visible || recentcalls.visible;
  const isPhoneLink = prefs.preset === 'phonelink';

  // Calls column content (Quick Dial + Recent Calls), shared by both layouts.
  const callsCol = (
    <CardShell icon={Phone} title="Quick Dial" className="h-full">
      <div className="flex h-full flex-col gap-2">
        {quickdial.visible && <QuickDialSkeleton cfg={quickdial} gap={gapFor(quickdial.density)} />}
        {recentcalls.visible && (
          <div className="flex min-h-0 flex-1 flex-col gap-1 border-t border-slate-100 pt-1.5">
            <span className="text-[7px] font-semibold uppercase tracking-wide text-slate-400">
              Recent
            </span>
            <RecentCallsSkeleton cfg={recentcalls} gap={gapFor(recentcalls.density)} />
          </div>
        )}
      </div>
    </CardShell>
  );

  const threadsCol = (
    <CardShell icon={MessageSquare} title="Conversations" className="h-full">
      <ThreadsSkeleton cfg={threads} gap={gapFor(threads.density)} />
    </CardShell>
  );

  const chatCol = (
    <CardShell icon={MessageSquare} title="Chat" className="h-full">
      <ChatSkeleton />
    </CardShell>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      {/* fake window chrome so it reads as "a screen", not a control */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-red-300" />
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
        <span className="ml-1.5 text-[8px] font-medium text-slate-400">Dashboard preview</span>
      </div>

      <div className="min-h-0 flex-1 p-2">
        {isPhoneLink ? (
          // ---- Phone Link: single-focus + side notification feed -------------
          <div className="flex h-full min-h-0 flex-col gap-1.5">
            {/* Calls / Messages focus switch */}
            <div className="inline-flex flex-shrink-0 self-start gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
              <span className="flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-[8px] font-semibold text-slate-700 shadow-sm">
                <Phone className="h-2 w-2" aria-hidden="true" /> Calls
              </span>
              <span className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[8px] font-medium text-slate-400">
                <MessageSquare className="h-2 w-2" aria-hidden="true" /> Messages
              </span>
            </div>
            <div className="flex min-h-0 flex-1 gap-1.5">
              {/* focused pane (Calls shown as the default focus) */}
              <div className="flex min-h-0 flex-1 justify-center">
                <div className="flex w-full max-w-[55%] min-h-0 flex-col">
                  {callsColVisible ? (
                    callsCol
                  ) : (
                    <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-200 px-2 text-center text-[8px] text-slate-400">
                      Calls hidden — turn Quick Dial or Recent Calls back on
                    </div>
                  )}
                </div>
              </div>
              {notif.visible && (
                <div className="flex w-1/4 min-w-0 flex-shrink-0 flex-col">
                  <CardShell icon={Bell} title="Notifications" className="h-full">
                    <NotificationFeedSkeleton />
                  </CardShell>
                </div>
              )}
            </div>
          </div>
        ) : (
          // ---- Power / Custom: edge strip + 3-column grid --------------------
          <div className="flex h-full min-h-0 gap-1.5">
            {notif.visible && (
              <div
                className="flex w-2 flex-shrink-0 flex-col items-center gap-1 rounded-md border border-slate-200 bg-white py-1"
                aria-hidden="true"
              >
                <Bell className="h-2 w-2 text-slate-300" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <span key={i} className="h-1 w-1 rounded-full bg-slate-200" />
                ))}
              </div>
            )}
            <div className="grid min-h-0 flex-1 gap-1.5 grid-cols-[1fr_0.9fr_1.7fr]">
              {callsColVisible ? callsCol : <div />}
              {threads.visible ? threadsCol : <div />}
              {chatCol}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
