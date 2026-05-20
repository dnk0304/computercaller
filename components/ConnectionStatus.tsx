'use client';

import React, { useState, useEffect } from 'react';
import { Smartphone, RefreshCw, AlertTriangle, XCircle, ServerCrash, X, MessageSquare, Bell, ShieldX } from 'lucide-react';
import { usePhone } from '@/hooks';

export const ConnectionStatus = () => {
  const {
    isConnected,
    isBridgeConnected,
    phoneName,
    connectPhone,
    disconnect,
    connectionError,
    isRelayOffline,
    isPhoneStale,
    notificationPermissionGranted,
    requestNotificationAccess,
    isAwaitingPhoneAccept,
    phoneAcceptDeclined,
  } = usePhone() as ReturnType<typeof usePhone> & {
    isRelayOffline?: boolean;
    isPhoneStale?: boolean;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccess?: () => void;
    isAwaitingPhoneAccept?: boolean;
    phoneAcceptDeclined?: boolean;
  };

  // True when both halves of the connection are healthy — relay WS open AND
  // phone present in our room (and not stale). This is the ONLY state where
  // the top-level indicator shows the cheerful "Phone Connected" green pill.
  // Anything less means the user can't actually send/receive, and the UI must
  // say so explicitly instead of silently lying.
  const isFullyHealthy = isBridgeConnected && isConnected && !isPhoneStale;

  // Controlled input for the manual phone URL. Always rendered (in every
  // connection state) so the user can swap IPs without first having to
  // disconnect. Pre-filled from localStorage on mount and resynced when the
  // saved URL changes (e.g. after a successful connect updates it). Empty
  // string with a placeholder is the default — never hardcode an IP, since the
  // user's phone address varies and a pre-filled wrong value is misleading.
  const [savedPhoneUrl, setSavedPhoneUrl] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('dnkdialer_phone_url');
    setSavedPhoneUrl(saved);
    if (saved) setInputValue(saved);
  }, []);

  // Keep the input in sync if the saved URL changes underneath us (e.g. a
  // successful connect from elsewhere persisted a new value).
  useEffect(() => {
    if (savedPhoneUrl && savedPhoneUrl !== inputValue) {
      setInputValue(savedPhoneUrl);
    }
    // We intentionally omit `inputValue` from deps — we only want to react
    // when the savedPhoneUrl source-of-truth changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedPhoneUrl]);

  const [relayBannerDismissed, setRelayBannerDismissed] = useState(false);
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false);

  // Auto-hide the notification-access banner once the phone reports access has
  // been granted (user returned from Android Settings). The banner's render
  // guard requires `granted === false`, so flipping to `true` already hides it;
  // setting the dismissed flag here as well covers the case where the user
  // briefly toggles permission off again — they'd start fresh on next connect
  // anyway since the disconnect handler resets both pieces of state.
  useEffect(() => {
    if (notificationPermissionGranted === true) {
      setNotifBannerDismissed(true);
    }
  }, [notificationPermissionGranted]);

  const handleConnect = () => {
    const v = inputValue.trim();
    if (!v) return;
    connectPhone(v);
    // Optimistically refresh savedPhoneUrl from storage shortly after — the
    // connectPhone flow persists it, and re-reading keeps the input synced for
    // the next render cycle without a full reload.
    setTimeout(() => {
      const fresh = localStorage.getItem('dnkdialer_phone_url');
      if (fresh) setSavedPhoneUrl(fresh);
    }, 50);
  };

  // Manual-IP input row. PREVIOUSLY this was a sub-component defined inside
  // the parent — every keystroke triggered a parent re-render, which produced
  // a new function reference for the sub-component, which React treats as a
  // different component type → unmounts the old <input> and mounts a new one
  // each render → focus is lost after every character. Classic React anti-pattern.
  //
  // Fix: render the JSX directly via a stable variable (not a function). The
  // input is the same DOM node across renders, focus persists.
  const inputRow = (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleConnect();
        }}
        placeholder="e.g. 192.168.1.42:8765"
        aria-label="Phone IP address"
        className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-56"
      />
      <button
        type="button"
        onClick={handleConnect}
        disabled={!inputValue.trim()}
        className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
        title="Connect to this phone IP"
      >
        <Smartphone className="w-4 h-4" aria-hidden="true" />
        Connect
      </button>
    </div>
  );

  // The relay-offline banner is rendered as a fixed top-of-page notice, since
  // ConnectionStatus lives inside a small header slot. Position it relative to
  // the viewport so it cannot be clipped by the header's overflow.
  const relayBanner =
    isRelayOffline && !relayBannerDismissed ? (
      <div
        role="alert"
        aria-live="polite"
        className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] w-[min(640px,calc(100%-1.5rem))]"
      >
        <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 border border-amber-300 rounded-2xl shadow-lg shadow-amber-100/50 backdrop-blur-sm">
          <div className="w-9 h-9 rounded-xl bg-amber-100 border border-amber-200 flex items-center justify-center flex-shrink-0">
            <ServerCrash className="w-4.5 h-4.5 text-amber-700" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              Bridge server not running
            </p>
            <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
              Start it with{' '}
              <code className="px-1.5 py-0.5 bg-amber-100 border border-amber-200 rounded font-mono text-[11px] text-amber-900">
                npm run dev
              </code>{' '}
              <span className="text-amber-700">(auto-starts)</span> or{' '}
              <code className="px-1.5 py-0.5 bg-amber-100 border border-amber-200 rounded font-mono text-[11px] text-amber-900">
                npm run relay
              </code>
            </p>
          </div>
          <button
            onClick={() => setRelayBannerDismissed(true)}
            className="p-1.5 -m-1 text-amber-700 hover:text-amber-900 hover:bg-amber-100 rounded-lg transition-colors flex-shrink-0"
            aria-label="Dismiss bridge server notice"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    ) : null;

  // Notification-access banner. Rendered as a fixed-position notice (mirroring
  // the relay banner pattern) so it's never clipped by header overflow. Only
  // visible when phone is connected AND has reported permission as not granted.
  const notificationBanner =
    isConnected && notificationPermissionGranted === false && !notifBannerDismissed ? (
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[90] w-[min(560px,calc(100%-1.5rem))]">
        <div className="flex items-start gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl shadow-md">
          <MessageSquare className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-900">Enable RCS & notification sync</p>
            <p className="text-xs text-blue-700 mt-0.5">Grant notification access to receive RCS and Google Messages in real time.</p>
          </div>
          <button
            onClick={() => requestNotificationAccess?.()}
            className="flex-shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Enable on phone
          </button>
          <button
            onClick={() => setNotifBannerDismissed(true)}
            aria-label="Dismiss"
            className="flex-shrink-0 p-1 text-blue-400 hover:text-blue-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    ) : null;

  // Awaiting Accept on the phone. Sits between "Connecting" and "Connected"
  // — the relay's outbound WS is open but the phone is showing the user an
  // Accept/Decline notification. This is its own state because UX-wise the
  // user needs concrete guidance ("check your phone") that neither a generic
  // spinner nor a "Connecting…" pill conveys. Renders with priority over
  // the partial-connection amber state so the user isn't told "relay only"
  // when in fact the phone is actively prompting them.
  if (isAwaitingPhoneAccept) {
    return (
      <>
        {relayBanner}
        <div
          className="flex items-center gap-3 px-5 py-2 bg-blue-50/70 backdrop-blur-md rounded-2xl border border-blue-200/70 shadow-sm"
          role="status"
          aria-live="polite"
        >
          <div className="relative w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center border border-blue-200">
            <Bell className="w-4 h-4 text-blue-700" aria-hidden="true" />
            {/* Subtle pulse to reinforce "active waiting" without
                animating an icon (which would be distracting). */}
            <span
              className="absolute inset-0 rounded-full border-2 border-blue-400/60 animate-ping motion-reduce:hidden"
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-blue-900">
              Waiting for phone to accept connection…
            </span>
            <span className="text-[11px] text-blue-700">
              Check your phone — tap Accept on the notification.
            </span>
          </div>
        </div>
      </>
    );
  }

  // Phone explicitly declined the most recent connection attempt. The user
  // tapped Decline (or the 30 s auto-decline fired). Render an actionable
  // pill with the input row so the user can retry against the same IP
  // (most common cause is the user dismissed the notification by accident).
  if (phoneAcceptDeclined) {
    return (
      <>
        {relayBanner}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 px-5 py-2 bg-red-50/70 backdrop-blur-md rounded-2xl border border-red-200/70 shadow-sm">
            <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center border border-red-200">
              <ShieldX className="w-4 h-4 text-red-700" aria-hidden="true" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-red-900">
                Phone declined the connection
              </span>
              <span className="text-[11px] text-red-700">
                Try again and tap Accept on your phone.
              </span>
            </div>
          </div>
          {inputRow}
        </div>
      </>
    );
  }

  // Fully healthy — relay open + phone in room + not stale. This is the only
  // path that renders the "Phone Connected" green pill. The manual IP input is
  // intentionally NOT shown here — when the user is connected we want a clean,
  // calm pill; swapping IPs requires Disconnect first, which is the explicit
  // path the user asked for.
  if (isFullyHealthy) {
    return (
      <>
        {relayBanner}
        {notificationBanner}
        <div className="flex items-center gap-4 px-5 py-2 bg-white/50 backdrop-blur-md rounded-2xl border border-slate-200/60 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center border border-emerald-100">
              <Smartphone className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-slate-700">{phoneName || 'Phone Connected'}</span>
              <span className="text-xs text-emerald-600 font-medium">Ready</span>
            </div>
          </div>
          {/* Two sub-pills make the source of truth explicit even when green.
              A glance tells the user "yes, relay AND phone are both up". */}
          <div className="hidden md:flex items-center gap-1.5" role="status" aria-label="Connection details">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Relay ✓
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Phone paired
            </span>
          </div>
          <div className="h-6 w-px bg-slate-200" />
          <button
            onClick={() => disconnect()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-red-100 hover:text-red-700 text-slate-500 text-xs font-medium rounded-lg transition-colors"
            title="Disconnect phone"
          >
            <XCircle className="w-3.5 h-3.5" />
            Disconnect
          </button>
        </div>
      </>
    );
  }

  // Partial-connection state: relay is up but phone is missing OR stale.
  // Render an amber pill so the user knows clearly that "Connected" is a lie
  // — messages they send right now will not be delivered. This used to show
  // a misleading green "Connected" dot even when the phone wasn't paired,
  // which is the entire false-connection bug class this UI is fixing.
  if (isBridgeConnected && !connectionError && !isRelayOffline) {
    // Phone-pill label depends on whether we ever saw the phone (isConnected
    // would be true at some point) or just relay-only the whole time.
    const phoneLabel = isPhoneStale ? 'stale — reconnecting…' : 'waiting…';
    const topLabel = isPhoneStale
      ? 'Phone unresponsive — reconnecting'
      : 'Relay only — phone not paired';
    // Amber state means relay is up but no phone is paired. From the user's POV
    // this IS the "disconnected" state where they want to (re)pair. The LAN-IP
    // input row is the single connection affordance — pre-filled with the last
    // `savedPhoneUrl` so a single Enter / Connect re-pairs.
    return (
      <>
        {relayBanner}
        {notificationBanner}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 px-5 py-2 bg-amber-50/70 backdrop-blur-md rounded-2xl border border-amber-200/70 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center border border-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-700" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-amber-900">{topLabel}</span>
                <span className="text-[11px] text-amber-700">Enter your phone IP to reconnect</span>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-1.5" role="status" aria-label="Connection details">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                Relay ✓
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 border border-amber-300 text-[10px] font-medium text-amber-800 uppercase tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                Phone: {phoneLabel}
              </span>
            </div>
          </div>
          {inputRow}
        </div>
      </>
    );
  }

  // Disconnected / error fallthrough. LAN-IP input is the single connection
  // affordance for every auth state — typing the IP the phone is showing and
  // hitting Connect is the entire pairing model.
  //
  // If there's an explicit connection error we surface a small amber pill
  // alongside the input so the user knows the last attempt failed.
  const errorPill = connectionError ? (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl">
      <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" aria-hidden="true" />
      <span className="text-xs text-amber-800 font-medium max-w-[140px] truncate">Connection failed</span>
      <RefreshCw className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />
    </div>
  ) : null;

  return (
    <>
      {relayBanner}
      <div className="flex items-center gap-2">
        {errorPill}
        {inputRow}
      </div>
    </>
  );
};
