'use client';

import React, { useState, useEffect } from 'react';
import { Smartphone, Loader2, RefreshCw, AlertTriangle, XCircle, ServerCrash, X, MessageSquare } from 'lucide-react';
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
    notificationPermissionGranted,
    requestNotificationAccess,
  } = usePhone() as ReturnType<typeof usePhone> & {
    isRelayOffline?: boolean;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccess?: () => void;
  };

  const [phoneIp, setPhoneIp] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [savedPhoneUrl, setSavedPhoneUrl] = useState<string | null>(null);

  // Read the last-used phone URL on mount so we can offer a one-click reconnect.
  useEffect(() => {
    const saved = localStorage.getItem('dnkdialer_phone_url');
    setSavedPhoneUrl(saved);
  }, []);
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

  const handleRetry = () => {
    // Try to reconnect using the last saved URL
    const savedUrl = localStorage.getItem('dnkdialer_phone_url');
    if (savedUrl) {
      connectPhone(savedUrl);
    } else {
      setShowInput(true);
    }
  };

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

  // Connected state
  if (isConnected) {
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

  // Manual IP input state
  if (showInput) {
    return (
      <>
        {relayBanner}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={phoneIp}
            onChange={(e) => setPhoneIp(e.target.value)}
            placeholder="Phone IP (192.168.x.x)"
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <button
            onClick={() => {
              if (phoneIp) {
                connectPhone(phoneIp);
                setShowInput(false);
              }
            }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            Connect
          </button>
          <button
            onClick={() => setShowInput(false)}
            className="px-3 py-2 text-slate-500 text-sm hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      </>
    );
  }

  // Intermediate "syncing" state — relay open, waiting for phone data.
  const showSyncing = isBridgeConnected && !isConnected && !isRelayOffline && !connectionError;

  return (
    <>
      {relayBanner}
      <div className="flex items-center gap-2">
        {showSyncing && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-xl"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" aria-hidden="true" />
            <span className="text-xs text-blue-800 font-medium">Syncing phone data...</span>
          </div>
        )}

        {connectionError && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-xs text-amber-800 font-medium max-w-[140px] truncate">Connection failed</span>
            <button
              onClick={handleRetry}
              className="p-1 hover:bg-amber-100 rounded-md transition-colors"
              title="Retry connection"
              aria-label="Retry connection"
            >
              <RefreshCw className="w-3.5 h-3.5 text-amber-600" />
            </button>
          </div>
        )}

        {savedPhoneUrl ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => { connectPhone(savedPhoneUrl); setSavedPhoneUrl(savedPhoneUrl); }}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors"
              title={`Reconnect to ${savedPhoneUrl}`}
            >
              <Smartphone className="w-4 h-4" />
              <span>Reconnect</span>
            </button>
            <button
              onClick={() => { setSavedPhoneUrl(null); setShowInput(true); }}
              className="px-3 py-2 text-slate-400 hover:text-slate-600 text-xs rounded-lg transition-colors"
              title="Use a different IP"
            >
              different IP
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowInput(true)}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors"
            title="Enter your phone's IP address manually"
          >
            <Smartphone className="w-4 h-4" />
            <span>IP</span>
          </button>
        )}
      </div>
    </>
  );
};
