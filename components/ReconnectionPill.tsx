'use client';

import React from 'react';
import { RotateCw, WifiOff } from 'lucide-react';
import { usePhone } from '@/hooks';

/**
 * ReconnectionPill — calm header pill that surfaces transient bridge
 * health states the existing ConnectionStatus does not own:
 *
 *   - "Reconnecting" (amber)  — relay socket dropped (non-terminal close)
 *     and the auto-reconnect backoff is actively retrying. NOT an error;
 *     a few seconds of degraded connectivity is normal on cellular / sleep.
 *   - "Phone unresponsive" (yellow) — relay is up but the phone hasn't
 *     ACKed a ping in >30s. The phone may be locked / dozing — messages
 *     can still queue locally and will deliver when it wakes.
 *
 * The pill RENDERS NULL on healthy states (Connected, lobby). The existing
 * `ConnectionStatus` already paints the green active-pair pill, and a
 * second "Connected" affordance would be redundant noise.
 *
 * Never a modal. Never blocks an action. Stays calm even when degraded —
 * the user's mental model should be "a little patience", not "something
 * broke".
 *
 * Accessibility: aria-live="polite" so screen readers announce the
 * transient transitions WITHOUT preempting the user's current focus.
 */
export function ReconnectionPill() {
  // Defensive read — `bridgeStatus` is added to usePhoneBridge in the same
  // commit as this file, but the cast keeps tsc green if a downstream
  // build picks this up before the hook ships the field.
  const phone = usePhone() as ReturnType<typeof usePhone> & {
    bridgeStatus?: 'connected' | 'reconnecting' | 'phone_unresponsive' | 'idle';
  };
  const status = phone.bridgeStatus ?? 'idle';
  const isPhoneStale = phone.isPhoneStale;

  // Healthy & idle states render nothing — ConnectionStatus owns the green
  // happy-path affordance.
  if (status === 'connected' || status === 'idle') {
    // Defensive: even if `bridgeStatus` is missing, fall back to the
    // legacy `isPhoneStale` flag for the phone-unresponsive surface so
    // the UX doesn't regress mid-rollout.
    if (!isPhoneStale) return null;
    return <PhoneUnresponsivePill />;
  }

  if (status === 'reconnecting') {
    return <ReconnectingPill />;
  }

  if (status === 'phone_unresponsive') {
    return <PhoneUnresponsivePill />;
  }

  return null;
}

function ReconnectingPill() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-2xl shadow-sm"
    >
      <RotateCw
        className="w-3.5 h-3.5 text-amber-700 motion-safe:animate-spin"
        aria-hidden="true"
      />
      <span className="text-xs font-semibold text-amber-900">
        Reconnecting…
      </span>
    </div>
  );
}

function PhoneUnresponsivePill() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 bg-yellow-50 border border-yellow-200 rounded-2xl shadow-sm"
      title="Phone hasn't responded recently — it may be locked or out of range."
    >
      <WifiOff className="w-3.5 h-3.5 text-yellow-700" aria-hidden="true" />
      <span className="text-xs font-semibold text-yellow-900">
        Phone unresponsive
      </span>
    </div>
  );
}
