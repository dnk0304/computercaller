'use client';

import React from 'react';
import clsx from 'clsx';
import { Loader2, Monitor, X } from 'lucide-react';
import { usePhone } from '@/hooks';
import type { AudioRouteStatus } from '@/hooks/phoneTypes';

/**
 * The one renderer for "is call audio actually on the Bluetooth link to this PC?"
 *
 * CP2 (2026-09-08). Three surfaces show this state — the app header, the
 * Settings → Call Audio card, and the in-call Audio Source toggle — and all
 * three render THIS component. There is deliberately no second copy of the
 * four-state logic or of the failure copy: a header that says "connected"
 * while Settings says "Bluetooth is off" is the exact bug this consolidation
 * exists to prevent.
 *
 * State comes from `audioRouteStatus` on the phone bridge (Forge, ae589df).
 * 'idle' is the RESTING state — before a probe, after an explicit disconnect,
 * and after the phone drops off. It is never rendered as a failure.
 */

/** User-facing failure copy. Each line names what happened and, where the user
 *  can act, implies where. `sco_denied` deliberately does not say "try again":
 *  an OEM (Oppo, in the field report) can refuse the SCO link permanently, and
 *  telling someone to retry something that structurally cannot succeed is worse
 *  than telling them nothing. The Retry control stays available regardless —
 *  it just isn't presented as the answer. */
const FAILURE_COPY: Record<NonNullable<AudioRouteStatus['reason']>, string> = {
  bt_off: 'Bluetooth is off on your phone',
  not_paired: "Your phone isn't paired with this PC",
  permission_missing: 'The phone app needs Bluetooth permission',
  sco_denied: 'Your phone refused the Bluetooth audio link',
  route_lost: 'Bluetooth audio dropped',
  timeout: 'No reply from your phone',
};

const FAILURE_FALLBACK = "Couldn't route audio to this PC";

/** Defensive read of the CP2 surface. The bridge's exported type is wider than
 *  the codegen'd consumer shape in some builds — same cast pattern the rest of
 *  the dashboard uses for `setAudioSource`. */
interface PcAudioBridge {
  status: AudioRouteStatus;
  bridgeConnected: boolean;
  connect: () => void;
  disconnect: () => void;
}

const IDLE_STATUS: AudioRouteStatus = {
  state: 'idle',
  device: null,
  transport: null,
  reason: null,
  probeId: null,
};

export function usePcAudioRoute(): PcAudioBridge {
  const phone = usePhone();
  const bridge = phone as unknown as {
    audioRouteStatus?: AudioRouteStatus;
    connectPcAudio?: () => void;
    disconnectPcAudio?: () => void;
    isConnected?: boolean;
  };
  return {
    status: bridge.audioRouteStatus ?? IDLE_STATUS,
    bridgeConnected: bridge.isConnected ?? false,
    connect: bridge.connectPcAudio ?? (() => {}),
    disconnect: bridge.disconnectPcAudio ?? (() => {}),
  };
}

/** Plain-text description of the current route, for tooltips, aria-labels and
 *  anywhere a caller needs the state as a string rather than as markup. */
export function describeAudioRoute(status: AudioRouteStatus, bridgeConnected: boolean): string {
  if (!bridgeConnected) return 'PC audio unavailable — your phone is not connected';
  switch (status.state) {
    case 'connecting':
      return 'Connecting to your PC…';
    case 'connected':
      return `Connected — ${status.device || 'your PC'} · Bluetooth${
        status.transport ? ` (${status.transport})` : ''
      }`;
    case 'failed':
      return status.reason ? FAILURE_COPY[status.reason] : FAILURE_FALLBACK;
    case 'idle':
    default:
      return 'PC audio: not connected';
  }
}

type Tone = 'neutral' | 'busy' | 'good' | 'bad';

const DOT_TONE: Record<Tone, string> = {
  neutral: 'bg-slate-300',
  busy: 'bg-blue-500',
  good: 'bg-emerald-500',
  bad: 'bg-red-500',
};

const HEADER_TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 border-slate-200 text-slate-600',
  busy: 'bg-blue-50 border-blue-200 text-blue-700',
  good: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  bad: 'bg-red-50 border-red-200 text-red-700',
};

const INLINE_TONE: Record<Tone, string> = {
  neutral: 'bg-slate-50 border-slate-200 text-slate-600',
  busy: 'bg-blue-50 border-blue-200 text-blue-700',
  good: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  bad: 'bg-red-50 border-red-200 text-red-700',
};

function toneFor(status: AudioRouteStatus, bridgeConnected: boolean): Tone {
  if (!bridgeConnected) return 'neutral';
  switch (status.state) {
    case 'connecting':
      return 'busy';
    case 'connected':
      return 'good';
    case 'failed':
      return 'bad';
    default:
      return 'neutral';
  }
}

export interface PcAudioRouteProps {
  /**
   * `header` — compact pill for the sticky app header. Label truncates and
   *   collapses to the icon on narrow viewports; the full sentence stays
   *   available as the accessible name and the tooltip.
   * `inline` — full-width status line for Settings and the in-call card.
   */
  variant?: 'header' | 'inline';
  className?: string;
}

/**
 * Four-state PC-audio route control: idle / connecting / connected / failed.
 * Usable outside a call — connecting the route is a setup step, not a call
 * action, which is why it lives in the header.
 */
export const PcAudioRoute: React.FC<PcAudioRouteProps> = ({ variant = 'header', className }) => {
  const { status, bridgeConnected, connect, disconnect } = usePcAudioRoute();
  const tone = toneFor(status, bridgeConnected);
  const label = describeAudioRoute(status, bridgeConnected);
  const isHeader = variant === 'header';

  // No phone on the other end: show the state, offer nothing. Firing a probe
  // at a bridge with no peer can only ever time out, so the control goes quiet
  // rather than inviting a guaranteed failure.
  const disabled = !bridgeConnected;

  const showConnect = !disabled && (status.state === 'idle' || status.state === 'failed');
  const showDisconnect = !disabled && status.state === 'connected';
  const connectLabel = status.state === 'failed' ? 'Retry' : 'Connect';

  const actionClasses = clsx(
    'flex-shrink-0 rounded-md font-semibold transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1',
    isHeader ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
    status.state === 'failed'
      ? 'bg-red-600 text-white hover:bg-red-700'
      : 'bg-blue-600 text-white hover:bg-blue-700'
  );

  return (
    <div
      className={clsx(
        'inline-flex items-center border',
        isHeader
          ? ['gap-2 rounded-full px-2.5 py-1', HEADER_TONE[tone]]
          : ['w-full gap-2.5 rounded-lg px-3 py-2', INLINE_TONE[tone]],
        className
      )}
    >
      {status.state === 'connecting' ? (
        <Loader2
          className={clsx('flex-shrink-0 animate-spin motion-reduce:animate-none', isHeader ? 'w-3.5 h-3.5' : 'w-4 h-4')}
          aria-hidden="true"
        />
      ) : isHeader ? (
        <span className={clsx('flex-shrink-0 w-2 h-2 rounded-full', DOT_TONE[tone])} aria-hidden="true" />
      ) : (
        <Monitor className="flex-shrink-0 w-4 h-4" aria-hidden="true" />
      )}

      {/* The visible label truncates in the header; the full sentence is always
          the accessible name, so a screen reader never gets the clipped copy.
          `role="status"` announces route changes without stealing focus. */}
      <span
        role="status"
        aria-label={label}
        title={label}
        className={clsx(
          'truncate font-medium',
          isHeader ? 'text-xs max-w-[9rem] hidden sm:inline' : 'text-xs flex-1 min-w-0'
        )}
      >
        {label}
      </span>

      {showConnect && (
        <button
          type="button"
          onClick={connect}
          title={status.state === 'failed' ? 'Try connecting PC audio again' : 'Connect PC audio'}
          className={actionClasses}
        >
          {connectLabel}
        </button>
      )}

      {showDisconnect && (
        <button
          type="button"
          onClick={disconnect}
          aria-label="Disconnect PC audio"
          title="Disconnect PC audio"
          className={clsx(
            'flex-shrink-0 rounded-md p-1 text-emerald-700 transition-colors hover:bg-emerald-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1'
          )}
        >
          <X className={isHeader ? 'w-3 h-3' : 'w-3.5 h-3.5'} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default PcAudioRoute;
