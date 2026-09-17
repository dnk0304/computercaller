'use client';

import React, { useCallback, useId } from 'react';
import { Lock } from 'lucide-react';

import { usePhone } from '@/hooks';
import { useEncryptedModePref } from '@/lib/encryptedModePref';
import {
  SETTING_LABEL,
  SETTING_DESCRIPTION,
  SETTING_REPAIR_NOTICE,
  settingAvailability,
  type E2eErrorName,
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
 * Everything that decides is in lib/encryptedModeCopy.ts. This file is layout,
 * ARIA and the click.
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
  /** Settings knows the signed-in email; the account menu already has it too.
   *  Passing it avoids a second /api/auth/me probe per surface. */
  email?: string | null;
}

export function EncryptedModeToggle({ variant = 'row', email = null }: EncryptedModeToggleProps) {
  const phone = usePhone() as {
    e2e?: { mode: 'off' | 'on'; error?: E2eErrorName; peer: { supports: boolean } };
    phonePresentInLobby?: boolean;
    lobbyState?: string;
  };

  const e2e = phone?.e2e;
  const peer = e2e?.peer ?? { supports: false };
  // The LOBBY's fact about the phone, read from the lobby's own state. The
  // encryption state machine is never asked whether a phone is connected — see
  // the independence rule in lib/encryptedModeCopy.ts.
  const phonePresent = Boolean(phone?.phonePresentInLobby) || phone?.lobbyState === 'active';

  const [mode, setMode] = useEncryptedModePref(email);
  const availability = settingAvailability(peer, phonePresent, e2e?.error);

  const descId = useId();
  const noticeId = useId();

  // A pair is already latched, so flipping the setting cannot change it (§12.2:
  // the SAS is a pairing-time step). The notice is rendered, not a toast: it is
  // still true a minute later, and there is nothing to dismiss.
  const showRepairNotice = mode === 'on' && phone?.lobbyState === 'active';

  const onToggle = useCallback(() => {
    if (!availability.enabled) return;
    setMode(mode === 'on' ? 'off' : 'on');
  }, [availability.enabled, mode, setMode]);

  const describedBy = [availability.reason ? descId : null, showRepairNotice ? noticeId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  if (variant === 'menuitem') {
    return (
      <div className="px-1 pb-1">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={mode === 'on'}
          aria-disabled={!availability.enabled}
          aria-describedby={describedBy}
          data-cc-e2e-toggle="menuitem"
          data-cc-e2e-enabled={availability.enabled ? 'true' : 'false'}
          data-cc-e2e-reason={availability.reasonKey ?? ''}
          onClick={onToggle}
          className={
            'flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left text-[11px] transition-colors ' +
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 ' +
            (availability.enabled
              ? 'text-slate-700 hover:bg-slate-100 cursor-pointer'
              : 'text-slate-400 cursor-not-allowed')
          }
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">{SETTING_LABEL}</span>
              <SwitchTrack checked={mode === 'on'} disabled={!availability.enabled} small />
            </span>
            {availability.reason && (
              <span id={descId} className="mt-0.5 block break-words pr-1 leading-snug text-slate-500">
                {availability.reason}
              </span>
            )}
            {showRepairNotice && (
              <span id={noticeId} className="mt-0.5 block break-words pr-1 leading-snug text-slate-500">
                {SETTING_REPAIR_NOTICE}
              </span>
            )}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-5"
      data-cc-e2e-toggle="row"
      data-cc-e2e-enabled={availability.enabled ? 'true' : 'false'}
      data-cc-e2e-reason={availability.reasonKey ?? ''}
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
          {availability.reason && (
            <p id={descId} className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-slate-500">
              {availability.reason}
            </p>
          )}
          {showRepairNotice && (
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
          disabled={!availability.enabled}
          onClick={onToggle}
          className="mt-0.5 flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed"
        >
          <SwitchTrack checked={mode === 'on'} disabled={!availability.enabled} />
        </button>
      </div>
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
