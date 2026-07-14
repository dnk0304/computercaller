'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { usePhone } from '@/hooks';

/**
 * NotConnectedBanner — loud, persistent "you will miss calls" state.
 *
 * WHY (Dennis, 2026-07-14): his browser tab was open and *looked* connected
 * for 95 minutes while it actually sat UNPAIRED in the relay lobby — so every
 * frame of a real incoming call was dropped and he never knew. The old
 * unpaired state was too quiet. This banner makes the unpaired state
 * unmissable.
 *
 * STATE WIRING (Forge owns this; Pixel owns final visual polish — see résumé):
 * the banner keys off the AUTHORITATIVE lobby/pair state from usePhone():
 *   - `lobbyState === 'active'` is the ONLY connected state. Anything else
 *     ('lobby' | 'requesting' | 'declined' | 'timeout' | 'rejected') means the
 *     browser is NOT in an active pair → we WILL miss calls → show the banner.
 *   - While `requesting`, we soften to a "connecting…" note rather than the
 *     full alarm (a handshake is genuinely in flight).
 *
 * With permanent known-device relink shipped (Part 2a), the both-present case
 * auto-heals and this banner will clear itself; it still fires for genuinely
 * unpaired states (phone actually gone / Disconnected).
 *
 * Reconnect affordance:
 *   - phone present in lobby → a live "Reconnect now" button (requestPairing).
 *   - phone absent → guidance to open the app on the phone (nothing to click).
 */
export function NotConnectedBanner() {
  const phone = usePhone() as unknown as {
    lobbyState?: string;
    phonePresentInLobby?: boolean;
    requestPairing?: () => void;
  };
  const lobbyState = phone.lobbyState ?? 'lobby';
  const phonePresent = !!phone.phonePresentInLobby;
  const requestPairing = phone.requestPairing;

  // Connected — render nothing.
  if (lobbyState === 'active') return null;

  const isConnecting = lobbyState === 'requesting';

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={
        isConnecting
          ? 'flex-shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-amber-100 text-amber-900 text-sm font-medium border-b border-amber-200'
          : 'flex-shrink-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2.5 bg-rose-600 text-white text-sm font-semibold border-b border-rose-700 shadow-sm'
      }
    >
      {isConnecting ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" aria-hidden="true" />
          <span>Connecting to your phone…</span>
        </>
      ) : (
        <>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span>NOT CONNECTED — you will miss calls and messages.</span>
          {phonePresent && typeof requestPairing === 'function' ? (
            <button
              type="button"
              onClick={() => requestPairing()}
              className="inline-flex items-center gap-1 rounded-md bg-white/95 px-2.5 py-1 text-rose-700 text-xs font-bold hover:bg-white active:scale-95 transition"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              Reconnect now
            </button>
          ) : (
            <span className="text-xs font-medium text-rose-100">
              Open ComputerCaller on your phone to reconnect.
            </span>
          )}
        </>
      )}
    </div>
  );
}
