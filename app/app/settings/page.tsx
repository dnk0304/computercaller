'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, ChevronDown, ChevronUp, RefreshCw, Zap, Smartphone } from 'lucide-react';
import { usePhone } from '@/hooks';
// SyncSetupPanel is mounted in app/app/layout.tsx — no import needed here.

interface UserData {
  id: string;
  email: string;
  phoneToken: string;
  subscription: {
    status: string;
    trialEndsAt: string;
    currentPeriodEnd: string | null;
  } | null;
}

// localStorage keys also written by usePhoneBridge — keep in sync.
const LAST_FULL_SYNC_KEY = 'dnkdialer_last_full_sync_at';
const LAST_QUICK_SYNC_KEY = 'dnkdialer_last_quick_sync_at';

// Format a unix-ms timestamp as a relative "Just now / 5m ago / 2h ago / 3d ago"
// string. Returns "Never" when the timestamp is null/0/NaN. Granularity is the
// most useful unit; we deliberately don't show seconds because the read cadence
// (storage event + 30s tick) is coarser than that.
function formatRelative(ts: number | null, now: number): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return 'Never';
  const diffMs = now - ts;
  if (diffMs < 0) return 'Just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  // For older entries we drop precision — the exact value isn't actionable, the
  // user just needs to know it's stale and run a Full Sync.
  return new Date(ts).toLocaleDateString();
}

function readSyncTimestamp(key: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export default function SettingsPage() {
  const [user, setUser] = useState<UserData | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Phone bridge — drives the Sync section (counts, button enabled state,
  // launch actions). `openSyncPanel` and `quickSync` may not yet be in the
  // hook's published type surface for every consumer; cast through a loose
  // shape rather than `any` so we still get errors if the names disappear.
  const phone = usePhone();
  const {
    isConnected,
    messages,
    contacts,
    callLogs,
  } = phone;
  const openSyncPanel = (phone as unknown as { openSyncPanel?: () => void }).openSyncPanel;
  const quickSync = (phone as unknown as { quickSync?: () => void }).quickSync;

  // Sync-history timestamps from localStorage. Refresh on:
  //   - mount
  //   - cross-tab storage events (another tab finished a sync)
  //   - a 30s tick so "5m ago" → "6m ago" naturally without manual refresh
  // We deliberately re-read instead of subscribing to a custom event from the
  // bridge — keeps the bridge agnostic of the settings page.
  const [lastFullSyncAt, setLastFullSyncAt] = useState<number | null>(null);
  const [lastQuickSyncAt, setLastQuickSyncAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      setLastFullSyncAt(readSyncTimestamp(LAST_FULL_SYNC_KEY));
      setLastQuickSyncAt(readSyncTimestamp(LAST_QUICK_SYNC_KEY));
    };
    refresh();
    const tick = window.setInterval(() => {
      // Re-read inside the tick so a sync triggered in the SAME tab (which
      // doesn't fire a storage event) still updates within 30s.
      refresh();
      setNowTick(Date.now());
    }, 30000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_FULL_SYNC_KEY || e.key === LAST_QUICK_SYNC_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const whopUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';
  const subStatus = user?.subscription?.status;
  const trialEnd = user?.subscription?.trialEndsAt
    ? new Date(user.subscription.trialEndsAt)
    : null;
  const daysLeft = trialEnd
    ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000))
    : null;

  if (!user) {
    return (
      <div className="p-8 text-slate-400 text-sm" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-6 space-y-4">
      <h1 className="text-lg font-bold text-slate-800">Settings</h1>

      {/* Phone connection — neutral pointer back to the dashboard. The
          connection model is LAN-only: type the IP your phone is showing in
          the Android app on the dashboard. We intentionally do not surface
          the phoneToken or any pairing metadata here. */}
      <section
        className="bg-white rounded-2xl border border-slate-200 p-5"
        aria-labelledby="phone-connection-heading"
      >
        <h2
          id="phone-connection-heading"
          className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2"
        >
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600"
          >
            <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
          Phone connection
        </h2>
        <p className="text-xs text-slate-500 leading-relaxed">
          Connect your phone by entering the IP shown in the DNK Dialer Android
          app on the{' '}
          <Link
            href="/app"
            className="text-blue-600 hover:text-blue-700 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
          >
            dashboard
          </Link>
          .
        </p>
      </section>

      {/* Subscription — always visible */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 text-xs"
          >
            💳
          </span>
          Subscription
        </h2>
        {subStatus === 'active' ? (
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-sm text-emerald-700 font-medium">Active</span>
          </div>
        ) : subStatus === 'trial' && daysLeft !== null && daysLeft > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-sm text-amber-700 font-medium">
                Free trial — {daysLeft} day{daysLeft !== 1 ? 's' : ''} left
              </span>
            </div>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Subscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-sm text-red-700 font-medium">
                {subStatus === 'trial' ? 'Trial ended' : 'Subscription expired'}
              </span>
            </div>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Subscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        )}
      </section>

      {/* Sync — always visible, sits above Advanced. Drives Full / Quick re-sync
          and surfaces the last-sync timestamps + current local dataset counts. */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
          Sync
        </h2>

        {/* Status row — last-sync timestamps. Two lines so neither is truncated
            on narrow viewports. Uses aria-live polite so SR users hear the
            "Just now → 1m ago" transitions without it being noisy. */}
        <dl
          className="text-xs text-slate-500 space-y-1 mb-3"
          aria-live="polite"
        >
          <div className="flex items-baseline gap-2">
            <dt className="font-medium text-slate-600">Last full sync:</dt>
            <dd className="tabular-nums">{formatRelative(lastFullSyncAt, nowTick)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="font-medium text-slate-600">Last quick resync:</dt>
            <dd className="tabular-nums">{formatRelative(lastQuickSyncAt, nowTick)}</dd>
          </div>
        </dl>

        {/* Counts row — current in-memory dataset sizes. Same `tabular-nums`
            treatment so the numbers don't wiggle as they tick up. */}
        <p className="text-xs text-slate-500 mb-4 tabular-nums">
          {messages.length.toLocaleString()} messages
          <span aria-hidden="true"> · </span>
          {contacts.length.toLocaleString()} contacts
          <span aria-hidden="true"> · </span>
          {callLogs.length.toLocaleString()} call logs
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => openSyncPanel?.()}
            disabled={!isConnected || typeof openSyncPanel !== 'function'}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
            title={isConnected ? 'Choose a time range and re-pull all data' : 'Connect your phone first'}
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Run Full Sync
          </button>
          <button
            type="button"
            onClick={() => quickSync?.()}
            disabled={!isConnected || typeof quickSync !== 'function'}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-700 text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
            title={isConnected ? 'Pull only the last 6 hours of activity' : 'Connect your phone first'}
          >
            <Zap className="w-4 h-4" aria-hidden="true" />
            Quick Resync (last 6h)
          </button>
        </div>
      </section>

      {/* Advanced — collapsed by default */}
      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-expanded={showAdvanced}
          aria-controls="advanced-panel"
        >
          <span>Advanced settings</span>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
        {showAdvanced && (
          <div id="advanced-panel" className="px-5 pb-5 space-y-4 border-t border-slate-100">
            <div className="pt-4">
              <p className="text-xs text-slate-500 mb-1">Account</p>
              <p className="text-sm text-slate-700">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={() =>
                fetch('/api/auth/logout', { method: 'POST' }).then(() => {
                  window.location.href = '/auth/login';
                })
              }
              className="text-sm text-red-500 hover:text-red-700 transition-colors focus:outline-none focus-visible:underline"
            >
              Sign out
            </button>
          </div>
        )}
      </section>

      {/* SyncSetupPanel is now mounted in app/app/layout.tsx so it's available
          everywhere openSyncPanel() can be called from (inline Settings tab on
          the dashboard included). Don't double-mount here — would cause two
          modals to render simultaneously when triggered. */}
    </div>
  );
}
