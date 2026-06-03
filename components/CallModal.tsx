'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Maximize2, Minimize2, MessageSquare, Send, Check, ChevronLeft } from 'lucide-react';
import { usePhone } from '@/hooks';
import { useQuickReplyTemplates } from '@/hooks/useQuickReplyTemplates';

// Item B (2026-06-03, Pixel) — incoming-call quick-reply UI.
//
// Wires Forge's atomic bridge method (`declineWithMessage(to, body)` on
// usePhone()) into the ringing modal. Tapping the Reply affordance reveals:
//   1. Quick-reply chips with four sensible defaults.
//   2. A "Custom…" input for one-off messages.
// In both cases the action is atomic: the SMS is dispatched and the call is
// rejected in one bridge call (correct ordering owned by Forge).
//
// Gating (per Forge v1 contract, see usePhoneBridge.ts:2185-2208):
//   The Reply affordance is shown ONLY when the simple ringing case holds —
//     currentCall.state === 'ringing' && waitingCall == null
//   For a waiting (second-line) call, rejecting that SPECIFIC call requires
//   per-call targeting that v1 doesn't support; we hide Reply to avoid
//   accidentally rejecting the foreground/active call.
//
// Templates source (mgmt-v2 update, 2026-06-03):
//   Chips now read from the SEPARATE quick-reply store via
//   `useQuickReplyTemplates()` (per-user, cap 5, distinct from useTemplates'
//   general 15-cap SMS-templates store). The four hardcoded
//   DEFAULT_QUICK_REPLIES are kept as FALLBACK ONLY — they render when the
//   user has zero saved quick replies, so the affordance is useful out of
//   the box. As soon as the user creates ≥1 quick reply, their list takes
//   over entirely (no mixing). Dennis-locked.
//
// "Message sent" feedback:
//   declineWithMessage triggers SMS dispatch then endCall(); endCall clears
//   currentCall and would unmount this modal immediately. To preserve the
//   confirmation, we freeze a snapshot of the call in state for SENT_NOTICE_MS
//   so the modal can show optimistic confirmation before unmounting.

const SENT_NOTICE_MS = 1400;

interface QuickReply {
  /** Short label shown on the chip. */
  name: string;
  /** SMS body sent when tapped. For hardcoded defaults, label === body. */
  body: string;
}

const DEFAULT_QUICK_REPLIES: ReadonlyArray<QuickReply> = [
  { name: "Can't talk right now", body: "Can't talk right now" },
  { name: "I'll call you back",   body: "I'll call you back" },
  { name: 'On my way',            body: 'On my way' },
  { name: 'Call you later',       body: 'Call you later' },
];

export const CallModal = () => {
  const { currentCall, waitingCall, answerCall, endCall, declineWithMessage } = usePhone();
  // Mgmt-v2: read user's quick-reply templates. Defaults fall back ONLY when
  // the user has saved zero of their own. Once they have ≥1, theirs render
  // exclusively — no mixing with the hardcoded defaults.
  const { quickReplies } = useQuickReplyTemplates();
  const [isExpanded, setIsExpanded] = useState(false);

  // Reply panel sub-state. 'hidden' = default Answer/Decline/Reply row,
  // 'chips' = chips + Custom option, 'custom' = custom-text composer.
  type ReplyView = 'hidden' | 'chips' | 'custom';
  const [replyView, setReplyView] = useState<ReplyView>('hidden');
  const [customText, setCustomText] = useState('');

  // Frozen "Message sent" snapshot — kept after declineWithMessage so the
  // modal can show optimistic confirmation for SENT_NOTICE_MS even though
  // currentCall is being cleared by endCall().
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const sentTimerRef = useRef<number | null>(null);

  // Reset the reply panel whenever the call surface itself resets (new call,
  // call ended). Keyed on number+startTime so a fresh incoming call gets a
  // fresh panel without stale state from the previous one.
  const callKey = currentCall ? `${currentCall.number}:${currentCall.startTime}` : null;
  useEffect(() => {
    setReplyView('hidden');
    setCustomText('');
  }, [callKey]);

  useEffect(() => {
    return () => {
      if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
    };
  }, []);

  // While the "Message sent" notice is showing, hold a frozen snapshot of the
  // last incoming call so we can keep rendering even after currentCall clears.
  const frozenCallRef = useRef<typeof currentCall>(null);
  if (currentCall && !sentNotice) {
    frozenCallRef.current = currentCall;
  }

  if (!currentCall && !sentNotice) {
    return null;
  }

  // Display call: either the live one, or — during the brief "sent" window —
  // the snapshot we froze just before declineWithMessage fired.
  const displayCall = currentCall ?? frozenCallRef.current;
  if (!displayCall) return null;

  const { state, isIncoming, number, name, duration } = displayCall;

  // Reply affordance gating — per Forge's v1 contract. Hidden for waiting
  // calls; only visible on the simple ringing case. Also hidden once a
  // confirmation is showing so the row doesn't flicker mid-dismiss.
  const showReplyAffordance =
    !sentNotice && state === 'ringing' && isIncoming && waitingCall == null;

  // Format call duration (MM:SS)
  const formatDuration = (seconds: number = 0) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Get status text
  const getStatusText = () => {
    if (sentNotice) return 'Message sent';
    switch (state) {
      case 'ringing':
        return 'Incoming Call';
      case 'dialing':
        return 'Calling...';
      case 'active':
        return formatDuration(duration);
      default:
        return '';
    }
  };

  // Get status color
  const getStatusColor = () => {
    if (sentNotice) return 'bg-emerald-500';
    switch (state) {
      case 'ringing':
        return 'bg-amber-500';
      case 'dialing':
        return 'bg-blue-500';
      case 'active':
        return 'bg-emerald-500';
      default:
        return 'bg-slate-500';
    }
  };

  // Fire-and-forget send. Forge's declineWithMessage is atomic (SMS then
  // hangup, correct order). We capture the body for the optimistic
  // confirmation, then declineWithMessage triggers endCall() which would
  // unmount the modal — sentNotice keeps it visible for SENT_NOTICE_MS.
  const handleSend = (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSentNotice(trimmed);
    declineWithMessage(number, trimmed);
    if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
    sentTimerRef.current = window.setTimeout(() => {
      setSentNotice(null);
      sentTimerRef.current = null;
    }, SENT_NOTICE_MS);
  };

  // Resolved chip source: user's saved quick replies if any, otherwise the
  // hardcoded defaults. Each chip carries `name` (label shown on the pill)
  // and `body` (the SMS sent on tap). For user rows the chip falls back to
  // body when label is null — same behavior as the management sub-section.
  const resolvedChips: ReadonlyArray<QuickReply> =
    quickReplies.length > 0
      ? quickReplies.map((qr) => ({ name: qr.label ?? qr.body, body: qr.body }))
      : DEFAULT_QUICK_REPLIES;

  // ---- Reusable: the quick-reply panel (chips + Custom entry). ----
  // Rendered inside both the compact widget and the expanded modal so the
  // affordance is consistent across layouts. Caller passes `compact` to scale
  // typography/padding.
  const renderReplyPanel = (compact: boolean) => {
    if (replyView === 'hidden') return null;

    if (replyView === 'custom') {
      return (
        <div className={compact ? 'mt-3 space-y-2' : 'mt-5 w-full max-w-[20rem] mx-auto text-left space-y-2'}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReplyView('chips')}
              aria-label="Back to quick replies"
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium text-slate-300 uppercase tracking-wider">
              Custom message
            </span>
          </div>
          <div className="flex items-stretch gap-2">
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend(customText);
                }
              }}
              rows={compact ? 2 : 3}
              autoFocus
              placeholder="Type a message…"
              aria-label="Custom reply message"
              className="flex-1 min-w-0 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/50 resize-none"
            />
            <button
              type="button"
              onClick={() => handleSend(customText)}
              disabled={!customText.trim()}
              aria-label="Send message and decline call"
              className="px-3 self-stretch flex items-center justify-center bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            Sends the text and declines the call.
          </p>
        </div>
      );
    }

    // replyView === 'chips'
    return (
      <div className={compact ? 'mt-3 space-y-2' : 'mt-5 w-full max-w-[20rem] mx-auto text-left space-y-2'}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-300 uppercase tracking-wider">
            Quick reply
          </span>
          <button
            type="button"
            onClick={() => setReplyView('hidden')}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
        </div>
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="Quick reply messages"
        >
          {resolvedChips.map((reply) => (
            <li key={reply.name}>
              <button
                type="button"
                onClick={() => handleSend(reply.body)}
                title={reply.body}
                className="max-w-full px-3 py-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 text-xs rounded-full border border-slate-700/60 transition-colors truncate"
              >
                {reply.name}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setReplyView('custom')}
              className="px-3 py-1.5 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-xs rounded-full border border-blue-500/30 transition-colors inline-flex items-center gap-1"
            >
              <MessageSquare className="w-3 h-3" />
              Custom…
            </button>
          </li>
        </ul>
      </div>
    );
  };

  // Compact floating widget
  if (!isExpanded) {
    return (
      <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 duration-300">
        <div className="bg-slate-900 rounded-2xl shadow-2xl shadow-slate-900/30 overflow-hidden min-w-[280px] max-w-[340px]">
          {/* Status bar */}
          <div className={`h-1 ${getStatusColor()}`} />

          {/* Content */}
          <div className="p-4">
            <div className="flex items-center gap-3 mb-3">
              {/* Caller avatar/icon */}
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                sentNotice
                  ? 'bg-emerald-500/20'
                  : state === 'active' ? 'bg-emerald-500/20' : 'bg-blue-500/20'
              }`}>
                {sentNotice ? (
                  <Check className="w-5 h-5 text-emerald-400" />
                ) : (
                  <Phone className={`w-5 h-5 ${
                    state === 'active' ? 'text-emerald-400' : 'text-blue-400'
                  } ${state === 'ringing' || state === 'dialing' ? 'animate-pulse' : ''}`} />
                )}
              </div>

              {/* Caller info */}
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold text-sm truncate">
                  {name || number}
                </p>
                <p className="text-slate-400 text-xs truncate">
                  {sentNotice ? sentNotice : (name ? number : getStatusText())}
                </p>
              </div>

              {/* Duration/Status badge */}
              <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                sentNotice
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : state === 'active'
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : state === 'ringing'
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-blue-500/20 text-blue-400'
              }`}>
                {getStatusText()}
              </div>
            </div>

            {/* Action buttons — hidden while showing "Message sent" confirmation */}
            {!sentNotice && (
              <div className="flex items-center gap-2">
                {/* Answer button (only for incoming calls) */}
                {state === 'ringing' && (
                  <button
                    onClick={answerCall}
                    aria-label="Answer call"
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Phone className="w-4 h-4" />
                    Answer
                  </button>
                )}

                {/* Reply affordance — ringing-only, gated against waitingCall.
                    Hidden once chips/custom panel is open (it owns the row below). */}
                {showReplyAffordance && replyView === 'hidden' && (
                  <button
                    onClick={() => setReplyView('chips')}
                    aria-label="Reply with message and decline"
                    title="Reply with message"
                    className="p-2.5 bg-slate-800 hover:bg-slate-700 text-blue-300 hover:text-blue-200 rounded-xl transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                  </button>
                )}

                {/* End/Decline button */}
                <button
                  onClick={endCall}
                  aria-label={state === 'ringing' ? 'Decline call' : 'End call'}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500 hover:bg-rose-600 text-white rounded-xl font-medium text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <PhoneOff className="w-4 h-4" />
                  {state === 'ringing' ? 'Decline' : 'End'}
                </button>

                {/* Expand button */}
                <button
                  onClick={() => setIsExpanded(true)}
                  aria-label="Expand call view"
                  title="Expand"
                  className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-xl transition-colors"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Reply panel: chips or custom-text composer. */}
            {!sentNotice && renderReplyPanel(true)}
          </div>
        </div>
      </div>
    );
  }

  // Expanded view (centered modal)
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 rounded-3xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header with minimize button */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${getStatusColor()} animate-pulse`} />
            <span className="text-slate-400 text-sm font-medium">
              {sentNotice
                ? 'Message sent'
                : state === 'ringing' ? 'Incoming Call'
                : state === 'dialing' ? 'Outgoing Call'
                : 'Active Call'}
            </span>
          </div>
          <button
            onClick={() => setIsExpanded(false)}
            aria-label="Minimize call view"
            title="Minimize"
            className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-8 text-center">
          {/* Avatar */}
          <div className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 ${
            sentNotice
              ? 'bg-emerald-500/20'
              : state === 'active' ? 'bg-emerald-500/20' : 'bg-blue-500/20'
          }`}>
            {sentNotice ? (
              <Check className="w-12 h-12 text-emerald-400" />
            ) : (
              <Phone className={`w-12 h-12 ${
                state === 'active' ? 'text-emerald-400' : 'text-blue-400'
              } ${state === 'ringing' || state === 'dialing' ? 'animate-pulse' : ''}`} />
            )}
          </div>

          {/* Caller info. When neither name nor number is available (phone
              didn't emit an incoming number — e.g. carrier hid the calling
              line, or modern-path emit fired before the number could be
              resolved), display "Number hidden" instead of "Unknown" so the
              user can distinguish "system didn't get a number" from "system
              got a number but we don't know whose it is". */}
          <h2 className="text-2xl font-bold text-white mb-1">
            {name || number || 'Number hidden'}
          </h2>
          <p className="text-slate-400 mb-2">
            {name ? number : ''}
          </p>

          {/* Duration/Status */}
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full mb-8 ${
            sentNotice
              ? 'bg-emerald-500/20 text-emerald-400'
              : state === 'active'
              ? 'bg-emerald-500/20 text-emerald-400'
              : state === 'ringing'
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-blue-500/20 text-blue-400'
          }`}>
            <div className={`w-2 h-2 rounded-full ${getStatusColor()} animate-pulse`} />
            <span className="font-medium">
              {sentNotice ?? getStatusText()}
            </span>
          </div>

          {/* Action buttons — hidden while showing "Message sent" confirmation */}
          {!sentNotice && (
            <div className="flex justify-center gap-4">
              {state === 'ringing' && (
                <button
                  onClick={answerCall}
                  aria-label="Answer call"
                  title="Answer"
                  className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 transition-all hover:scale-110 active:scale-95"
                >
                  <Phone className="w-7 h-7" />
                </button>
              )}

              {/* Reply affordance — ringing-only, gated against waitingCall. */}
              {showReplyAffordance && replyView === 'hidden' && (
                <button
                  onClick={() => setReplyView('chips')}
                  aria-label="Reply with message and decline"
                  title="Reply with message"
                  className="w-16 h-16 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/30 transition-all hover:scale-110 active:scale-95"
                >
                  <MessageSquare className="w-7 h-7" />
                </button>
              )}

              <button
                onClick={endCall}
                aria-label={state === 'ringing' ? 'Decline call' : 'End call'}
                title={state === 'ringing' ? 'Decline' : 'End Call'}
                className="w-16 h-16 rounded-full bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center shadow-lg shadow-rose-500/30 transition-all hover:scale-110 active:scale-95"
              >
                <PhoneOff className="w-7 h-7" />
              </button>
            </div>
          )}

          {/* Reply panel: chips or custom-text composer. */}
          {!sentNotice && renderReplyPanel(false)}
        </div>
      </div>
    </div>
  );
};
