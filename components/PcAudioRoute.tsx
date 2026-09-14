'use client';

import React from 'react';
import clsx from 'clsx';
import { Loader2, Monitor, X } from 'lucide-react';
import { usePhone } from '@/hooks';
import type { AudioRouteStatus } from '@/hooks/phoneTypes';
import {
  readAudioSourceDefault,
  useAudioSourceDefault,
  writeAudioSourceDefault,
} from '@/hooks/audioSourcePreference';
import type { AudioSource } from '@/hooks/audioSourcePreference';

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

/**
 * CP3-A (2026-09-14). Picking a call-audio destination is ONE action, not two.
 *
 * Before CP3-A, choosing "PC Audio" in Settings wrote localStorage and nothing
 * else; establishing the route needed a second, separate click on the header
 * Connect button. Two controls, one intent — users reasonably read the picker
 * as "use my PC now" and got silence.
 *
 * `usePcAudioSelection` is the single place that couples the two: it writes the
 * shared default AND drives the same `connectPcAudio()` / `disconnectPcAudio()`
 * probe the header button uses. It is NOT wired into the in-call path — the
 * call-start forward in Dashboard.tsx still owns SET_AUDIO_SOURCE and is
 * untouched.
 */
export interface PcAudioSelection {
  /** The shared default destination (localStorage-backed, cross-surface). */
  source: AudioSource;
  /** Live route state, for rendering. */
  status: AudioRouteStatus;
  bridgeConnected: boolean;
  /** Persist the choice and act on it in the same gesture. */
  select: (next: AudioSource) => void;
}

export function usePcAudioSelection(): PcAudioSelection {
  const { status, bridgeConnected, connect, disconnect } = usePcAudioRoute();
  const [source, setSource] = useAudioSourceDefault();

  // `status` and `bridgeConnected` are read through a ref inside `select` so the
  // callback identity stays stable across every route-state change — a picker
  // button should not re-render on each AUDIO_STATUS frame.
  // Written in an effect, not during render: React 19 treats render-phase ref
  // mutation as impure. A click can only happen after commit, so the ref is
  // never stale by the time `select` reads it.
  const liveRef = React.useRef({ status, bridgeConnected });
  React.useEffect(() => {
    liveRef.current = { status, bridgeConnected };
  }, [status, bridgeConnected]);

  const select = React.useCallback(
    (next: AudioSource) => {
      setSource(next);
      const { status: s, bridgeConnected: online } = liveRef.current;
      // No phone on the other end: the preference is still recorded, but a
      // probe could only ever time out, so we don't fire one. Same rule the
      // Connect button follows (`disabled = !bridgeConnected`).
      if (!online) return;
      if (next === 'pc') {
        // Already up or already negotiating — a second probe would supersede
        // the first and restart the watchdogs for nothing.
        if (s.state === 'connected' || s.state === 'connecting') return;
        connect();
      } else if (s.state === 'connected' || s.state === 'connecting') {
        // Choosing Phone tears the PC route down, so the header can never read
        // "connected" while the default says phone.
        disconnect();
      }
    },
    [setSource, connect, disconnect]
  );

  return { source, status, bridgeConnected, select };
}

/**
 * A probe the user confirmed is evidence the PC route works, so it promotes
 * itself to the default — the "connect once, it sticks" behaviour.
 *
 * Fires at most once per probeId, and only when the default is not already
 * 'pc', so the second mounted copy of this control (header + Settings inline)
 * is a no-op rather than a duplicate write.
 */
function usePromoteConfirmedRouteToDefault(status: AudioRouteStatus): void {
  const promotedProbeRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (status.state !== 'connected') return;
    const probeId = status.probeId ?? 'unkeyed';
    if (promotedProbeRef.current === probeId) return;
    promotedProbeRef.current = probeId;
    if (readAudioSourceDefault() !== 'pc') writeAudioSourceDefault('pc');
  }, [status.state, status.probeId]);
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
  usePromoteConfirmedRouteToDefault(status);

  // An explicit teardown is an explicit "not on my PC" — it hands the default
  // back to the phone so the picker and the route agree. (The promotion above
  // is the mirror image: a confirmed probe claims the default.)
  const handleDisconnect = React.useCallback(() => {
    writeAudioSourceDefault('phone');
    disconnect();
  }, [disconnect]);

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
          onClick={handleDisconnect}
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
