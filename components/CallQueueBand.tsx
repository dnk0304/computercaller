'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  PhoneIncoming,
  PhoneCall,
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
 *   design language (state badges, rounded-xl, rose-500 hang-up, ringing
 *   pulse, the quick-reply chip panel pattern) and the SAME `calls[]` shape +
 *   bridge methods — no new call-state logic, no shape change.
 *
 * CRITICAL GATING — Path A (no default-dialer), confirmed by Dennis + Forge:
 *   `endCall()` / `declineWithMessage()` map to a phone-WIDE
 *   `telecomManager.endCall()` — it acts on the FOREGROUND call, never a
 *   specific background leg. So:
 *     • FOREGROUND chip (the call `currentCall` points at, i.e. what endCall
 *       targets) → FULL controls: Answer (if ringing), Hang up, and quick-
 *       reply ONLY when it is the sole ringing+incoming call (declineWithMessage
 *       can't target a specific leg when another call is in flight).
 *     • BACKGROUND chips → ANSWER-ONLY. We deliberately DO NOT expose a hang-
 *       up / reject on a background chip, because tapping it would end the
 *       FOREGROUND call instead — the wrong call. A non-destructive Send-SMS
 *       affordance (targets a specific number, always safe) is the only extra.
 *   This mirrors Forge's per-call-targeting limitation exactly; revisit when
 *   Path B / InCallService lands.
 */

// Duration (ms) the "Message sent" confirmation stays visible after a quick
// reply / SMS tap. Matches GlobalDialer's SENT_NOTICE_MS so the two surfaces
// feel consistent.
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

// State badge copy + color for a call chip. Shared vocabulary with the
// GlobalDialer queue's queueBadge() so the two surfaces read identically.
function bandBadge(state: CallState): { label: string; cls: string } {
  switch (state) {
    case 'ringing':
      return { label: 'Ringing', cls: 'bg-rose-100 text-rose-700' };
    case 'dialing':
      return { label: 'Dialing', cls: 'bg-blue-100 text-blue-700' };
    case 'active':
      return { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' };
    case 'held':
      return { label: 'On hold', cls: 'bg-amber-100 text-amber-700' };
    default:
      return { label: 'Waiting', cls: 'bg-slate-100 text-slate-600' };
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
    sendSms,
  } = usePhone();

  // "Message sent" snapshot, keyed by callId, so a chip can confirm a quick
  // reply / SMS dispatch in place without the band reflowing. declineWithMessage
  // tears the foreground call down, so without a held snapshot the chip would
  // vanish before the confirmation registers.
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

  // Quick-reply on the foreground ringing call: atomic SMS-then-decline.
  const fireQuickReply = useCallback((callId: string, to: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    markSent(callId, trimmed);
    declineWithMessage(to, trimmed);
  }, [declineWithMessage, markSent]);

  // Plain SMS on a background chip (non-destructive — targets a specific
  // number, never ends a call).
  const fireSms = useCallback((callId: string, to: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    markSent(callId, trimmed);
    sendSms(to, trimmed);
  }, [sendSms, markSent]);

  // Render nothing unless a phone is connected AND there's at least one call.
  // The band must vanish on the idle dashboard — no dead space (mockup).
  if (!isConnected || calls.length < 1) return null;

  const foregroundId = currentCall?.callId ?? null;

  return (
    <section
      aria-label="Active calls"
      // flex-shrink-0 → the band keeps its height and never scrolls with the
      // dashboard columns below. The header above is sticky/z-10; this sits
      // beneath it in normal flow, so it can't overlap.
      className="flex-shrink-0 border-b border-slate-200 bg-white/70 backdrop-blur-sm"
    >
      {/* Compact band (2026-06-12): the separate "Active calls · N" label row
          was dropped to hit Dennis's ~50% height target — the count lives in
          the list's aria-label instead. */}
      <div className="px-4 py-1.5">
        {/* Single horizontal band. Chips never wrap (flex-shrink-0 + nowrap);
            overflow scrolls horizontally so the dashboard columns below are
            never pushed down unpredictably. */}
        <ul
          aria-label={calls.length === 1 ? '1 active call' : `${calls.length} active calls`}
          className="flex items-stretch gap-2 overflow-x-auto pb-1 -mb-1"
          style={{ scrollbarWidth: 'thin' }}
        >
          {calls.map((call) => (
            <li key={call.callId} className="flex-shrink-0">
              <CallChip
                call={call}
                isForeground={call.callId === foregroundId}
                sentNotice={sentByCall[call.callId] ?? null}
                onAnswer={answerCall}
                onHangUpForeground={endCall}
                onQuickReply={fireQuickReply}
                onSendSms={fireSms}
                hasOtherCalls={calls.length > 1}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// =====================================================================
// CallChip — one call in the band.
// =====================================================================
interface CallChipProps {
  call: CallInfo;
  /** True for the call that `endCall()` actually targets (the bridge's
   *  derived currentCall). Only this chip may expose a hang-up. */
  isForeground: boolean;
  /** Non-null while showing the in-chip "Message sent" confirmation. */
  sentNotice: string | null;
  onAnswer: () => void;
  /** Ends the FOREGROUND call — the only thing END_CALL can target. */
  onHangUpForeground: () => void;
  /** Atomic SMS + decline on the foreground ringing call. */
  onQuickReply: (callId: string, to: string, body: string) => void;
  /** Plain SMS to this call's number (non-destructive). */
  onSendSms: (callId: string, to: string, body: string) => void;
  /** True when 2+ calls are in flight — gates the foreground quick-reply off
   *  (declineWithMessage can't target a specific leg then). */
  hasOtherCalls: boolean;
}

function CallChip({
  call,
  isForeground,
  sentNotice,
  onAnswer,
  onHangUpForeground,
  onQuickReply,
  onSendSms,
  hasOtherCalls,
}: CallChipProps) {
  // Reply/SMS sub-panel state, mirroring the GlobalDialer call surface:
  //   'hidden' = default action row
  //   'chips'  = quick-reply chip list + Custom…
  //   'custom' = free-text composer
  type ReplyView = 'hidden' | 'chips' | 'custom';
  const [replyView, setReplyView] = useState<ReplyView>('hidden');
  const [customText, setCustomText] = useState('');

  // Reset the panel if the underlying call identity changes (defensive — list
  // keys mean this rarely remounts, but a callId reuse shouldn't strand state).
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

  const isRinging = call.state === 'ringing';
  const isActive = call.state === 'active';
  const hasNumber = call.number.trim().length > 0;
  const badge = bandBadge(call.state);

  // Whether the message sub-panel sends an atomic decline (foreground ringing
  // sole-call) or a plain SMS (background). Foreground quick-reply is only
  // safe when it is the sole ringing+incoming call; with other calls in flight
  // declineWithMessage can't target this leg, so we fall back to plain SMS.
  const quickReplyIsDecline =
    isForeground && isRinging && call.isIncoming && !hasOtherCalls;

  const handlePanelSend = (body: string) => {
    if (quickReplyIsDecline) {
      onQuickReply(call.callId, call.number, body);
    } else {
      onSendSms(call.callId, call.number, body);
    }
    setReplyView('hidden');
    setCustomText('');
  };

  // Compact pass (2026-06-12, Dennis): ONE row per chip — identity, state and
  // actions inline. Actions are icon-only (h-8/w-8 = 32px touch targets, aria-
  // labels + titles carry the verb). The secondary number line was dropped;
  // when a contact name is shown the number moves to the identity title attr.
  // The reply/sent sub-states still expand the chip downward — transient only.
  const displayName = call.name || call.number || 'Number hidden';

  return (
    <div
      className={clsx(
        'relative rounded-lg border px-2 py-1.5 transition-colors',
        replyView !== 'hidden' ? 'w-56' : 'max-w-[14rem]',
        isForeground
          ? 'border-emerald-200 bg-emerald-50/60 ring-1 ring-emerald-200/60'
          : 'border-slate-200 bg-white',
      )}
    >
      {/* Single line: avatar · name/number · state · actions */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-shrink-0">
          {isRinging && (
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full ring-2 ring-emerald-400/40 animate-pulse"
            />
          )}
          <div
            className={clsx(
              'relative w-6 h-6 rounded-full flex items-center justify-center',
              isRinging
                ? 'bg-emerald-50 ring-2 ring-emerald-200'
                : isActive
                ? 'bg-emerald-50'
                : 'bg-slate-100',
            )}
          >
            {isRinging ? (
              <PhoneIncoming className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
            ) : isActive ? (
              <PhoneCall className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
            ) : (
              <Phone className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            )}
          </div>
        </div>

        <p
          className="min-w-0 flex-1 text-xs font-bold text-slate-900 truncate"
          title={call.name ? `${call.name} · ${call.number}` : undefined}
        >
          {displayName}
        </p>

        <span
          className={clsx(
            'text-[9px] font-semibold uppercase tracking-wide px-1.5 py-px rounded-full flex-shrink-0',
            badge.cls,
          )}
        >
          {badge.label}
        </span>

        {/* Inline action cluster (sent-notice swaps in for it). */}
        {sentNotice ? (
          <span className="text-[10px] text-emerald-600 font-medium inline-flex items-center gap-1 max-w-[7rem] flex-shrink-0">
            <Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            <span className="truncate">Sent</span>
          </span>
        ) : (
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Answer — shown for any ringing call (foreground OR background).
                answerCall() answers the ringing call; this is the ONE action
                that's safe on a background chip under Path A. */}
            {isRinging && (
              <button
                type="button"
                onClick={onAnswer}
                aria-label={`Answer call from ${call.name || call.number || 'unknown caller'}`}
                title="Answer"
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white shadow-sm shadow-emerald-500/30 transition-all"
              >
                <Phone className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {/* Message affordance:
                • foreground ringing sole-call → quick-reply + decline.
                • otherwise → plain Send SMS (non-destructive).
                Always safe — never ends a call by itself. Disabled with no
                number to text. */}
            <button
              type="button"
              onClick={() => setReplyView('chips')}
              disabled={!hasNumber}
              aria-label={
                quickReplyIsDecline
                  ? `Reply with a message and decline call from ${call.name || call.number || 'this caller'}`
                  : `Send a text to ${call.name || call.number || 'this caller'}`
              }
              title={quickReplyIsDecline ? 'Reply with message & decline' : 'Send a text'}
              className={clsx(
                'h-8 w-8 rounded-lg inline-flex items-center justify-center transition-colors',
                hasNumber
                  ? 'bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200'
                  : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed',
              )}
            >
              <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            {/* Hang up / Decline — FOREGROUND ONLY. Path A: endCall() targets
                the foreground call, so a hang-up on a background chip would end
                the WRONG call. Background chips deliberately omit this. */}
            {isForeground && (
              <button
                type="button"
                onClick={onHangUpForeground}
                aria-label={isRinging ? 'Decline the current call' : 'Hang up the current call'}
                title={isRinging ? 'Decline the current call' : 'Hang up the current call'}
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center bg-rose-500 hover:bg-rose-600 active:scale-95 text-white shadow-sm shadow-rose-500/30 transition-all"
              >
                <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Transient composer — expands the chip downward while open. */}
      {!sentNotice && replyView !== 'hidden' && (
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
          sendLabel={quickReplyIsDecline ? 'Send & decline' : 'Send'}
          sendAriaLabel={
            quickReplyIsDecline
              ? 'Send message and decline call'
              : `Send message to ${call.name || call.number || 'this caller'}`
          }
        />
      )}
    </div>
  );
}

// =====================================================================
// ChipReplyPanel — compact quick-reply / SMS composer for a band chip.
// =====================================================================
// Horizontal-band variant of GlobalDialer's CallReplyPanel. While the panel is
// open the chip locks to w-56 (224px), so chips render as a tight vertical
// stack inside the chip rather than a flex-wrap row.
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
      <div className="mt-2 text-left space-y-1.5">
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

  // view === 'chips' — stacked one-per-row for the narrow chip.
  return (
    <div className="mt-2 text-left space-y-1.5">
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
