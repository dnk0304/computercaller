'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  MessageSquare,
  Send,
  Check,
  ChevronLeft,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import type { CallInfo, CallState } from '@/hooks/phoneTypes';
import { useQuickReplyTemplates } from '@/hooks/useQuickReplyTemplates';

/**
 * CallQueueBand — horizontal incoming-call queue strip.
 *
 * Placement (AppShell.tsx): a `flex-shrink-0` band BETWEEN the sticky header
 * and the dashboard content slot. Renders null at 0 calls so the idle
 * dashboard collapses cleanly (no dead space). Dennis's 2026-06-11 mockup
 * drew the band exactly in that gap.
 *
 * Why a NEW component rather than reusing GlobalDialer's <CallQueue>:
 *   GlobalDialer's queue is a VERTICAL stack inside a 208px docked floating
 *   panel. This is a full-width HORIZONTAL band. The two layouts have
 *   opposite primary axes; porting the vertical cards sideways would be more
 *   invasive than building purpose-fit horizontal chips. We REUSE the shared
 *   design language and the SAME `calls[]` shape + bridge methods — no new
 *   call-state logic, no shape change.
 *
 * LOCKED layout (2026-06-12, Dennis — FINAL, after the ultra-compact pass
 * truncated numbers to "+47…": "Make it so it's exactly high enough so the
 * number fits and our buttons right under. Lock that. So I can see the whole
 * number."):
 *   • TWO-ROW chip. Row 1 = the FULL number (or name) — NEVER truncated, no
 *     max-width clamp; the chip is fit-content (w-max) and grows to whatever
 *     the identity needs. Row 2 = the action buttons directly beneath.
 *   • Band height = exactly those two compact rows + minimal padding:
 *     20px identity row + 24px action row + 2px chip borders + 2px band
 *     padding ≈ 48px total. Nothing more.
 *   • Avatar circle → 8px status dot (color = state; ringing pulses).
 *     State text lives in sr-only + the chip's title attr.
 *   • Actions are 24×24px icon buttons. DELIBERATE tradeoff: below the 32px
 *     touch ideal, but Dennis's density spec wins; aria-labels + titles kept.
 *   • Quick-reply / custom SMS never inflates the chip — it opens as an
 *     absolutely-positioned popover BELOW the band (z-30). While any popover
 *     is open the chip list switches from overflow-x-auto to overflow-visible
 *     so the popover isn't clipped by the scroll container; horizontal scroll
 *     is suspended for that transient moment only.
 *
 * SINGLE-SLOT MODEL (2026-06-16, Dennis — two-row LOCK lifted, Forge's state
 * cap landed in 287e8ed): `calls[]` now holds AT MOST 2 rows by construction —
 * one foreground call + at most one WAITING (ringing) call. The old
 * arbitrary-length multi-call scroll list, the `hasOtherCalls` gating, the
 * background "Answer-only + non-destructive SMS" Path-A dance, and the
 * overflow-x-auto popover-clip suspension are all GONE. The band renders
 * exactly two states:
 *
 *   • ONE call (foreground only) → ONE chip, FULL controls: Answer (if
 *     ringing), reply-with-message (atomic decline when it's the sole ringing
 *     incoming call), Hang up.
 *   • ONE active + ONE waiting → the foreground chip (full controls) AND a
 *     waiting chip whose ONLY action is "Reply with a message" → which sends a
 *     quick-reply / custom SMS AND declines the waiting leg. NO Answer button,
 *     NO separate Hang-up on the waiting chip. One action: reply-&-decline.
 *
 * Why the waiting chip's single reply is now SAFE (Forge's 287e8ed):
 *   `declineWithMessage(to, body)` resolves the target call by number and
 *   branches internally — END_CALL:{} for a lone ringing call, but
 *   DECLINE_CALL:{callId} for a TRUE waiting call (a ringing leg behind a
 *   different active call). So it rejects the WAITING leg and keeps the active
 *   call up; it can no longer hang up the wrong call. Against the current v36
 *   APK (no DECLINE_CALL handler) it degrades gracefully: the SMS still sends
 *   and the waiting call rings out — Ken's new APK enables the on-device
 *   per-leg reject. Either way the UI is identical.
 */

// Duration (ms) the "Sent" confirmation stays visible after a quick reply /
// SMS tap. Matches GlobalDialer's SENT_NOTICE_MS so the two surfaces feel
// consistent.
const SENT_NOTICE_MS = 1400;

// Default quick-reply chips shown ONLY when the user has zero saved entries.
// Same set + same "user list takes over entirely once they have ≥1" rule as
// the GlobalDialer call surface — no mixing.
interface BandQuickReply { name: string; body: string }
const DEFAULT_QUICK_REPLIES: ReadonlyArray<BandQuickReply> = [
  { name: "Can't talk right now", body: "Can't talk right now" },
  { name: "I'll call you back",   body: "I'll call you back" },
  { name: 'On my way',            body: 'On my way' },
  { name: 'Call you later',       body: 'Call you later' },
];

// Status-dot color + label for a call state. Replaces the old text badge —
// at 29px there is no room for badge copy, so the dot color carries state
// visually and the label goes to sr-only/title.
function bandDot(state: CallState): { label: string; dotCls: string } {
  switch (state) {
    case 'ringing':
      return { label: 'Ringing', dotCls: 'bg-emerald-500' };
    case 'dialing':
      return { label: 'Dialing', dotCls: 'bg-blue-500' };
    case 'active':
      return { label: 'Active', dotCls: 'bg-emerald-500' };
    case 'held':
      return { label: 'On hold', dotCls: 'bg-amber-500' };
    default:
      return { label: 'Waiting', dotCls: 'bg-slate-400' };
  }
}

export function CallQueueBand() {
  const {
    isConnected,
    calls,
    currentCall,
    answerCall,
    endCall,
    declineWithMessage,
    dismissCall,
  } = usePhone();

  // "Message sent" snapshot, keyed by callId, so a chip can confirm a quick
  // reply in place without the band reflowing. declineWithMessage drops the
  // target call, so without a held snapshot the chip would vanish before the
  // confirmation registers.
  const [sentByCall, setSentByCall] = useState<Record<string, string>>({});
  const sentTimers = useRef<Record<string, number>>({});
  useEffect(() => {
    const timers = sentTimers.current;
    return () => {
      for (const id of Object.keys(timers)) window.clearTimeout(timers[id]);
    };
  }, []);

  const markSent = useCallback((callId: string, body: string) => {
    setSentByCall((prev) => ({ ...prev, [callId]: body }));
    const existing = sentTimers.current[callId];
    if (existing) window.clearTimeout(existing);
    sentTimers.current[callId] = window.setTimeout(() => {
      setSentByCall((prev) => {
        const next = { ...prev };
        delete next[callId];
        return next;
      });
      delete sentTimers.current[callId];
    }, SENT_NOTICE_MS);
  }, []);

  // Reply-with-message — used by BOTH chips. Forge's declineWithMessage
  // (287e8ed) resolves the right leg by number and branches internally:
  // END_CALL for a lone ringing call, DECLINE_CALL for a true waiting leg. So
  // it's always safe to call with the chip's own number — the foreground
  // ringing sole-call atomically declines, the waiting leg is rejected while
  // the active call stays up. No more plain-SMS fallback / hasOtherCalls gate.
  const fireReply = useCallback((callId: string, to: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    markSent(callId, trimmed);
    declineWithMessage(to, trimmed);
  }, [declineWithMessage, markSent]);

  // Render nothing unless a phone is connected AND there's at least one call.
  // The band must vanish on the idle dashboard — no dead space (mockup).
  if (!isConnected || calls.length < 1) return null;

  // Single-slot model: at most one foreground + at most one waiting chip
  // (Forge caps calls[] to <=2). Derive the two slots explicitly rather than
  // mapping an arbitrary list. Foreground = the bridge's derived currentCall;
  // waiting = any other call (the lone ringing leg behind it). With the cap
  // there is at most one of each, so this is exhaustive.
  const foregroundId = currentCall?.callId ?? null;
  const foregroundCall = foregroundId
    ? calls.find((c) => c.callId === foregroundId) ?? null
    : null;
  const waitingCall = calls.find((c) => c.callId !== foregroundId) ?? null;
  // Defensive: if there's no derived currentCall but a call exists (e.g. a sole
  // ringing call the bridge hasn't promoted to currentCall yet), treat the
  // first call as the foreground so it still gets full controls.
  const primaryCall = foregroundCall ?? calls[0] ?? null;

  return (
    <section
      aria-label="Active calls"
      // flex-shrink-0 → the band keeps its height and never scrolls with the
      // dashboard columns below. The header above is sticky/z-10; this sits
      // beneath it in normal flow, so it can't overlap.
      //
      // LAYERING FIX (2026-06-16, Dennis bug #3): `backdrop-blur-sm` makes this
      // section its OWN stacking context. Without an explicit z-index the
      // section painted with z-auto, so the dashboard content slot below
      // (AppShell's `relative z-0` wrapper, which holds the Quick Dial card)
      // painted AFTER it — burying the reply popover (a child of THIS section)
      // behind Quick Dial. `relative z-20` lifts the whole band stacking
      // context above the content slot (z-0) so the popover, which drops down
      // into the content region, sits ABOVE Quick Dial. Still below modals/
      // toasts (z-40/z-50) and harmless vs. the sticky header (z-10) — the band
      // sits beneath the header in flow and never overlaps it.
      className="relative z-20 flex-shrink-0 border-b border-slate-200 bg-white/70 backdrop-blur-sm"
    >
      {/* Compact band: py-px + 46px two-row chips ≈ 48px total — exactly the
          identity row + the action row, nothing more. At most two chips
          (foreground + waiting) sit side by side; no scroll plumbing needed
          since the cap guarantees they fit. The reply popover drops BELOW the
          band and is no longer clipped by any overflow container. */}
      <div className="px-3 py-px">
        <ul
          aria-label={waitingCall ? '2 active calls' : '1 active call'}
          className="flex items-stretch gap-1.5"
        >
          {/* Foreground chip — the active / sole-ringing call. FULL controls. */}
          {primaryCall && (
            <li key={primaryCall.callId} className="flex-shrink-0">
              <CallChip
                call={primaryCall}
                variant="foreground"
                sentNotice={sentByCall[primaryCall.callId] ?? null}
                onAnswer={answerCall}
                onHangUp={endCall}
                onReply={fireReply}
                onDismiss={dismissCall}
              />
            </li>
          )}

          {/* Waiting chip — the lone ringing leg behind the active call. Its
              ONLY action is reply-&-decline (no Answer, no Hang-up). */}
          {waitingCall && (
            <li key={waitingCall.callId} className="flex-shrink-0">
              <CallChip
                call={waitingCall}
                variant="waiting"
                sentNotice={sentByCall[waitingCall.callId] ?? null}
                onReply={fireReply}
                onDismiss={dismissCall}
              />
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

// =====================================================================
// CallChip — one call in the band.
// =====================================================================
type ChipVariant = 'foreground' | 'waiting';

interface CallChipProps {
  call: CallInfo;
  /** 'foreground' = the active / sole-ringing call (full controls).
   *  'waiting'    = the lone ringing leg behind the active call (reply only). */
  variant: ChipVariant;
  /** Non-null while showing the in-chip "Sent" confirmation. */
  sentNotice: string | null;
  /** Answer the ringing call. Foreground-only (waiting chip has no Answer). */
  onAnswer?: () => void;
  /** Ends the FOREGROUND call. Foreground-only (waiting chip has no Hang-up). */
  onHangUp?: () => void;
  /** Reply-with-message → declineWithMessage. Resolves the right leg
   *  internally (END_CALL for lone ringing, DECLINE_CALL for a waiting leg). */
  onReply: (callId: string, to: string, body: string) => void;
  /** B2 (2026-06-12): LOCAL removal of this chip from calls[] — no frame is
   *  sent to the phone (a real call continues on the handset). UI dismiss,
   *  not a hang-up. Available on EVERY chip as the stale-chip escape hatch. */
  onDismiss: (callId: string) => void;
}

function CallChip({
  call,
  variant,
  sentNotice,
  onAnswer,
  onHangUp,
  onReply,
  onDismiss,
}: CallChipProps) {
  // Reply popover state, mirroring the GlobalDialer call surface:
  //   'hidden' = no popover
  //   'chips'  = quick-reply chip list + Custom…
  //   'custom' = free-text composer
  type ReplyView = 'hidden' | 'chips' | 'custom';
  const [replyView, setReplyView] = useState<ReplyView>('hidden');
  const [customText, setCustomText] = useState('');

  // Reset the popover if the underlying call identity changes (defensive —
  // list keys mean this rarely remounts, but a callId reuse shouldn't strand
  // state).
  const [prevCallId, setPrevCallId] = useState(call.callId);
  if (prevCallId !== call.callId) {
    setPrevCallId(call.callId);
    setReplyView('hidden');
    setCustomText('');
  }

  const { quickReplies } = useQuickReplyTemplates();
  const chips: ReadonlyArray<BandQuickReply> =
    quickReplies.length > 0
      ? quickReplies.map((qr) => ({ name: qr.label ?? qr.body, body: qr.body }))
      : DEFAULT_QUICK_REPLIES;

  const isForeground = variant === 'foreground';
  const isRinging = call.state === 'ringing';
  const hasNumber = call.number.trim().length > 0;
  const dot = bandDot(call.state);

  // Both variants reply via declineWithMessage, which resolves the right leg:
  //   • foreground sole ringing call → atomic SMS-then-decline (END_CALL).
  //   • waiting leg behind an active call → SMS-then-DECLINE_CALL (per-leg).
  // The reply phrasing is "reply & decline" in both cases (the waiting chip's
  // ONLY action; the foreground's reply also declines when it's ringing).
  const handlePanelSend = (body: string) => {
    onReply(call.callId, call.number, body);
    setReplyView('hidden');
    setCustomText('');
  };

  // LOCKED layout (2026-06-12, Dennis — FINAL): two rows. Row 1 = dot + the
  // FULL number/name (whitespace-nowrap, NO truncate, NO max-width — the chip
  // is w-max and grows to fit) + ✕ dismiss. Row 2 = the action buttons
  // directly beneath. Dennis: "exactly high enough so the number fits and our
  // buttons right under. Lock that."
  const displayName = call.name || call.number || 'Number hidden';

  return (
    <div
      className={clsx(
        'relative rounded-md border px-1.5 w-max transition-colors',
        isForeground
          ? 'border-emerald-200 bg-emerald-50/60'
          : 'border-slate-200 bg-white',
      )}
      title={`${call.name ? `${call.name} · ${call.number}` : displayName} · ${dot.label}`}
    >
      {/* Row 1 (20px): dot · FULL name/number · dismiss. Never truncates. */}
      <div className="flex h-5 items-center gap-1">
        <span className="relative flex-shrink-0 w-2 h-2" aria-hidden="true">
          {isRinging && (
            <span className="absolute -inset-0.5 rounded-full ring-2 ring-emerald-400/50 animate-pulse" />
          )}
          <span className={clsx('absolute inset-0 rounded-full', dot.dotCls)} />
        </span>
        <span className="sr-only">{dot.label}.</span>

        <p className="text-xs font-semibold text-slate-900 whitespace-nowrap leading-none">
          {displayName}
        </p>

        {/* B2 (2026-06-12): ✕ dismiss — on EVERY chip, outside the sent-notice
            swap so it is always reachable. LOCAL list removal only; never
            sends a frame to the phone. Sits at the end of the identity row so
            row 2 stays pure actions. */}
        <button
          type="button"
          onClick={() => onDismiss(call.callId)}
          aria-label="Dismiss from list"
          title="Dismiss from list"
          className="ml-auto h-5 w-5 -mr-1 rounded-md inline-flex items-center justify-center flex-shrink-0 text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-colors"
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>

      {/* Row 2 (24px): action buttons directly under the number
          (sent-notice swaps in for them). */}
      <div className="flex h-6 items-center gap-0.5 pb-0.5">
        {sentNotice ? (
          <span className="text-[10px] text-emerald-600 font-medium inline-flex items-center gap-0.5 flex-shrink-0">
            <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            Sent
          </span>
        ) : (
          <>
            {/* Answer — FOREGROUND ringing only. The waiting chip has no Answer
                in the single-slot model (its one action is reply-&-decline). */}
            {isForeground && isRinging && onAnswer && (
              <button
                type="button"
                onClick={onAnswer}
                aria-label={`Answer call from ${call.name || call.number || 'unknown caller'}`}
                title="Answer"
                className="h-6 w-6 rounded-md inline-flex items-center justify-center bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white transition-all"
              >
                <Phone className="w-3 h-3" aria-hidden="true" />
              </button>
            )}

            {/* Reply-with-message — on BOTH chips. Calls declineWithMessage,
                which sends the SMS then declines the right leg (the foreground
                ringing call, or this waiting leg). For the WAITING chip this is
                the ONLY action. Disabled with no number to text. */}
            <button
              type="button"
              onClick={() => setReplyView(replyView === 'hidden' ? 'chips' : 'hidden')}
              disabled={!hasNumber}
              aria-label={`Reply with a message and decline the call from ${call.name || call.number || 'this caller'}`}
              aria-expanded={replyView !== 'hidden'}
              title="Reply with message & decline"
              className={clsx(
                'h-6 w-6 rounded-md inline-flex items-center justify-center transition-colors',
                hasNumber
                  ? 'text-blue-700 hover:bg-blue-100'
                  : 'text-slate-300 cursor-not-allowed',
              )}
            >
              <MessageSquare className="w-3 h-3" aria-hidden="true" />
            </button>

            {/* Hang up / Decline — FOREGROUND ONLY. endCall() targets the
                foreground call; the waiting chip deliberately omits it (its
                only exit is reply-&-decline or the ✕ dismiss). */}
            {isForeground && onHangUp && (
              <button
                type="button"
                onClick={onHangUp}
                aria-label={isRinging ? 'Decline the current call' : 'Hang up the current call'}
                title={isRinging ? 'Decline the current call' : 'Hang up the current call'}
                className="h-6 w-6 rounded-md inline-flex items-center justify-center bg-rose-500 hover:bg-rose-600 active:scale-95 text-white transition-all"
              >
                <PhoneOff className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Reply popover — floats BELOW the band (never inflates it). */}
      {!sentNotice && replyView !== 'hidden' && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white shadow-lg p-2">
          <ChipReplyPanel
            view={replyView}
            chips={chips}
            customText={customText}
            onChangeCustomText={setCustomText}
            onPickChip={handlePanelSend}
            onPickCustom={() => setReplyView('custom')}
            onBackToChips={() => setReplyView('chips')}
            onCancel={() => { setReplyView('hidden'); setCustomText(''); }}
            onSendCustom={() => { if (customText.trim()) handlePanelSend(customText); }}
            sendLabel="Send & decline"
            sendAriaLabel={`Send message and decline the call from ${call.name || call.number || 'this caller'}`}
          />
        </div>
      )}
    </div>
  );
}

// =====================================================================
// ChipReplyPanel — compact quick-reply / SMS composer for a band chip.
// =====================================================================
// Horizontal-band variant of GlobalDialer's CallReplyPanel. Rendered inside a
// w-56 (224px) popover anchored under the chip, so replies render as a tight
// vertical stack.
interface ChipReplyPanelProps {
  view: 'chips' | 'custom';
  chips: ReadonlyArray<BandQuickReply>;
  customText: string;
  onChangeCustomText: (v: string) => void;
  onPickChip: (body: string) => void;
  onPickCustom: () => void;
  onBackToChips: () => void;
  onCancel: () => void;
  onSendCustom: () => void;
  sendLabel: string;
  sendAriaLabel: string;
}

function ChipReplyPanel({
  view,
  chips,
  customText,
  onChangeCustomText,
  onPickChip,
  onPickCustom,
  onBackToChips,
  onCancel,
  onSendCustom,
  sendLabel,
  sendAriaLabel,
}: ChipReplyPanelProps) {
  if (view === 'custom') {
    return (
      <div className="text-left space-y-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBackToChips}
            aria-label="Back to quick replies"
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
            Custom message
          </span>
        </div>
        <textarea
          value={customText}
          onChange={(e) => onChangeCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (customText.trim()) onSendCustom();
            }
          }}
          rows={2}
          autoFocus
          placeholder="Type a message…"
          aria-label="Custom reply message"
          className="w-full px-2 py-1.5 text-[11px] border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-300 resize-none leading-snug"
        />
        <button
          type="button"
          onClick={onSendCustom}
          disabled={!customText.trim()}
          aria-label={sendAriaLabel}
          className={clsx(
            'w-full h-7 rounded-lg text-[10px] font-semibold flex items-center justify-center gap-1 transition-colors',
            customText.trim()
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/30'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed',
          )}
        >
          <Send className="w-3 h-3" />
          {sendLabel}
        </button>
      </div>
    );
  }

  // view === 'chips' — stacked one-per-row for the narrow popover.
  return (
    <div className="text-left space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          Quick reply
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel quick reply"
          className="p-0.5 rounded text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <ul className="space-y-1" aria-label="Quick reply messages">
        {chips.map((reply) => (
          <li key={reply.name}>
            <button
              type="button"
              onClick={() => onPickChip(reply.body)}
              title={reply.body}
              className="w-full text-left px-2 py-1.5 bg-slate-50 hover:bg-blue-50 active:bg-blue-100 text-slate-700 hover:text-blue-700 text-[11px] rounded-md border border-slate-200 hover:border-blue-200 transition-colors truncate"
            >
              {reply.name}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={onPickCustom}
            className="w-full text-left px-2 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] rounded-md border border-blue-200 transition-colors inline-flex items-center gap-1"
          >
            <MessageSquare className="w-3 h-3" />
            Custom…
          </button>
        </li>
      </ul>
    </div>
  );
}
