'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smartphone, Users, MessageSquare, PhoneCall, X, Loader2, Lock, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import { capForRange, type RangeKey } from '@/lib/syncCaps';
import { SYNC_RANGE_WINDOW_DAYS } from '@/lib/tiers';
import { useUpgrade } from '@/hooks/upgradeModalContext';

// Time-range sync selection. The user picks how far back in time to pull
// data. Sending a `since` timestamp lets Android use an indexed WHERE clause
// instead of a full table scan — full scans time out on large databases.
//
// `RangeKey` is the canonical four-key type owned by `@/lib/syncCaps` so the
// UI options and the per-category cap map can never drift apart. "7 days" and
// "All time" were intentionally removed (locked 2026-05-27) — these four are
// the only supported ranges.

interface RangeOption {
  value: RangeKey;
  label: string;
}

const RANGE_OPTIONS: ReadonlyArray<RangeOption> = [
  { value: '30d', label: 'Last 30 days' },
  { value: '3mo', label: 'Last 3 months' },
  { value: '6mo', label: 'Last 6 months' },
  { value: '1yr', label: 'Last 1 year' },
];

const RANGE_TO_MS: Record<RangeKey, number> = {
  '30d': 30  * 24 * 60 * 60 * 1000,
  '3mo': 90  * 24 * 60 * 60 * 1000,
  '6mo': 180 * 24 * 60 * 60 * 1000,
  '1yr': 365 * 24 * 60 * 60 * 1000,
};

function rangeToSince(range: RangeKey): number {
  return Date.now() - RANGE_TO_MS[range];
}

interface SyncRowProps {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  checked: boolean;
  onToggle: () => void;
  rangeControl?: React.ReactNode;
  fullSyncNote?: string;
  /**
   * Informative count line rendered beneath the description (e.g. how many
   * messages fall in the chosen range, and the newest-N cap when the range
   * exceeds it). Calm and neutral — this is expected behaviour, not a warning.
   */
  countLine?: React.ReactNode;
  /**
   * Tier-lock (UX only — the relay enforces the real gate server-side). When
   * true the row reads as unavailable on the current plan: the checkbox is
   * disabled and unchecked, a "Plan" pill replaces the control, and `lockNote`
   * (an upgrade nudge) renders beneath the description. Locking here only sets
   * expectations — a locked feature is never toggleable regardless.
   */
  locked?: boolean;
  /** Upgrade nudge shown beneath the description when `locked`. */
  lockNote?: React.ReactNode;
}

function SyncRow({
  id,
  label,
  description,
  icon,
  checked,
  onToggle,
  rangeControl,
  fullSyncNote,
  countLine,
  locked,
  lockNote,
}: SyncRowProps) {
  return (
    <label
      htmlFor={id}
      className={clsx(
        'group flex items-start gap-3 p-3 rounded-xl border transition-colors select-none',
        locked
          ? 'border-slate-200 bg-slate-50/60 cursor-default'
          : checked
          ? 'border-blue-200 bg-blue-50/50 cursor-pointer'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 cursor-pointer'
      )}
    >
      {/* Checkbox (or lock glyph when the feature is tier-locked) */}
      <span className="flex-shrink-0 pt-0.5">
        <input
          id={id}
          type="checkbox"
          checked={locked ? false : checked}
          onChange={onToggle}
          disabled={locked}
          className="sr-only peer"
        />
        <span
          aria-hidden="true"
          className={clsx(
            'w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all',
            locked
              ? 'bg-slate-100 border-slate-200 text-slate-400'
              : checked
              ? 'bg-blue-600 border-blue-600'
              : 'bg-white border-slate-300 group-hover:border-slate-400'
          )}
        >
          {locked ? (
            <Lock className="w-3 h-3" />
          ) : checked ? (
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : null}
        </span>
      </span>

      {/* Icon */}
      <span
        aria-hidden="true"
        className={clsx(
          'flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
          locked ? 'bg-slate-100 text-slate-400' : checked ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
        )}
      >
        {icon}
      </span>

      {/* Label + control */}
      <span className="flex-1 min-w-0">
        <span className="flex items-center justify-between gap-3 flex-wrap">
          <span className={clsx('font-semibold text-sm', locked ? 'text-slate-500' : 'text-slate-800')}>
            {label}
          </span>
          {locked ? (
            <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <Lock className="h-2.5 w-2.5" aria-hidden="true" />
              Plus
            </span>
          ) : rangeControl ? (
            <span
              // Stop the label's click from toggling the checkbox when the user clicks the dropdown
              onClick={(e) => e.preventDefault()}
              className="flex-shrink-0"
            >
              {rangeControl}
            </span>
          ) : fullSyncNote ? (
            <span className="text-xs font-medium text-slate-500">{fullSyncNote}</span>
          ) : null}
        </span>
        <span className="block text-xs text-slate-500 mt-0.5">{description}</span>
        {locked && lockNote ? (
          <span className="mt-1.5 block">{lockNote}</span>
        ) : countLine ? (
          <span className="block text-xs text-slate-500 mt-1" aria-live="polite">
            {countLine}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export const SyncSetupPanel = () => {
  // Cast to `any` per the integration plan — the hook's type is being updated
  // by another agent in parallel. We intentionally avoid coupling to the
  // in-progress type to keep this component compiling.
  const {
    syncEstimate,
    showSyncPanel,
    dismissSyncPanel,
    syncData,
    requestSyncPreview,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = usePhone() as any;

  // Memoize the dismiss callback so its identity is stable across renders
  // (the raw fallback `() => {}` would otherwise create a new function each
  // render and re-trigger our effects). This also satisfies
  // react-hooks/exhaustive-deps.
  const dismiss = useMemo<() => void>(
    () => dismissSyncPanel ?? (() => {}),
    [dismissSyncPanel]
  );

  const [contacts, setContacts] = useState(true);
  const [messages, setMessages] = useState(true);
  const [callLogs, setCallLogs] = useState(true);
  // Default to "Last 30 days" — covers the typical user's recent communication
  // without pulling months of dormant data on first sync. Contacts is always
  // a full sync (no range — see contactsNote below). A deeper range (up to
  // 1 year) is one click away if the user wants more history.
  const [messageRange, setMessageRange] = useState<RangeKey>('30d');
  const [callLogRange, setCallLogRange] = useState<RangeKey>('30d');

  // ── Tier gating (UX LAYER ONLY) ──────────────────────────────────────────
  // The relay (server.js) is the REAL, authoritative gate: it drops
  // GET_CONTACTS for tiers without contactSync and clamps the GET_MESSAGES /
  // GET_CALL_LOGS `since` to the tier's window. Everything below only REFLECTS
  // that server-side truth so a locked feature reads as locked with an upgrade
  // nudge — it never grants access and never substitutes for the real gate.
  const { entitlement, openUpgrade } = useUpgrade();
  // Permissive while entitlement is loading so the panel never flashes a lock
  // and then unlocks. The server stays authoritative regardless of this default.
  const contactSyncAllowed = entitlement ? entitlement.limits.contactSync : true;
  const maxRangeKey: RangeKey = entitlement?.limits.syncRangeMax ?? '1yr';
  const maxRangeDays = SYNC_RANGE_WINDOW_DAYS[maxRangeKey] ?? Infinity;
  const rangeAllowed = (r: RangeKey): boolean =>
    (SYNC_RANGE_WINDOW_DAYS[r] ?? Infinity) <= maxRangeDays;

  // Effective selections — DERIVED, never stored, so there is no
  // set-state-in-effect. Clamp a stored range the tier no longer allows (e.g.
  // entitlement resolved to Solo after the user picked "1 year" while it was
  // still loading) and force contacts off when the tier can't sync them.
  const effMessageRange: RangeKey = rangeAllowed(messageRange) ? messageRange : '30d';
  const effCallLogRange: RangeKey = rangeAllowed(callLogRange) ? callLogRange : '30d';
  const effContacts = contacts && contactSyncAllowed;

  // Per-row preview counts. We keep these LOCAL to each row rather than reading
  // the shared `syncEstimate` live, because the phone's SYNC_ESTIMATE response
  // only carries the categories we asked for and the hook zero-fills the rest —
  // so a messages-only preview would otherwise clobber the call-logs count to 0
  // (and vice versa). Each row caches its own last-known total and only updates
  // when a response for ITS category arrives. `undefined` = not yet counted.
  const [messageCount, setMessageCount] = useState<number | undefined>(undefined);
  const [callLogCount, setCallLogCount] = useState<number | undefined>(undefined);
  const [messageCounting, setMessageCounting] = useState(false);
  const [callLogCounting, setCallLogCounting] = useState(false);

  // Contacts has no range — its total comes from the initial all-categories
  // estimate. Cache it locally so our subsequent single-category message /
  // call-log previews (which zero-fill the categories they don't request)
  // can't blank the contacts count out from under the row.
  const [contactsCount, setContactsCount] = useState<number | undefined>(undefined);

  // Which category the most recent in-flight preview was requested for. Used to
  // route the shared SYNC_ESTIMATE response back to the right row and to ignore
  // the zero-filled "other" category in that same response.
  const pendingPreviewRef = useRef<'messages' | 'callLogs' | null>(null);

  // Portal guard — derived, not stateful, so React 19's set-state-in-effect
  // rule stays happy. document only exists client-side.
  const mounted = typeof document !== 'undefined';

  // Lock background scroll while the modal is open
  useEffect(() => {
    if (!showSyncPanel) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [showSyncPanel]);

  // Close on Escape
  useEffect(() => {
    if (!showSyncPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSyncPanel, dismiss]);

  // Debounced count preview — Messages row. When the panel is open, the row is
  // enabled, and a preview function is available, re-count the chosen range
  // ~400ms after the user stops changing it. The phone reports the TRUE total
  // for the range; the cap line (rendered below) is derived separately from
  // `capForRange`, so the count itself stays honest.
  useEffect(() => {
    if (!showSyncPanel || !messages || typeof requestSyncPreview !== 'function') return;
    // `setCounting(true)` lives inside the timeout (async, not the effect's
    // synchronous render path) so we (a) don't trip ESLint's set-state-in-effect
    // rule and (b) only show "Counting…" once the request actually goes out —
    // no flicker while the user is still dragging through ranges.
    const t = setTimeout(() => {
      setMessageCounting(true);
      pendingPreviewRef.current = 'messages';
      requestSyncPreview({
        since: rangeToSince(effMessageRange),
        until: Date.now(),
        types: ['messages'],
      });
    }, 400);
    return () => clearTimeout(t);
  }, [showSyncPanel, messages, effMessageRange, requestSyncPreview]);

  // Debounced count preview — Call Logs row. Mirror of the Messages effect.
  useEffect(() => {
    if (!showSyncPanel || !callLogs || typeof requestSyncPreview !== 'function') return;
    const t = setTimeout(() => {
      setCallLogCounting(true);
      pendingPreviewRef.current = 'callLogs';
      requestSyncPreview({
        since: rangeToSince(effCallLogRange),
        until: Date.now(),
        types: ['callLogs'],
      });
    }, 400);
    return () => clearTimeout(t);
  }, [showSyncPanel, callLogs, effCallLogRange, requestSyncPreview]);

  // Route a SYNC_ESTIMATE response to the row that asked for it. The shared
  // estimate zero-fills categories we didn't request, so we only trust the
  // total for the category named in `pendingPreviewRef` and leave the other
  // row's cached count untouched. This is the legitimate React-as-sync-target
  // pattern (external WS response → UI). We schedule the state updates on a
  // setTimeout(0) microtask, matching PhoneModeShell's convention, so the
  // writes happen OUT of the effect's synchronous render path — same observable
  // behaviour, no set-state-in-effect cascading-render warning.
  useEffect(() => {
    if (!syncEstimate) return;
    const target = pendingPreviewRef.current;
    const contactsTotal: number | undefined = syncEstimate.contacts?.total;
    const messagesTotal: number | undefined = syncEstimate.messages?.total;
    const callLogsTotal: number | undefined = syncEstimate.callLogs?.total;
    const id = window.setTimeout(() => {
      if (target === 'messages') {
        setMessageCount(messagesTotal ?? 0);
        setMessageCounting(false);
      } else if (target === 'callLogs') {
        setCallLogCount(callLogsTotal ?? 0);
        setCallLogCounting(false);
      } else {
        // No targeted preview in flight — this is the initial all-categories
        // estimate. Seed each row's cached count, but only adopt a category's
        // total when it's actually present and non-zero so a stale zero-fill
        // can't wipe a previously-known count.
        if (messagesTotal) setMessageCount((prev) => prev ?? messagesTotal);
        if (callLogsTotal) setCallLogCount((prev) => prev ?? callLogsTotal);
      }
      // Contacts has no targeted preview path, so always keep its cache fresh
      // whenever a response carries a real (non-zero) contacts total.
      if (contactsTotal) setContactsCount(contactsTotal);
    }, 0);
    return () => window.clearTimeout(id);
  }, [syncEstimate]);

  if (!mounted || !showSyncPanel) return null;

  // Panel opens immediately when phone connects — no blocking on estimate.
  // Estimate fires in the background; contactsTotal updates when it arrives.
  const isLoadingEstimate = false; // never block UI on estimate

  const contactsNote =
    contactsCount != null
      ? `${contactsCount.toLocaleString()} contacts — full sync`
      : 'Contacts — full sync';

  // Build the per-row count line. Calm and informative — never alarming. When
  // the true total exceeds the range's cap, we say plainly that we'll sync the
  // most recent N; this is normal, expected behaviour, not an error.
  const renderCountLine = (
    counting: boolean,
    total: number | undefined,
    range: RangeKey,
    noun: string,
  ): React.ReactNode => {
    if (counting && total == null) {
      return (
        <span className="inline-flex items-center gap-1.5 text-slate-400">
          <Loader2 className="w-3 h-3 motion-safe:animate-spin" aria-hidden="true" />
          Counting&hellip;
        </span>
      );
    }
    if (total == null) return null;
    const cap = capForRange(range);
    const totalLabel = total.toLocaleString();
    if (total > cap) {
      return (
        <>
          {totalLabel} {noun} in this range &middot; we&rsquo;ll sync the most recent{' '}
          {cap.toLocaleString()}
        </>
      );
    }
    return (
      <>
        {totalLabel} {noun} in this range
      </>
    );
  };

  // Short human labels for the tier's max window, used in the range-lock hint.
  const RANGE_SHORT_LABEL: Record<RangeKey, string> = {
    '30d': '30 days',
    '3mo': '3 months',
    '6mo': '6 months',
    '1yr': '1 year',
  };

  // When the tier can't reach the widest window, show a calm upgrade hint under
  // the message/call-log rows. Rendered as a button that preventDefaults so a
  // click inside the <label> row opens the modal instead of toggling the row.
  const someRangeLocked = maxRangeDays < (SYNC_RANGE_WINDOW_DAYS['1yr'] ?? 365);
  const rangeLockHint = someRangeLocked ? (
    <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
      <Lock className="h-3 w-3 flex-shrink-0 text-slate-400" aria-hidden="true" />
      Up to {RANGE_SHORT_LABEL[maxRangeKey]} on your plan.
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          openUpgrade('syncRange');
        }}
        className="inline-flex items-center gap-0.5 font-semibold text-blue-600 transition-colors hover:text-blue-700 focus:outline-none focus-visible:underline"
      >
        Upgrade
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  ) : null;

  const messageCountLine = messages ? (
    <>
      {renderCountLine(messageCounting, messageCount, effMessageRange, 'messages')}
      {rangeLockHint}
    </>
  ) : null;
  const callLogCountLine = callLogs ? (
    <>
      {renderCountLine(callLogCounting, callLogCount, effCallLogRange, 'calls')}
      {rangeLockHint}
    </>
  ) : null;

  // Upgrade nudge shown inside the locked Contacts row.
  const contactsLockNote = (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
      Contact sync is on Plus and Pro.
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          openUpgrade('contactSync');
        }}
        className="inline-flex items-center gap-0.5 font-semibold text-blue-600 transition-colors hover:text-blue-700 focus:outline-none focus-visible:underline"
      >
        See plans
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );

  const handleStartSync = () => {
    if (!syncData) {
      // Hook hasn't shipped syncData yet — just dismiss gracefully.
      dismiss();
      return;
    }
    syncData({
      // Use the EFFECTIVE selections so the request already respects the tier
      // (contacts off when locked, ranges clamped to the tier window). The relay
      // enforces the same limits server-side — this just keeps the client from
      // asking for something it will be denied.
      contacts: effContacts,
      messages,
      messageSince: messages ? rangeToSince(effMessageRange) : undefined,
      // Per-category newest-N cap. Bounds what actually transfers so a large
      // sync can't crash the device; the preview count stays truthful.
      messageLimit: messages ? capForRange(effMessageRange) : undefined,
      callLogs,
      callLogSince: callLogs ? rangeToSince(effCallLogRange) : undefined,
      callLogLimit: callLogs ? capForRange(effCallLogRange) : undefined,
    });
    dismiss();
  };

  const nothingSelected = !effContacts && !messages && !callLogs;

  const node = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-setup-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Dismiss sync setup"
        onClick={dismiss}
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm cursor-default"
      />

      {/* Card */}
      <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl shadow-slate-900/20 overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-500/20">
              <Smartphone className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 id="sync-setup-title" className="text-base font-bold text-slate-900">
                Phone Connected
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Choose what to sync from your phone
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="p-1.5 -m-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isLoadingEstimate ? (
          // Loading state — estimate hasn't arrived yet.
          <div
            className="p-6 flex items-center justify-center gap-3 text-sm text-slate-600"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="w-4 h-4 text-slate-400 motion-safe:animate-spin"
              aria-hidden="true"
            />
            <span>Counting your data&hellip;</span>
          </div>
        ) : (
          <>
            {/* Body */}
            <div className="p-4 space-y-2.5">
              <SyncRow
                id="sync-contacts"
                label="Contacts"
                description="Names and phone numbers from your address book"
                icon={<Users className="w-4 h-4" />}
                checked={contacts}
                onToggle={() => setContacts((v) => !v)}
                fullSyncNote={contactsNote}
                locked={!contactSyncAllowed}
                lockNote={contactsLockNote}
              />

              <SyncRow
                id="sync-messages"
                label="Messages"
                description="SMS and MMS conversations"
                icon={<MessageSquare className="w-4 h-4" />}
                checked={messages}
                onToggle={() => setMessages((v) => !v)}
                rangeControl={
                  <RangeSelect
                    value={effMessageRange}
                    onChange={setMessageRange}
                    disabled={!messages}
                    isAllowed={rangeAllowed}
                    ariaLabel="Message time range"
                  />
                }
                countLine={messageCountLine}
              />

              <SyncRow
                id="sync-calllogs"
                label="Call Logs"
                description="Incoming, outgoing, and missed call history"
                icon={<PhoneCall className="w-4 h-4" />}
                checked={callLogs}
                onToggle={() => setCallLogs((v) => !v)}
                rangeControl={
                  <RangeSelect
                    value={effCallLogRange}
                    onChange={setCallLogRange}
                    disabled={!callLogs}
                    isAllowed={rangeAllowed}
                    ariaLabel="Call log time range"
                  />
                }
                countLine={callLogCountLine}
              />
            </div>

            {/* Footer */}
            <div className="px-4 pb-4 pt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={handleStartSync}
                disabled={nothingSelected}
                className={clsx(
                  'flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl transition-all shadow-sm',
                  nothingSelected
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-500/20 hover:shadow-md active:scale-[0.98]'
                )}
              >
                Start Sync
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(node, document.body);
};

interface RangeSelectProps {
  value: RangeKey;
  onChange: (v: RangeKey) => void;
  disabled?: boolean;
  /**
   * Tier gate (UX only). Ranges wider than the tier's window render as disabled
   * <option>s so they can't be picked; the real clamp is server-side in the
   * relay. Omitted → every range is selectable.
   */
  isAllowed?: (r: RangeKey) => boolean;
  ariaLabel: string;
}

function RangeSelect({ value, onChange, disabled, isAllowed, ariaLabel }: RangeSelectProps) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      // Prevent the surrounding <label> from intercepting the dropdown opening
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as RangeKey)}
      className={clsx(
        'text-xs font-medium border rounded-lg px-2 py-1 bg-white transition-colors cursor-pointer',
        'focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400',
        disabled
          ? 'border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed'
          : 'border-slate-300 text-slate-700 hover:border-slate-400'
      )}
    >
      {RANGE_OPTIONS.map((opt) => {
        const locked = isAllowed ? !isAllowed(opt.value) : false;
        return (
          <option key={opt.value} value={opt.value} disabled={locked}>
            {opt.label}
            {locked ? ' (upgrade)' : ''}
          </option>
        );
      })}
    </select>
  );
}
