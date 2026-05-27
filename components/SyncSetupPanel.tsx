'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smartphone, Users, MessageSquare, PhoneCall, X, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import { capForRange, type RangeKey as CapRangeKey } from '@/lib/syncCaps';

// Time-range sync selection. The user picks how far back in time to pull
// data (or "All time" for no cap). Sending a `since` timestamp lets Android
// use an indexed WHERE clause instead of a full table scan — full scans
// time out on large databases. The Android side enforces its own row cap,
// so we don't need to send a `limit` from the client.
type RangeKey = '7d' | '30d' | '3mo' | '6mo' | '1yr' | 'all';

interface RangeOption {
  value: RangeKey;
  label: string;
}

const RANGE_OPTIONS: ReadonlyArray<RangeOption> = [
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '3mo', label: 'Last 3 months' },
  { value: '6mo', label: 'Last 6 months' },
  { value: '1yr', label: 'Last 1 year' },
  { value: 'all', label: 'All time' },
];

const RANGE_TO_MS: Record<RangeKey, number> = {
  '7d':  7   * 24 * 60 * 60 * 1000,
  '30d': 30  * 24 * 60 * 60 * 1000,
  '3mo': 90  * 24 * 60 * 60 * 1000,
  '6mo': 180 * 24 * 60 * 60 * 1000,
  '1yr': 365 * 24 * 60 * 60 * 1000,
  'all': 0,
};

function rangeToSince(range: RangeKey): number {
  if (range === 'all') return 0;
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
}: SyncRowProps) {
  return (
    <label
      htmlFor={id}
      className={clsx(
        'group flex items-start gap-3 p-3 rounded-xl border transition-colors cursor-pointer select-none',
        checked
          ? 'border-blue-200 bg-blue-50/50'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
      )}
    >
      {/* Checkbox */}
      <span className="flex-shrink-0 pt-0.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="sr-only peer"
        />
        <span
          aria-hidden="true"
          className={clsx(
            'w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all',
            checked
              ? 'bg-blue-600 border-blue-600'
              : 'bg-white border-slate-300 group-hover:border-slate-400'
          )}
        >
          {checked && (
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
      </span>

      {/* Icon */}
      <span
        aria-hidden="true"
        className={clsx(
          'flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
          checked ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
        )}
      >
        {icon}
      </span>

      {/* Label + control */}
      <span className="flex-1 min-w-0">
        <span className="flex items-center justify-between gap-3 flex-wrap">
          <span className="font-semibold text-sm text-slate-800">{label}</span>
          {rangeControl ? (
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
      </span>
    </label>
  );
}

export const SyncSetupPanel = () => {
  // Cast to `any` per the integration plan — the hook's type is being updated
  // by another agent in parallel. We intentionally avoid coupling to the
  // in-progress type to keep this component compiling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { syncEstimate, showSyncPanel, dismissSyncPanel, syncData } = usePhone() as any;

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
  // Default to "Last 3 months" — covers the typical user's recent communication
  // without pulling years of dormant data on first sync. Contacts is always
  // a full sync (no range — see contactsNote below). "All time" is one click
  // away if the user wants deeper history.
  const [messageRange, setMessageRange] = useState<RangeKey>('3mo');
  const [callLogRange, setCallLogRange] = useState<RangeKey>('3mo');

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

  if (!mounted || !showSyncPanel) return null;

  // Panel opens immediately when phone connects — no blocking on estimate.
  // Estimate fires in the background; contactsTotal updates when it arrives.
  const isLoadingEstimate = false; // never block UI on estimate

  const contactsTotal: number | undefined = syncEstimate?.contacts?.total;

  const contactsNote =
    contactsTotal != null
      ? `${contactsTotal.toLocaleString()} contacts — full sync`
      : 'Contacts — full sync';

  const handleStartSync = () => {
    if (!syncData) {
      // Hook hasn't shipped syncData yet — just dismiss gracefully.
      dismiss();
      return;
    }
    syncData({
      contacts,
      messages,
      messageSince: messages ? rangeToSince(messageRange) : undefined,
      // Per-category newest-N cap. Bounds what actually transfers so a large
      // sync can't crash the device; the preview count stays truthful.
      messageLimit: messages ? capForRange(messageRange as CapRangeKey) : undefined,
      callLogs,
      callLogSince: callLogs ? rangeToSince(callLogRange) : undefined,
      callLogLimit: callLogs ? capForRange(callLogRange as CapRangeKey) : undefined,
    });
    dismiss();
  };

  const nothingSelected = !contacts && !messages && !callLogs;

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
                    value={messageRange}
                    onChange={setMessageRange}
                    disabled={!messages}
                    ariaLabel="Message time range"
                  />
                }
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
                    value={callLogRange}
                    onChange={setCallLogRange}
                    disabled={!callLogs}
                    ariaLabel="Call log time range"
                  />
                }
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
  ariaLabel: string;
}

function RangeSelect({ value, onChange, disabled, ariaLabel }: RangeSelectProps) {
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
      {RANGE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
