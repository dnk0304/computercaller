'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, ChevronDown, ChevronUp, RefreshCw, Zap, Smartphone, Download } from 'lucide-react';
import { usePhone } from '@/hooks';
import {
  getDeviceLabel,
  getDeviceLabelSync,
  getDeviceLabelOverride,
  setDeviceLabelOverride,
  clearDeviceLabelOverride,
} from '@/lib/deviceLabel';
// SyncSetupPanel is mounted in app/app/layout.tsx — no import needed here.
import { SignInSecuritySection } from './SignInSecuritySection';
import { LayoutSettings } from '@/components/LayoutSettings';

interface UserData {
  id: string;
  email: string;
  // hasPassword (2026-08-22, pixel/set-password): DERIVED boolean from
  // /api/auth/me — true once the account has a passwordHash. Drives the
  // "Sign-in & security" section's Set-vs-Change state. Chosen by the SERVER,
  // never inferred client-side.
  hasPassword?: boolean;
  // Bundle A (2026-05-28): phoneToken removed from /api/auth/me response
  // (Phase 4 fix L9 / C1). This page never rendered it (the comment near
  // line 287 explicitly says no phoneToken or pairing metadata is shown).
  // The relay bearer is now obtained per-connection via /api/auth/relay-
  // ticket, and the QR pairing flow uses /api/auth/qr-token.
  subscription: {
    status: string;
    trialEndsAt: string;
    currentPeriodEnd: string | null;
  } | null;
}

// localStorage keys also written by usePhoneBridge — keep in sync.
const LAST_FULL_SYNC_KEY = 'dnkdialer_last_full_sync_at';
const LAST_QUICK_SYNC_KEY = 'dnkdialer_last_quick_sync_at';
// Mirror of hooks/usePhoneBridge.ts PHONE_URL_KEY (dispatch #8, 2026-05-22).
// Hard-coded here intentionally to avoid pulling the hook's module just to
// share one literal; if the constant in the hook is ever renamed, search the
// repo for 'dnkdialer_phone_url' to find both call sites. Used by the
// "Forget saved phone" affordance below.
const PHONE_URL_KEY = 'dnkdialer_phone_url';

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

  // Saved-phone-IP state (dispatch #8, 2026-05-22). Mirrors PHONE_URL_KEY so
  // the "Forget saved phone" button can show the IP about to be cleared AND
  // disable itself when there's nothing to forget. Re-read on:
  //   - mount
  //   - storage events (another tab connected/disconnected)
  //   - after Forget click (handler bumps state to null)
  // We deliberately do NOT poll on a timer — the only same-tab mutators are
  // usePhoneBridge.connectPhone (sets) and this button's handler (clears).
  // Stale read between a same-tab connect and the user landing on settings is
  // a non-issue: by the time they navigate here, the connect is done.
  const [savedPhoneUrl, setSavedPhoneUrl] = useState<string | null>(null);
  const [forgetConfirmedAt, setForgetConfirmedAt] = useState<number | null>(null);

  // Device label (dispatch FORGE-1, 2026-05-26) — friendly browser-identity
  // string shown on the paired phone's Accept dialog. Auto-detected from
  // UA-CH + UA fallback, user-renameable. Override beats auto-detected;
  // empty input → revert to auto. The new label takes effect on the NEXT
  // pairing request; currently-paired sessions don't refresh retroactively.
  const [autoLabel, setAutoLabel] = useState<string>('');
  const [overrideLabel, setOverrideLabel] = useState<string | null>(null);
  const [labelEditing, setLabelEditing] = useState<boolean>(false);
  const [labelDraft, setLabelDraft] = useState<string>('');
  const [labelSavedAt, setLabelSavedAt] = useState<number | null>(null);

  useEffect(() => {
    // Sync seed — get a value on the screen before UA-CH resolves so the
    // section isn't empty for the first paint.
    setAutoLabel(getDeviceLabelSync());
    setOverrideLabel(getDeviceLabelOverride());
    // Then await UA-CH and upgrade the auto value.
    void getDeviceLabel().then((label) => setAutoLabel(label));
  }, []);

  const handleLabelStartEdit = () => {
    setLabelDraft(overrideLabel ?? autoLabel);
    setLabelEditing(true);
  };

  const handleLabelSave = () => {
    const draft = labelDraft.trim();
    if (draft.length === 0) {
      // Empty input → revert to auto.
      clearDeviceLabelOverride();
      setOverrideLabel(null);
    } else {
      setDeviceLabelOverride(draft);
      // Re-read so what we display matches what was actually persisted
      // (sanitize() inside lib/deviceLabel may have trimmed control chars).
      setOverrideLabel(getDeviceLabelOverride());
    }
    setLabelEditing(false);
    setLabelSavedAt(Date.now());
    window.setTimeout(() => setLabelSavedAt(null), 3000);
  };

  const handleLabelRevert = () => {
    clearDeviceLabelOverride();
    setOverrideLabel(null);
    setLabelEditing(false);
    setLabelSavedAt(Date.now());
    window.setTimeout(() => setLabelSavedAt(null), 3000);
  };

  useEffect(() => {
    const refresh = () => {
      if (typeof window === 'undefined') return;
      try {
        setSavedPhoneUrl(window.localStorage.getItem(PHONE_URL_KEY));
      } catch {
        setSavedPhoneUrl(null);
      }
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === PHONE_URL_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const handleForgetSavedPhone = () => {
    try {
      window.localStorage.removeItem(PHONE_URL_KEY);
    } catch {
      /* localStorage may throw in private mode — UI still reflects the intent */
    }
    setSavedPhoneUrl(null);
    setForgetConfirmedAt(Date.now());
    // Auto-clear the confirmation after 3s so it doesn't linger if the user
    // navigates away and back.
    window.setTimeout(() => setForgetConfirmedAt(null), 3000);
  };

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

      {/* Layout — desktop dashboard preset + per-module display options
          (dispatch pixel/layout-settings-phaseA). Self-contained: owns its own
          useLayoutPrefs() lifecycle. */}
      <LayoutSettings />

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
          Connect your phone by entering the IP shown in the ComputerCaller Android
          app on the{' '}
          <Link
            href="/app"
            className="text-blue-600 hover:text-blue-700 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
          >
            dashboard
          </Link>
          .
        </p>

        {/* Saved-phone-IP escape hatch (dispatch #8, 2026-05-22). The webapp
            remembers the last successful LAN address so the input row pre-fills
            on every session. This button is the way to wipe that — useful when
            switching to a different phone, after selling the device, or when
            testing the fresh-pair flow. Hard Reset on the phone itself does NOT
            clear this (it lives in webapp localStorage, not on the phone), so
            this is the only in-app affordance. Subtle styling because it's an
            escape hatch, not a primary action; disabled when there's nothing
            saved so the affordance only surfaces when meaningful. */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-slate-600">Saved phone address</p>
            <p className="text-[11px] text-slate-400 truncate font-mono" title={savedPhoneUrl ?? undefined}>
              {savedPhoneUrl ?? 'No phone saved yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleForgetSavedPhone}
            disabled={!savedPhoneUrl}
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-500 hover:text-red-700 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent disabled:cursor-not-allowed border border-slate-200 hover:border-red-200 disabled:hover:border-slate-200 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
            title={
              savedPhoneUrl
                ? 'Clear the remembered LAN IP so the dashboard input starts blank next session'
                : 'No saved phone address to forget'
            }
            aria-label="Forget saved phone address"
          >
            Forget saved phone
          </button>
        </div>
        {forgetConfirmedAt && (
          <p
            className="mt-2 text-[11px] text-emerald-600"
            role="status"
            aria-live="polite"
          >
            Saved phone cleared.
          </p>
        )}
      </section>

      {/* Device label (dispatch FORGE-1, 2026-05-26) — controls the friendly
          browser-identity string shown on the paired phone's Accept dialog
          when this browser requests pairing. Auto-detected from UA-CH + UA;
          renameable here. Override beats auto. Empty input on Save reverts.
          The new label takes effect on the NEXT pairing request — existing
          paired sessions don't refresh retroactively (the label was sent at
          pairing time and the APK already showed it). */}
      <section
        className="bg-white rounded-2xl border border-slate-200 p-5"
        aria-labelledby="device-label-heading"
      >
        <h2
          id="device-label-heading"
          className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2"
        >
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 text-xs"
          >
            🏷️
          </span>
          This browser
        </h2>
        <p className="text-xs text-slate-500 leading-relaxed">
          The name shown on your phone when you connect from this browser.
        </p>

        {!labelEditing ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p
                className="text-sm font-medium text-slate-800 truncate"
                title={overrideLabel ?? autoLabel}
              >
                {overrideLabel ?? (autoLabel || 'This computer')}
              </p>
              <p className="text-[11px] text-slate-400">
                {overrideLabel
                  ? `Custom — auto-detected: ${autoLabel || 'unknown'}`
                  : 'Auto-detected'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleLabelStartEdit}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
              aria-label="Rename this browser"
            >
              Rename
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleLabelSave();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setLabelEditing(false);
                }
              }}
              maxLength={60}
              placeholder="e.g. Dennis's office laptop"
              autoFocus
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              aria-label="New browser label"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleLabelSave}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setLabelEditing(false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
              >
                Cancel
              </button>
              {overrideLabel && (
                <button
                  type="button"
                  onClick={handleLabelRevert}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-500 hover:text-red-700 hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
                  title="Revert to the auto-detected label"
                >
                  Revert to auto
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400">
              Up to 60 characters. Empty input reverts to auto-detected.
            </p>
          </div>
        )}

        {labelSavedAt && (
          <p
            className="mt-2 text-[11px] text-emerald-600"
            role="status"
            aria-live="polite"
          >
            Browser label updated. Takes effect on the next Connect.
          </p>
        )}
      </section>

      {/* Sign-in & security (dispatch pixel/set-password, 2026-08-22). Only
          rendered when the SERVER told us has-password as a real boolean —
          if the field is absent we show nothing rather than guess which form
          is correct. Set-vs-Change is driven entirely by user.hasPassword. */}
      {typeof user.hasPassword === 'boolean' && (
        <SignInSecuritySection hasPassword={user.hasPassword} />
      )}

      {/* Android companion app — Google Play only. Policy (Dennis,
          2026-07-09): NO APK is ever served from the web; the official
          Play Store listing is the single install path. Listed BEFORE
          Subscription because a user who can't install the app can't
          subscribe meaningfully. Copy is intentionally short and
          outcome-led ("bridge calls + SMS") — the longer setup explanation
          lives on the dashboard's Connect flow, not here. Includes a
          desktop tip since the app has to be installed ON the Android
          device. */}
      <section
        className="bg-white rounded-2xl border border-slate-200 p-5"
        aria-labelledby="android-app-heading"
      >
        <h2
          id="android-app-heading"
          className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2"
        >
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
          Android companion app
        </h2>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          Install on your Android phone to bridge calls and SMS to this
          browser.
        </p>
        <a
          href="https://play.google.com/store/apps/details?id=com.dnkdialer.companion&hl=en"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          Get it on Google Play
        </a>
        <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
          On desktop? Open the Google Play link on your Android phone, or
          search for &ldquo;ComputerCaller&rdquo; in the Play Store. Android
          8.0 or newer.
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
              Subscribe{' '}
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
              Subscribe{' '}
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
