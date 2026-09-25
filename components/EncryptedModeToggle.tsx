'use client';

import React, { useCallback, useId, useState } from 'react';
import { Lock } from 'lucide-react';

import { usePhone } from '@/hooks';
import { EncryptedModeConfirmDialog } from '@/components/EncryptedModeConfirmDialog';
import {
  clearAccountPrefError,
  requestAccountPrefChange,
  useAccountE2ePref,
} from '@/lib/e2eAccountPref';
import {
  changedFromLine,
  reconnectingCopy,
  stateLabel,
  SAVING_COPY,
  type E2ePrefValue,
} from '@/lib/e2eAccountPref-core';
import {
  SETTING_LABEL,
  SETTING_DESCRIPTION,
  SETTING_REPAIR_NOTICE,
  settingAvailability,
  type E2eErrorName,
  type PeerSupport,
} from '@/lib/encryptedModeCopy';

/**
 * components/EncryptedModeToggle.tsx — E2E-P5a (a).
 *
 * ONE implementation, two surfaces. /app Settings renders `variant="row"`; the
 * extension's account menu renders `variant="menuitem"`. They are variants
 * rather than two components because this is a security setting: two
 * implementations would be two places for the disabled-reason logic to drift,
 * and the failure mode of that drift is a switch that is operable on one
 * surface and greyed on the other for the same pair — which reads to the user
 * as the product being wrong about whether their data is protected.
 *
 * Everything that decides is in lib/encryptedModeCopy.ts (availability) and
 * lib/e2eAccountPref-core.ts (the account value). This file is layout, ARIA
 * and the click.
 *
 * ── THE SWITCH IS THE ACCOUNT'S (T-E2E-ACCOUNT-PREF step 3) ──────────────────
 * It shows and changes ONE value per account, stored on the server and synced
 * to every signed-in device. A tap never flips it: it opens the confirm
 * (components/EncryptedModeConfirmDialog.tsx) because a change disconnects the
 * phone AND this computer, and both pair again in the new mode. Nothing moves
 * on screen until the server answers — the switch keeps showing the account
 * value, and the status line says what is happening ("Saving", then
 * "Reconnecting in …" while our own socket is reset). `mode` below is the
 * account PREFERENCE, so "On, paused by ComputerCaller" keeps the switch ON
 * and says why the code check is not running (§3: never a plain Off).
 *
 * ── DARK MODE COMES FOR FREE, AND ONLY IF I STAY INSIDE THE PALETTE ─────────
 * app/extension/extension.css remaps a FIXED LIST of light Tailwind utilities
 * under `[data-cc-theme=dark] .cc-ext` (bg-white, bg-slate-50/100/200,
 * text-slate-400…900, border-slate-100/200/300, and the state inks
 * text-emerald-700 / text-amber-700 / text-red-600-700). /app has no dark mode
 * at all, so a `dark:` variant here would be a D4 violation. Every class below
 * is drawn from that remapped list on purpose — a colour outside it renders
 * correctly on /app and goes muddy or invisible in the extension's dark theme,
 * with nothing failing loudly enough to notice.
 */

interface EncryptedModeToggleProps {
  variant?: 'row' | 'menuitem';
  /** Kept for the call sites; the account value is keyed by the session's
   *  userId inside lib/e2eAccountPref.ts, not by this email. */
  email?: string | null;
}

export function EncryptedModeToggle({ variant = 'row' }: EncryptedModeToggleProps) {
  const phone = usePhone() as {
    e2e?: { mode: 'off' | 'on'; error?: E2eErrorName; peer: { supports: PeerSupport } };
    phonePresentInLobby?: boolean;
    lobbyState?: string;
  };

  const e2e = phone?.e2e;
  // `'unknown'`, not `false`: no view at all means nobody has answered, and
  // `false` is reserved for a phone that answered no. This default used to be
  // the second source of the standby "needs v58" claim.
  const peer: { supports: PeerSupport } = e2e?.peer ?? { supports: 'unknown' };
  // The LOBBY's fact about the phone, read from the lobby's own state. The
  // encryption state machine is never asked whether a phone is connected — see
  // the independence rule in lib/encryptedModeCopy.ts.
  const phonePresent = Boolean(phone?.phonePresentInLobby) || phone?.lobbyState === 'active';

  const account = useAccountE2ePref();
  const resolved = account.mirror?.resolved ?? null;
  const mode: E2ePrefValue = resolved?.preference ?? 'off';
  const paused = resolved?.pausedByServer === true;
  const availability = settingAvailability(peer, phonePresent, e2e?.error);
  // Operable only once the account value is known (mirror or server) and no
  // write is in flight. A tap before that would ask a question about a value
  // the screen has not shown yet.
  const operable = availability.enabled && resolved !== null && account.phase === 'idle';

  const [confirming, setConfirming] = useState<E2ePrefValue | null>(null);
  // Read once per mount; the "at 14:32" vs "24 Sep, 14:32" choice does not
  // need to tick while the row is on screen.
  const [now] = useState(() => new Date());

  const descId = useId();
  const noticeId = useId();
  const statusId = useId();

  // Kept from P5a: the account asks for ON but the pair on screen is not
  // encrypted, so the change applies at the next pairing. Rare now that every
  // change resets both sides; never shown while paused (that line explains it).
  const showRepairNotice = mode === 'on' && phone?.lobbyState === 'active' && phone?.e2e?.mode !== 'on';

  const onToggle = useCallback(() => {
    if (!operable) return;
    clearAccountPrefError();
    setConfirming(mode === 'on' ? 'off' : 'on');
  }, [operable, mode]);

  const onConfirm = useCallback((value: E2ePrefValue) => {
    setConfirming(null);
    void requestAccountPrefChange(value);
  }, []);
  const onCancel = useCallback(() => setConfirming(null), []);

  const stateKey = !resolved ? 'loading' : paused ? 'paused' : mode;
  const activity =
    account.phase === 'saving' ? SAVING_COPY
      : account.phase === 'reconnecting' && account.target ? reconnectingCopy(account.target)
        : null;
  const changedLine = changedFromLine(resolved, now);

  const describedBy = [
    statusId,
    availability.reason ? descId : null,
    showRepairNotice && !paused ? noticeId : null,
  ].filter(Boolean).join(' ');

  // The status line: the account state, then what is happening to it. It is
  // the switch's description AND a polite live region, so "Saving" and
  // "Reconnecting…" are announced without moving focus.
  const statusLine = (small: boolean) => (
    <span
      id={statusId}
      role="status"
      aria-live="polite"
      data-cc-e2e-state={stateKey}
      data-cc-e2e-phase={account.phase}
      className={`block leading-snug break-words ${small ? 'mt-0.5 pr-1' : 'mt-2'}`}
    >
      <span className={paused ? 'font-medium text-amber-700' : 'font-medium text-slate-700'}>
        {stateLabel(resolved)}
      </span>
      {activity && (
        <span className="block text-slate-500" data-cc-e2e-activity="">{activity}</span>
      )}
      {account.error && (
        <span className="block text-red-700" data-cc-e2e-error="">{account.error}</span>
      )}
      {changedLine && !activity && (
        <span className="block text-slate-500" data-cc-e2e-changed="">{changedLine}</span>
      )}
    </span>
  );

  const dialog = (
    <EncryptedModeConfirmDialog value={confirming} onConfirm={onConfirm} onCancel={onCancel} />
  );

  if (variant === 'menuitem') {
    return (
      <div className="px-1 pb-1">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={mode === 'on'}
          aria-disabled={!operable}
          aria-describedby={describedBy}
          data-cc-e2e-toggle="menuitem"
          data-cc-e2e-enabled={availability.enabled ? 'true' : 'false'}
          data-cc-e2e-reason={availability.reasonKey ?? ''}
          data-cc-e2e-busy={account.phase === 'idle' ? 'false' : 'true'}
          onClick={onToggle}
          className={
            'cc-e2e-surface flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left text-[11px] transition-colors ' +
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 ' +
            (operable
              ? 'text-slate-700 hover:bg-slate-100 cursor-pointer'
              : 'text-slate-400 cursor-not-allowed')
          }
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">{SETTING_LABEL}</span>
              <SwitchTrack checked={mode === 'on'} disabled={!operable} small />
            </span>
            {statusLine(true)}
            {availability.reason && (
              <span id={descId} className="mt-0.5 block break-words pr-1 leading-snug text-slate-500">
                {availability.reason}
              </span>
            )}
            {showRepairNotice && !paused && (
              <span id={noticeId} className="mt-0.5 block break-words pr-1 leading-snug text-slate-500">
                {SETTING_REPAIR_NOTICE}
              </span>
            )}
          </span>
        </button>
        {dialog}
      </div>
    );
  }

  return (
    <div
      className="cc-e2e-surface rounded-2xl border border-slate-200 bg-white p-5"
      data-cc-e2e-toggle="row"
      data-cc-e2e-enabled={availability.enabled ? 'true' : 'false'}
      data-cc-e2e-reason={availability.reasonKey ?? ''}
      data-cc-e2e-busy={account.phase === 'idle' ? 'false' : 'true'}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* The tinted icon disc is the /app Settings page's own heading idiom
              — Layout and Phone connection both use it. Matching it is not
              decoration: a security setting that arrives styled differently
              from the rows around it reads as bolted on, and the one control
              that most needs to look native to the product is this one. */}
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-100 text-slate-600"
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            {SETTING_LABEL}
          </h3>
          <p className="mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-slate-600">
            {SETTING_DESCRIPTION}
          </p>
          <div className="max-w-[52ch] text-[13px]">{statusLine(false)}</div>
          {availability.reason && (
            <p id={descId} className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-slate-500">
              {availability.reason}
            </p>
          )}
          {showRepairNotice && !paused && (
            <p id={noticeId} className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-slate-500">
              {SETTING_REPAIR_NOTICE}
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={mode === 'on'}
          aria-label={SETTING_LABEL}
          aria-describedby={describedBy}
          disabled={!operable}
          onClick={onToggle}
          className="mt-0.5 flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed"
        >
          <SwitchTrack checked={mode === 'on'} disabled={!operable} />
        </button>
      </div>
      {dialog}
    </div>
  );
}

/**
 * The switch itself. Presentational — the real `role="switch"` /
 * `role="menuitemcheckbox"` lives on the parent so each surface keeps the
 * semantics its container demands (a menu wants a menuitem, a settings row
 * wants a switch) without two copies of the visual.
 *
 * Motion: the knob travel is a Tailwind `transition-transform` (150ms). There is
 * NO blanket reduced-motion rule in app/globals.css — the only one there is
 * scoped to the reviews marquee — so this is covered explicitly by the
 * `.cc-e2e-motion` block added in globals.css for P5a, which the dialog and the
 * badge share. Checked rather than assumed: assuming a global guard exists is
 * how "we respect reduced motion" becomes a claim nobody ever tested.
 */
function SwitchTrack({ checked, disabled, small = false }: { checked: boolean; disabled: boolean; small?: boolean }) {
  const h = small ? 'h-4 w-7' : 'h-5 w-9';
  const k = small ? 'h-3 w-3' : 'h-4 w-4';
  const x = small ? (checked ? 'translate-x-3.5' : 'translate-x-0.5') : checked ? 'translate-x-4' : 'translate-x-0.5';
  return (
    <span
      aria-hidden="true"
      className={
        `relative inline-flex ${h} flex-shrink-0 items-center rounded-full transition-colors ` +
        (disabled ? 'bg-slate-200 opacity-60 ' : checked ? 'bg-emerald-600 ' : 'bg-slate-300 ')
      }
    >
      <span className={`inline-block ${k} transform rounded-full bg-white shadow transition-transform ${x}`} />
    </span>
  );
}
