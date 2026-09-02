'use client';

// ---------------------------------------------------------------------------
// DashboardLayoutPreview — a scaled, non-interactive skeleton of the desktop
// dashboard, driven by the SAME resolved LayoutPrefs the real Dashboard renders
// from (lib/layoutPrefs.resolveLayoutPrefs). Used inside the Settings "Edit
// layout" editor so a user SEES their pending (unsaved) changes before Save.
//
// Why a skeleton and not the live <Dashboard/>: the real dashboard is wired to
// live phone/relay/websocket state, call data and dozens of hooks — it cannot
// render meaningfully with placeholder data, and mounting a second copy inside
// Settings would be heavy and error-prone. Instead this mirrors the real
// STRUCTURE decisions 1:1 (preset column arrangement, per-module visibility,
// variant/options/density) so the arrangement is accurate; content is skeleton.
//
// Structure mirrored from components/Dashboard.tsx render (Phase A):
//   Power/Custom: [notif strip?] + 3-col grid [calls col?][threads col?][chat]
//                 col widths ≈ [270–306 / 260–.88fr / 280–1.8fr]
//   Phone Link:   single focus pane + chat, notifications as a side feed.
// Keep this in sync if the Dashboard column model changes.
// ---------------------------------------------------------------------------

import type {
  LayoutPrefs,
  ModuleConfig,
  ModuleId,
  NotificationsConfig,
  QuickdialConfig,
  RecentcallsConfig,
  ThreadsConfig,
} from '@/lib/layoutPrefs';

// ---- tiny skeleton primitives ---------------------------------------------
// All decorative. Colors are fixed slate/blue tokens matching the real UI.

function Bar({ className = '' }: { className?: string }) {
  return <div className={'rounded-full bg-slate-200 ' + className} />;
}

function Panel({
  title,
  children,
  className = '',
}: {
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white ' +
        className
      }
    >
      <div className="flex items-center gap-1 border-b border-slate-100 bg-slate-50/70 px-1.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
        <span className="text-[7px] font-semibold leading-none text-slate-500">{title}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden p-1.5">{children}</div>
    </div>
  );
}

// Row gap helper keyed off density so the preview reflects compact/comfortable.
function rowGap(density: 'compact' | 'comfortable') {
  return density === 'compact' ? 'gap-1' : 'gap-1.5';
}

// ---- per-module skeletons --------------------------------------------------

function QuickDialSkeleton({ cfg }: { cfg: QuickdialConfig }) {
  return (
    <div className={'flex flex-col ' + rowGap(cfg.density)}>
      {/* dial input */}
      <Bar className="h-3 w-full !rounded-md bg-slate-100" />
      {cfg.options.showFavorites && (
        <div className="flex gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-3 w-3 rounded-full bg-blue-100" />
          ))}
        </div>
      )}
      {cfg.variant === 'grid' ? (
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="h-2.5 rounded-sm bg-slate-100" />
          ))}
        </div>
      ) : (
        <div className={'flex flex-col ' + rowGap(cfg.density)}>
          {[0, 1, 2].map((i) => (
            <Bar key={i} className="h-2 w-full bg-slate-100" />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentCallsSkeleton({ cfg }: { cfg: RecentcallsConfig }) {
  const rows = cfg.variant === 'minimal' ? 5 : 4;
  return (
    <div className={'flex flex-col ' + rowGap(cfg.density)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-slate-100" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Bar className="h-1.5 w-3/5 bg-slate-200" />
            {cfg.variant === 'detailed' && (cfg.options.showTimestamps || cfg.options.showDuration) && (
              <div className="flex gap-1">
                {cfg.options.showTimestamps && <Bar className="h-1 w-6 bg-slate-100" />}
                {cfg.options.showDuration && <Bar className="h-1 w-4 bg-slate-100" />}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadsSkeleton({ cfg }: { cfg: ThreadsConfig }) {
  return (
    <div className={'flex flex-col ' + rowGap(cfg.density)}>
      {/* search */}
      <Bar className="h-2.5 w-full !rounded-md bg-slate-100" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-start gap-1">
          {cfg.options.showAvatars && (
            <span className="mt-0.5 h-3 w-3 flex-shrink-0 rounded-full bg-slate-200" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Bar className="h-1.5 w-2/5 bg-slate-200" />
              {cfg.options.showUnreadBadges && i < 2 && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-400" />
              )}
            </div>
            {Array.from({ length: cfg.previewLines }).map((__, l) => (
              <Bar key={l} className={'h-1 bg-slate-100 ' + (l === 0 ? 'w-4/5' : 'w-3/5')} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex flex-1 flex-col gap-1.5 overflow-hidden">
        <span className="max-w-[70%] self-start rounded-md bg-slate-100 px-2 py-1.5" />
        <span className="max-w-[55%] self-end rounded-md bg-blue-100 px-2 py-2" />
        <span className="max-w-[62%] self-start rounded-md bg-slate-100 px-2 py-2" />
        <span className="max-w-[45%] self-end rounded-md bg-blue-100 px-2 py-1.5" />
      </div>
      {/* composer */}
      <Bar className="h-3 w-full !rounded-md bg-slate-100" />
    </div>
  );
}

function NotifStripSkeleton({ variant }: { variant: NotificationsConfig['variant'] }) {
  // 'strip' = narrow vertical rail of icons; 'feed' = wider stacked cards.
  if (variant === 'feed') {
    return (
      <div className="flex h-full w-14 flex-shrink-0 flex-col gap-1 rounded-md border border-slate-200 bg-white p-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-0.5 rounded-sm bg-slate-50 p-1">
            <Bar className="h-1 w-3/4 bg-slate-200" />
            <Bar className="h-1 w-1/2 bg-slate-100" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-full w-5 flex-shrink-0 flex-col items-center gap-1.5 rounded-md border border-slate-200 bg-white py-1.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="h-2.5 w-2.5 rounded-full bg-slate-100" />
      ))}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function byId<T extends ModuleConfig>(modules: ModuleConfig[], id: ModuleId): T {
  return modules.find((m) => m.id === id) as T;
}

/** Human-readable summary of the arrangement — feeds the a11y label + caption. */
export function describeLayout(resolved: Required<LayoutPrefs>): string {
  const on = (id: ModuleId) => byId(resolved.modules, id).visible;
  const names: string[] = [];
  if (on('quickdial')) names.push('Quick Dial');
  if (on('recentcalls')) names.push('Recent Calls');
  if (on('threads')) names.push('Conversations');
  if (on('notifications')) names.push('Notifications');
  const presetName =
    resolved.preset === 'phonelink' ? 'Phone Link' : resolved.preset === 'custom' ? 'Custom' : 'Power user';
  const shown = names.length ? names.join(', ') : 'no modules';
  return `${presetName} layout. Showing: ${shown}.`;
}

// ---------------------------------------------------------------------------

export function DashboardLayoutPreview({ resolved }: { resolved: Required<LayoutPrefs> }) {
  const notif = byId<NotificationsConfig>(resolved.modules, 'notifications');
  const quickdial = byId<QuickdialConfig>(resolved.modules, 'quickdial');
  const recentcalls = byId<RecentcallsConfig>(resolved.modules, 'recentcalls');
  const threads = byId<ThreadsConfig>(resolved.modules, 'threads');

  const notifVisible = notif.visible;
  const callsColVisible = quickdial.visible || recentcalls.visible;
  const threadsVisible = threads.visible;
  const isPhoneLink = resolved.preset === 'phonelink';

  const callsCol = (
    <Panel title="Quick Dial" className="flex-1">
      <div className="flex h-full flex-col gap-2 overflow-hidden">
        {quickdial.visible && <QuickDialSkeleton cfg={quickdial} />}
        {recentcalls.visible && (
          <div className="flex min-h-0 flex-1 flex-col gap-1 border-t border-slate-100 pt-1.5">
            <span className="text-[7px] font-semibold leading-none text-slate-400">Recent Calls</span>
            <RecentCallsSkeleton cfg={recentcalls} />
          </div>
        )}
      </div>
    </Panel>
  );

  const threadsCol = (
    <Panel title="Messages" className="flex-1">
      <ThreadsSkeleton cfg={threads} />
    </Panel>
  );

  const chatCol = (
    <Panel title="Conversation" className="flex-1">
      <ChatSkeleton />
    </Panel>
  );

  return (
    <div
      role="img"
      aria-label={`Dashboard preview. ${describeLayout(resolved)}`}
      className="pointer-events-none select-none overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-inner"
    >
      {/* faux window chrome so the frame reads as "your dashboard" */}
      <div className="flex items-center gap-1 border-b border-slate-200 bg-white/70 px-2 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
        <span className="ml-1 text-[7px] font-medium text-slate-400">Dashboard preview</span>
      </div>

      <div aria-hidden className="h-[190px] p-2">
        {isPhoneLink ? (
          // Phone Link — single focus pane + chat, notifications as a side feed.
          <div className="flex h-full gap-2">
            <div className="flex min-w-0 flex-[1.4] flex-col gap-2">
              {/* focus toggle: Calls | Messages */}
              <div className="flex gap-1">
                <span className="rounded-md bg-blue-500 px-2 py-1 text-[7px] font-semibold text-white">
                  Calls
                </span>
                <span className="rounded-md bg-slate-200 px-2 py-1 text-[7px] font-semibold text-slate-500">
                  Messages
                </span>
              </div>
              {callsColVisible ? callsCol : threadsVisible ? threadsCol : chatCol}
            </div>
            <div className="flex min-w-0 flex-[1.6] flex-col">{chatCol}</div>
            {notifVisible && <NotifStripSkeleton variant={notif.variant} />}
          </div>
        ) : (
          // Power / Custom — optional notif strip + 3-column grid.
          <div className="flex h-full gap-2">
            {notifVisible && <NotifStripSkeleton variant={notif.variant} />}
            <div
              className="grid min-w-0 flex-1 gap-2"
              style={{
                gridTemplateColumns: [
                  callsColVisible ? '1fr' : null,
                  threadsVisible ? '0.88fr' : null,
                  '1.8fr',
                ]
                  .filter(Boolean)
                  .join(' '),
              }}
            >
              {callsColVisible && callsCol}
              {threadsVisible && threadsCol}
              {chatCol}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
