'use client';

import React, { useState, useEffect } from 'react';
import { Smartphone, XCircle, X, MessageSquare, Bell, ShieldX } from 'lucide-react';
import { usePhone } from '@/hooks';

export const ConnectionStatus = () => {
  const {
    isConnected,
    isBridgeConnected,
    phoneName,
    disconnect,
    isPhoneStale,
    notificationPermissionGranted,
    requestNotificationAccess,
    isAwaitingPhoneAccept,
    phoneAcceptDeclined,
  } = usePhone() as ReturnType<typeof usePhone> & {
    isPhoneStale?: boolean;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccept?: () => void;
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

  // Dispatch #28 (2026-05-24): the manual phone-IP input is GONE. After the
  // SaaS pivot the phone signs into the same account as the browser and
  // auto-dials wss://computercaller.com/relay/phone — there is no IP to
  // type, no LAN to be on. All the inputRow / savedPhoneUrl / showPrefillCue
  // / handleConnect plumbing is deleted. The "waiting for phone" partial
  // state now shows simple instructional copy instead of an input form.

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

  // Dispatch #28: handleConnect + inputRow removed. The user has nothing
  // to type — the phone connects automatically once they sign into the
  // companion app with the same account.

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
  // tapped Decline (or the 30 s auto-decline fired). Dispatch #28: no input
  // row anymore — the phone connects automatically, so we just instruct the
  // user to tap Accept next time.
  if (phoneAcceptDeclined) {
    return (
      <>
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
                Open ComputerCaller on your phone and tap Accept on the notification.
              </span>
            </div>
          </div>
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
              Server ✓
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Phone paired
            </span>
          </div>
          <div className="h-6 w-px bg-slate-200" />
          <button
            onClick={() => {
              // Dispatch #9: Disconnect from the green pill ALSO refreshes the
              // page. Rationale: the relay WS close frame (DISCONNECT_PHONE)
              // tears down the room cleanly, but the browser side is still
              // holding a mountain of in-memory state (cached threads,
              // contacts, message buffers, sync timers, derived memos). A
              // hard reload is the simplest, surest way to land back at a
              // clean "ready to pair" surface — no stale callbacks, no
              // half-flushed message buffer, no leaked subscriptions. The
              // 150 ms timeout gives the WS close frame time to flush over
              // the TCP socket before the reload kills the JS context; with
              // a 0 ms timeout the room teardown sometimes races the page
              // navigation and the relay logs the browser as TCP-disconnect
              // (~30 s reaper) instead of clean DISCONNECT_PHONE.
              disconnect();
              setTimeout(() => window.location.reload(), 150);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-red-100 hover:text-red-700 text-slate-500 text-xs font-medium rounded-lg transition-colors"
            title="Disconnect phone and refresh page"
          >
            <XCircle className="w-3.5 h-3.5" />
            Disconnect
          </button>
        </div>
      </>
    );
  }

  // Partial / disconnected state. Dispatch #28: the user does NOT type a
  // phone address. Either the phone is on this account and will pop into
  // the room automatically once they open the companion app, or it isn't
  // installed yet. Copy reflects that — single calm message, no input form,
  // no amber-pill / errorPill distinction (a relay drop now silently retries
  // per dispatch #27, so there's no actionable "connection failed" state to
  // expose here either).
  const subline = isPhoneStale
    ? 'Phone unresponsive — reconnecting…'
    : 'Open ComputerCaller on your phone and sign in.';
  const headline = isPhoneStale
    ? 'Phone disconnected'
    : 'Waiting for phone…';

  return (
    <>
      {notificationBanner}
      <div
        className="flex items-center gap-3 px-5 py-2 bg-slate-50/70 backdrop-blur-md rounded-2xl border border-slate-200/70 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center border border-slate-300">
          <Smartphone className="w-4 h-4 text-slate-600" aria-hidden="true" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-slate-800">{headline}</span>
          <span className="text-[11px] text-slate-500">{subline}</span>
        </div>
      </div>
    </>
  );
};
