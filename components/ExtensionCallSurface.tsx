'use client';

/**
 * ExtensionCallSurface — the in-call surface for the Chrome extension
 * (dispatch PIXEL-F, 2026-09-15).
 *
 * THE BUG THIS EXISTS TO FIX
 * Dennis: "Once I dialed a number it didn't show that I was actually in a
 * call/calling on my phone. Which means I also couldn't hang up from the
 * extension." The call genuinely went out — `usePhone().currentCall` was
 * populated the whole time. Nothing on the extension surface consumed it.
 *
 * The only in-call UI in production is `CallSessionView` inside
 * `GlobalDialer`, and GlobalDialer renders its card ONLY while its floating
 * panel `isOpen`. The panel auto-opens for `state === 'ringing'` (incoming)
 * and nothing else; an OUTGOING call runs dialing → active → null without ever
 * opening it. On /app that is invisible, because the user dialled from inside
 * the already-open panel. The extension's Dial tab
 * (PhoneModeShell → ExtDialerView → makeCall) never touches `useDialerOpen()`,
 * so there was no panel, and therefore no card and no End button.
 *
 * WHY A HOOK + A COMPONENT RATHER THAN ONE COMPONENT
 * The shell needs to know the surface is showing BEFORE it renders, because a
 * live call is a full-body takeover (ART-DIRECTION §4.6/§4.7: the tab strip is
 * hidden, the header stays). `visible` and the surface's own state must be the
 * same state — including the 1.4 s "Message sent" window, during which
 * `currentCall` is already null but the confirmation is still on screen. Two
 * independent reads would let the tab strip snap back mid-confirmation.
 *
 * NOTHING IS FORKED. `CallSessionView` and `CallQueue` are imported from
 * GlobalDialer. The behaviours below (local 1 s duration tick, the quick-reply
 * sent-notice snapshot, `endCall` targeting the foreground call only) mirror
 * GlobalDialer's exactly, so the two surfaces cannot drift on call semantics.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePhone } from '@/hooks';
import { CallQueue, CallSessionView } from '@/components/GlobalDialer';
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

/** Everything `<ExtensionCallSurface />` needs. Built by the hook below. */
export interface ExtensionCallSurfaceProps {
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

export interface ExtensionCallSurfaceState {
  /** True while a call surface should own the shell body. */
  visible: boolean;
  surfaceProps: ExtensionCallSurfaceProps;
}

/**
 * Call this ONCE, unconditionally, from PhoneModeShell. `enabled` is false on
 * /app, which pins `visible` to false and leaves the dashboard untouched —
 * the hook still runs (rules of hooks) but never renders anything.
 */
export function useExtensionCallSurface({ enabled }: { enabled: boolean }): ExtensionCallSurfaceState {
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
    if (!enabled || !callIsActive || !callStartTime) { setLiveDuration(0); return; }
    setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    const id = setInterval(() => {
      setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [enabled, callIsActive, callStartTime]);

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

  const hasLiveCall =
    callState === 'ringing' || callState === 'dialing' || callState === 'active';

  return {
    visible: enabled && (hasLiveCall || sentNotice !== null),
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
 * The surface itself. Renders inside the shell's body column, below the header
 * and in place of the tab strip + active view (ART-DIRECTION §4.6 incoming,
 * §4.7 in call). Nothing here sets a fixed height: the card is centred in a
 * `min-h-full` scrollable column, so it holds at 400×420 and at 760×900 alike.
 */
export function ExtensionCallSurface({
  calls,
  currentCall,
  waitingCall,
  duration,
  sentNotice,
  onAnswer,
  onEnd,
  onQuickReply,
  onSendSms,
}: ExtensionCallSurfaceProps) {
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
      data-ext-call-surface
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
