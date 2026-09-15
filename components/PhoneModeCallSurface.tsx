'use client';

/**
 * PhoneModeCallSurface — the in-call surface for every Phone Mode shell:
 * the Chrome extension (dispatch PIXEL-F) and /app's mobile-web Phone Mode
 * (dispatch PIXEL-H, 2026-09-15). One component, one hook, no fork.
 *
 * THE BUG THIS EXISTS TO FIX
 * Dennis: "Once I dialed a number it didn't show that I was actually in a
 * call/calling on my phone. Which means I also couldn't hang up from the
 * extension." The call genuinely went out — `usePhone().currentCall` was
 * populated the whole time. Nothing on the Phone Mode surface consumed it.
 *
 * The only in-call UI in production is `CallSessionView` inside
 * `GlobalDialer`, and GlobalDialer renders its card ONLY while its floating
 * panel `isOpen`. The panel auto-opens for `state === 'ringing'` (incoming)
 * and nothing else; an OUTGOING call runs dialing → active → null without ever
 * opening it. On the DESKTOP dashboard that is invisible, because the user
 * dialled from inside the already-open panel. But neither Phone Mode shell
 * dials through that panel — the extension's ExtDialerView and /app's
 * DialerView both call `makeCall` without touching `useDialerOpen()` — so
 * there was no panel, and therefore no card and no End button on either.
 *
 * WHY THIS IS SURFACE-AGNOSTIC
 * Nothing below reads the surface. The extension's 0.8x density comes from the
 * `.cc-ext` class on the shell wrapper, which /app never sets, so the exact
 * same markup renders at the extension's 0.8x and at /app's 1.0x with no
 * branch here and no `.cc-ext` token leaking into /app.
 *
 * TWO SHAPES, ONE CALL (Dennis 2026-09-15, superseding §4.6/§4.7's takeover)
 * "Now being in a call disables checking texts, call history, alerts etc. It
 * should function the same way it does inside of the dashboard in the quick
 * dial." He is right: on the desktop dashboard a live call lives in a small
 * floating panel and the whole app stays usable behind it. A phone-width shell
 * that blanks the body for the duration of the call is strictly worse than the
 * dashboard it is meant to mirror. So:
 *
 *   'takeover' — an INCOMING call that is still ringing (and the 1.4 s
 *                "Message sent" tail after a quick reply). Answer / Decline /
 *                Reply is a decision that wants the screen, and the dashboard
 *                does the same thing: the panel auto-opens over the app.
 *   'banner'   — anything already connected or on its way out: dialing and
 *                active. A compact strip between the header and the tab strip.
 *                Tab strip, usage strip and the active view stay live, so the
 *                user can read a text or check the log mid-call.
 *   'hidden'   — no call.
 *
 * WHY A HOOK + A COMPONENT RATHER THAN ONE COMPONENT
 * The shell needs to know WHICH shape before it renders, because a takeover
 * hides the tab strip and a banner does not. `mode` and the surface's own
 * state must be the same state — including the "Message sent" window, during
 * which `currentCall` is already null but the confirmation is still on screen.
 * Two independent reads would let the tab strip snap back mid-confirmation.
 *
 * NOTHING IS FORKED. `CallSessionView` and `CallQueue` are imported from
 * GlobalDialer. The behaviours below (local 1 s duration tick, the quick-reply
 * sent-notice snapshot, `endCall` targeting the foreground call only) mirror
 * GlobalDialer's exactly, so the surfaces cannot drift on call semantics.
 *
 * GlobalDialer does not run alongside these: `GlobalDialerMount`
 * unmounts it for the whole of Phone Mode (see that file), so one call can
 * never own two UIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePhone } from '@/hooks';
import { CallQueue, CallSessionView, formatDuration } from '@/components/GlobalDialer';
import type { CallInfo } from '@/hooks/phoneTypes';

/**
 * How long the "Message sent" confirmation stays on screen after a quick
 * reply, once `declineWithMessage` has already cleared the call. Same constant
 * as GlobalDialer's and CallModal's — a shorter one here would make the same
 * action feel different on the two surfaces.
 */
const SENT_NOTICE_MS = 1400;

interface SentNotice {
  body: string;
  number: string;
  name?: string;
}

/** Everything `<PhoneModeCallSurface />` needs. Built by the hook below. */
export interface PhoneModeCallSurfaceProps {
  calls: CallInfo[];
  currentCall: CallInfo | null;
  waitingCall: CallInfo | null;
  /** Seconds since the active call connected. Ticks locally, once a second. */
  duration: number;
  sentNotice: SentNotice | null;
  onAnswer: () => void;
  onEnd: () => void;
  onQuickReply: (to: string, body: string, displayName?: string) => void;
  onSendSms: (to: string, body: string) => void;
}

/**
 * How the live call should be shown. See the "TWO SHAPES, ONE CALL" note at
 * the top of this file for why a connected call is never a takeover.
 */
export type PhoneModeCallMode = 'hidden' | 'takeover' | 'banner';

export interface PhoneModeCallSurfaceState {
  mode: PhoneModeCallMode;
  surfaceProps: PhoneModeCallSurfaceProps;
}

/**
 * Call this ONCE, unconditionally, from PhoneModeShell. It takes no arguments:
 * PhoneModeShell only mounts while a Phone Mode shell is on screen, and every
 * Phone Mode shell wants this surface. The previous `enabled` flag existed
 * only to keep /app out while PIXEL-F shipped the extension first; /app is now
 * in, so the flag had exactly one value and is gone rather than left as a lie.
 */
export function usePhoneModeCallSurface(): PhoneModeCallSurfaceState {
  const {
    calls,
    currentCall,
    waitingCall,
    answerCall,
    endCall,
    declineWithMessage,
    sendSms,
  } = usePhone();

  const callState = currentCall?.state ?? null;

  // Local duration tick, deliberately NOT in shared context: a 1 s setState in
  // PhoneProvider would re-render every consumer in the extension once a
  // second for the whole call. Same isolation GlobalDialer uses.
  const [liveDuration, setLiveDuration] = useState(0);
  const callStartTime = currentCall?.startTime ?? null;
  const callIsActive = callState === 'active';
  useEffect(() => {
    if (!callIsActive || !callStartTime) { setLiveDuration(0); return; }
    setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    const id = setInterval(() => {
      setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [callIsActive, callStartTime]);

  // "Message sent" snapshot. declineWithMessage sends the SMS and then hangs
  // up; the hang-up clears currentCall immediately, which would unmount the
  // card before the confirmation could be read. Hold a frozen copy.
  const [sentNotice, setSentNotice] = useState<SentNotice | null>(null);
  const sentTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
  }, []);

  const fireQuickReply = useCallback((to: string, body: string, displayName?: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSentNotice({ body: trimmed, number: to, name: displayName });
    declineWithMessage(to, trimmed);
    if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
    sentTimerRef.current = window.setTimeout(() => {
      setSentNotice(null);
      sentTimerRef.current = null;
    }, SENT_NOTICE_MS);
  }, [declineWithMessage]);

  // An unanswered INCOMING call is the only thing that earns the whole body —
  // it is a decision, and the dashboard's panel auto-opens over the app for
  // exactly this state and no other. `dialing` and `active` are progress, not
  // a decision, so they collapse to the banner and leave the app usable.
  // A ringing OUTGOING call does not exist (outgoing runs dialing → active),
  // but `isIncoming` is checked rather than assumed so a future bridge state
  // cannot quietly blank the screen mid-call.
  const isRingingIn = callState === 'ringing' && currentCall?.isIncoming !== false;
  const isConnecting = callState === 'dialing' || callState === 'active'
    || (callState === 'ringing' && !isRingingIn);

  // 2+ simultaneous calls keeps the takeover: the queue is the only place to
  // answer the waiting call or swap between them, and there is no honest way
  // to put "two calls, one of them on hold" in a one-line strip. This is not
  // the case Dennis hit — a normal 1:1 call is — and it is measured in
  // seconds, so it does not reintroduce the complaint.
  const hasQueue = calls.length >= 2;

  const mode: PhoneModeCallMode =
    isRingingIn || sentNotice !== null || (hasQueue && isConnecting) ? 'takeover'
    : isConnecting ? 'banner'
    : 'hidden';

  return {
    mode,
    surfaceProps: {
      calls,
      currentCall: currentCall ?? null,
      waitingCall: waitingCall ?? null,
      duration: liveDuration,
      sentNotice,
      onAnswer: answerCall,
      onEnd: endCall,
      onQuickReply: fireQuickReply,
      onSendSms: sendSms,
    },
  };
}

/**
 * PhoneModeCallBanner — `mode === 'banner'`. A compact strip pinned between
 * the header and the tab strip while a call is connected, so the call is
 * unmistakably live and hangable-up without costing the user the app.
 *
 * WHAT IT SHOWS AND WHY NOTHING ELSE
 * Who (name over number, or the number alone), how long (mm:ss, or "Dialing…"
 * before it connects), and the one control that cannot wait: hang up. Mute is
 * not here because the product has no mute — the audio is on the phone, and a
 * button that lies is worse than a button that is missing.
 *
 * It is chrome, not a card: flush to the full width, hairline bottom, no
 * radius and no shadow, so it reads as part of the shell's top furniture
 * rather than a toast floating over the view. The only colour is the state dot
 * and the End button; everything else is the same slate the call card uses, so
 * the banner and the takeover are visibly the same object in two sizes.
 *
 * Density is inherited, not branched: the extension's `.cc-ext` 0.8x wrapper
 * scales this exactly as it scales the card.
 */
export function PhoneModeCallBanner({
  currentCall,
  duration,
  onEnd,
}: Pick<PhoneModeCallSurfaceProps, 'currentCall' | 'duration' | 'onEnd'>) {
  const isActive = currentCall?.state === 'active';
  const label = (currentCall?.name ?? '').trim() || null;
  const number = currentCall?.number ?? '';

  return (
    <div
      // `status`, not `alert`: the call is ongoing information, and the user
      // triggered it. aria-live polite announces the connect without cutting
      // across whatever they are reading in the view below.
      role="status"
      aria-live="polite"
      aria-label={`Call in progress with ${label ?? number}`}
      data-call-banner
      className="flex-shrink-0 flex items-center gap-2.5 border-b border-slate-950/60 bg-slate-900 px-3 py-2 text-white"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 flex-shrink-0 rounded-full ${
          isActive ? 'bg-emerald-400 motion-safe:animate-pulse' : 'bg-blue-400 motion-safe:animate-pulse'
        }`}
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-medium text-white">
          {label ?? (number || 'Unknown')}
        </span>
        {label && number && (
          <span className="block truncate text-[11px] text-slate-400">{number}</span>
        )}
      </span>
      <span className="flex-shrink-0 text-[13px] font-medium tabular-nums text-slate-300">
        {isActive ? formatDuration(duration) : 'Dialing…'}
      </span>
      <button
        type="button"
        onClick={onEnd}
        aria-label="End call"
        className="flex-shrink-0 rounded-full bg-red-600 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        End
      </button>
    </div>
  );
}

/**
 * The takeover surface. Renders inside the shell's body column, below the
 * header and in place of the tab strip + active view, for an unanswered
 * incoming call and for the multi-call queue. Nothing here sets a fixed
 * height: the card is centred in a
 * `min-h-full` scrollable column, so it holds at 400×420 and at 760×900 alike.
 */
export function PhoneModeCallSurface({
  calls,
  currentCall,
  waitingCall,
  duration,
  sentNotice,
  onAnswer,
  onEnd,
  onQuickReply,
  onSendSms,
}: PhoneModeCallSurfaceProps) {
  const callState = currentCall?.state ?? null;

  // The queue only exists at 2+ simultaneous calls; with 0–1 this is false and
  // the single-call path below is identical to GlobalDialer's.
  const showQueue = calls.length >= 2;

  // The 3px state strip from the /app call card. Colour tracks call state, so
  // "is it actually dialling?" is answerable at a glance, which is the exact
  // question the missing surface left unanswered.
  const barColor = sentNotice
    ? 'bg-emerald-500'
    : callState === 'ringing'
    ? 'bg-amber-500'
    : callState === 'active'
    ? 'bg-emerald-500'
    : callState === 'dialing'
    ? 'bg-blue-500'
    : 'bg-slate-500';

  return (
    <section
      aria-label="Active call"
      // aria-live so a screen reader announces the surface taking over, and
      // announces the answer/decline outcome, without stealing focus from
      // whatever the user was doing.
      aria-live="polite"
      // A takeover, but never a stretched one: the column centres its card
      // vertically and caps its width, so the same markup reads as composed at
      // 400x420 (where it fills the space) and at 760x900 (where it would
      // otherwise be a thin bar pinned to the ceiling of an empty panel).
      // `min-h-full` rather than `h-full` keeps it scrollable the moment the
      // content is taller than the frame — nothing here assumes a height.
      className="h-full min-h-0 overflow-y-auto"
      data-call-surface
    >
      <div className="min-h-full flex flex-col justify-center px-2 py-3">
        <div
          className={
            showQueue
              ? 'w-full max-w-[22rem] mx-auto rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm'
              : 'w-full max-w-[22rem] mx-auto rounded-2xl overflow-hidden border border-slate-800 bg-slate-900 shadow-lg shadow-slate-950/30'
          }
        >
          {!showQueue && <div className={`h-[3px] flex-shrink-0 ${barColor}`} aria-hidden="true" />}

          {showQueue ? (
            <CallQueue
              calls={calls}
              foregroundCallId={currentCall?.callId ?? null}
              foregroundDuration={duration}
              onAnswer={onAnswer}
              onEndForeground={onEnd}
              onSendSms={onSendSms}
            />
          ) : (
            <CallSessionView
              // During the sent-notice window currentCall is already null — fall
              // back to the snapshot so the confirmation has a number to show.
              // The `visible` gate guarantees the state is one of the three live
              // ones whenever sentNotice is null, so this narrowing is sound.
              state={
                callState === 'ringing' || callState === 'dialing' || callState === 'active'
                  ? callState
                  : 'ringing'
              }
              number={currentCall?.number ?? sentNotice?.number ?? ''}
              name={currentCall?.name ?? sentNotice?.name}
              duration={duration}
              isIncoming={currentCall?.isIncoming ?? false}
              hasWaitingCall={waitingCall != null}
              onAnswer={onAnswer}
              onEnd={onEnd}
              onQuickReply={onQuickReply}
              sentNotice={sentNotice?.body ?? null}
            />
          )}
        </div>

        {/* The honest footer from ART-DIRECTION §4.7. The audio never leaves the
            phone; every control here is a remote. Saying so once removes the
            "why can't I hear anything in my browser" question entirely. */}
        <p className="mt-2 px-4 text-center text-[10.5px] leading-snug text-slate-500">
          Audio is on your phone · controls mirror here.
        </p>
      </div>
    </section>
  );
}
