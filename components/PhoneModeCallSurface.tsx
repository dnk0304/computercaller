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
 *   'ringing'  — an unanswered INCOMING call. Pinned as a card at the TOP of
 *                the Dial tab, above the pad and the recents list. The tab
 *                strip and every tab stay usable; leave Dial mid-ring and the
 *                compact banner carries the call with you, so it is never lost.
 *   'banner'   — anything already connected (dialing, active), and the 2+ call
 *                queue, which labels itself "2 calls" and expands into a sheet
 *                on tap. A compact strip between the header and the tab strip.
 *   'hidden'   — no call.
 *
 * NOTHING TAKES THE SCREEN ANY MORE (Dennis 2026-09-15, 13:55)
 * "Now the incoming calls in the extension totally block out all the tabs. It
 * should just show up on top inside of the dial tab in a normal way." The
 * ringing takeover is gone, the queue takeover is gone, and the 1.4 s "Message
 * sent" tail is a toast. A phone-width shell that blanks itself is strictly
 * worse than the dashboard it mirrors, in every one of those states.
 *
 * WHY A HOOK + THREE COMPONENTS RATHER THAN ONE COMPONENT
 * The shell needs to know WHICH shape before it renders, because the ringing
 * card belongs inside the Dial tab and the banner belongs above the tab strip.
 * `mode` and the surface's own state must be the same state — including the
 * "Message sent" window, during which `currentCall` is already null but the
 * confirmation is still on screen.
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
import { ChevronDown } from 'lucide-react';
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
export type PhoneModeCallMode = 'hidden' | 'ringing' | 'banner';

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

  // A ringing OUTGOING call does not exist (outgoing runs dialing → active),
  // but `isIncoming` is checked rather than assumed so a future bridge state
  // cannot quietly change the shape mid-call.
  const isRingingIn = callState === 'ringing' && currentCall?.isIncoming !== false;
  const isConnecting = callState === 'dialing' || callState === 'active'
    || (callState === 'ringing' && !isRingingIn);

  // 2+ simultaneous calls collapses to the banner too, with a "2 calls" label
  // and a tap-to-expand queue sheet. The earlier takeover was the last screen
  // in the shell that could strand the user, and a sheet says the same thing
  // without taking the app away.
  const hasQueue = calls.length >= 2;

  const mode: PhoneModeCallMode =
    hasQueue && (isRingingIn || isConnecting) ? 'banner'
    : isRingingIn ? 'ringing'
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
 * PhoneModeIncomingCard — `mode === 'ringing'`, rendered pinned at the TOP of
 * the Dial tab, above the dialpad and the recents list.
 *
 * WHY HERE AND NOT OVER EVERYTHING
 * A ringing call is a decision, but it is not the only thing the user is
 * allowed to do. Dennis, on the takeover this replaces: "it should just show
 * up on top inside of the dial tab in a normal way." So the card sits where a
 * phone puts it — at the top of the calling surface — and the tab strip, the
 * other tabs and the view underneath all stay live.
 *
 * It is `flex-shrink-0` and OUTSIDE the Dial view's scroller, so it cannot be
 * scrolled away while the phone is still ringing.
 *
 * NOTHING IS FORKED: the card body is GlobalDialer's own `CallSessionView`, so
 * Answer, Decline and the quick-reply chips are the exact same code path (and
 * the same accessible names) the dashboard and the old takeover used.
 *
 * MOTION: an amber ring and the 3px state strip pulse while it is ringing —
 * enough to catch the eye in peripheral vision without moving any layout.
 * `motion-safe:` gates it, so `prefers-reduced-motion` gets the identical card
 * with a static amber ring, which still reads unambiguously as incoming.
 */
export function PhoneModeIncomingCard({
  currentCall,
  waitingCall,
  duration,
  onAnswer,
  onEnd,
  onQuickReply,
}: Pick<PhoneModeCallSurfaceProps, 'currentCall' | 'waitingCall' | 'duration' | 'onAnswer' | 'onEnd' | 'onQuickReply'>) {
  return (
    <section
      aria-label="Incoming call"
      // `polite`, not `assertive`: the card appears next to what the user is
      // reading rather than replacing it, so it does not need to interrupt.
      aria-live="polite"
      data-incoming-card
      className="flex-shrink-0 border-b border-slate-200 bg-slate-50 px-2 pb-2 pt-2"
    >
      <div className="mx-auto w-full max-w-[22rem] overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-lg shadow-slate-950/30 ring-2 ring-amber-400/40">
        <div
          className="h-[3px] flex-shrink-0 bg-amber-500 motion-safe:animate-pulse"
          aria-hidden="true"
        />
        <CallSessionView
          state="ringing"
          number={currentCall?.number ?? ''}
          name={currentCall?.name}
          duration={duration}
          isIncoming
          hasWaitingCall={waitingCall != null}
          onAnswer={onAnswer}
          onEnd={onEnd}
          onQuickReply={onQuickReply}
          sentNotice={null}
        />
      </div>
      {/* The honest footer from ART-DIRECTION §4.7. The audio never leaves the
          phone; every control here is a remote. */}
      <p className="mt-1.5 px-4 text-center text-[10.5px] leading-snug text-slate-500">
        Audio is on your phone · controls mirror here.
      </p>
    </section>
  );
}

/**
 * PhoneModeCallToast — the 1.4 s "Message sent" confirmation, after a quick
 * reply has already declined the call and cleared it.
 *
 * This used to hold the whole body as a takeover for those 1.4 seconds, which
 * meant the most trivial outcome in the product — a template SMS went out —
 * blanked the screen. It is a confirmation, so it is a toast: it appears over
 * the bottom of the shell, announces itself once, and leaves.
 */
export function PhoneModeCallToast({ notice }: { notice: SentNotice }) {
  const who = (notice.name ?? '').trim() || notice.number;
  return (
    <div
      role="status"
      aria-live="polite"
      data-call-toast
      className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3"
    >
      <div className="flex max-w-[22rem] items-start gap-2 rounded-xl border border-emerald-700/40 bg-slate-900/95 px-3 py-2 text-white shadow-lg shadow-slate-950/30 backdrop-blur-sm">
        <span aria-hidden="true" className="mt-[3px] h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400" />
        <span className="min-w-0 leading-tight">
          <span className="block text-[12px] font-medium">Message sent to {who}</span>
          <span className="block truncate text-[11px] text-slate-400">{notice.body}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * PhoneModeCallBanner — `mode === 'banner'`. A compact strip pinned between
 * the header and the tab strip while a call is connected, so the call is
 * unmistakably live and hangable-up without costing the user the app.
 *
 * It also carries a RINGING call whenever the user is not looking at the Dial
 * tab, so walking away from Dial mid-ring never loses the call: same strip,
 * amber dot, "Incoming", and an Answer button next to Decline.
 *
 * WHAT IT SHOWS AND WHY NOTHING ELSE
 * Who (name over number, or the number alone), how long (mm:ss, or "Dialing…"
 * before it connects), and the one control that cannot wait: hang up. Mute is
 * not here because the product has no mute — the audio is on the phone, and a
 * button that lies is worse than a button that is missing.
 *
 * AND THE QUEUE. At 2+ simultaneous calls the strip says "2 calls" and becomes
 * a disclosure button: tapping it expands GlobalDialer's own `CallQueue` into a
 * sheet directly beneath. That is the honest one-line representation the old
 * takeover was said to be unable to give — how many, and one tap to the list —
 * and it costs the user nothing while they decide.
 *
 * It is chrome, not a card: flush to the full width, hairline bottom, no
 * radius and no shadow, so it reads as part of the shell's top furniture
 * rather than a toast floating over the view. The only colour is the state dot
 * and the buttons; everything else is the same slate the call card uses, so
 * the banner and the card are visibly the same object in two sizes.
 *
 * Density is inherited, not branched: the extension's `.cc-ext` 0.8x wrapper
 * scales this exactly as it scales the card.
 */
export function PhoneModeCallBanner({
  calls,
  currentCall,
  duration,
  onAnswer,
  onEnd,
  onSendSms,
}: Pick<PhoneModeCallSurfaceProps, 'calls' | 'currentCall' | 'duration' | 'onAnswer' | 'onEnd' | 'onSendSms'>) {
  const isActive = currentCall?.state === 'active';
  const isRinging = currentCall?.state === 'ringing' && currentCall?.isIncoming !== false;
  const label = (currentCall?.name ?? '').trim() || null;
  const number = currentCall?.number ?? '';
  const hasQueue = calls.length >= 2;
  const [queueOpen, setQueueOpen] = useState(false);

  const status = isRinging ? 'Incoming' : isActive ? formatDuration(duration) : 'Dialing…';

  const identity = (
    <span className="min-w-0 flex-1 text-left leading-tight">
      <span className="block truncate text-[13px] font-medium text-white">
        {hasQueue ? `${calls.length} calls` : label ?? (number || 'Unknown')}
      </span>
      {(hasQueue || (label && number)) && (
        <span className="block truncate text-[11px] text-slate-400">{label ?? number}</span>
      )}
    </span>
  );

  return (
    <div className="flex-shrink-0">
      <div
        // `status`, not `alert`: the call is ongoing information. aria-live
        // polite announces the connect without cutting across whatever the
        // user is reading in the view below.
        role="status"
        aria-live="polite"
        data-call-banner
        className="flex items-center gap-2.5 border-b border-slate-950/60 bg-slate-900 px-3 py-2 text-white"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 flex-shrink-0 rounded-full motion-safe:animate-pulse ${
            isRinging ? 'bg-amber-400' : isActive ? 'bg-emerald-400' : 'bg-blue-400'
          }`}
        />
        {hasQueue ? (
          <button
            type="button"
            onClick={() => setQueueOpen(o => !o)}
            aria-expanded={queueOpen}
            aria-label={queueOpen ? 'Hide the call queue' : 'Show the call queue'}
            className="flex min-w-0 flex-1 items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {identity}
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${queueOpen ? 'rotate-180' : ''}`}
            />
          </button>
        ) : (
          identity
        )}
        <span className="flex-shrink-0 text-[13px] font-medium tabular-nums text-slate-300">
          {status}
        </span>
        {isRinging && (
          <button
            type="button"
            onClick={onAnswer}
            aria-label="Answer call"
            className="flex-shrink-0 rounded-full bg-emerald-600 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            Answer
          </button>
        )}
        <button
          type="button"
          onClick={onEnd}
          aria-label={isRinging ? 'Decline call' : 'End call'}
          className="flex-shrink-0 rounded-full bg-red-600 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
        >
          {isRinging ? 'Decline' : 'End'}
        </button>
      </div>
      {hasQueue && queueOpen && (
        <div data-call-queue-sheet className="max-h-[50vh] overflow-y-auto border-b border-slate-200 bg-white">
          <CallQueue
            calls={calls}
            foregroundCallId={currentCall?.callId ?? null}
            foregroundDuration={duration}
            onAnswer={onAnswer}
            onEndForeground={onEnd}
            onSendSms={onSendSms}
          />
        </div>
      )}
    </div>
  );
}
