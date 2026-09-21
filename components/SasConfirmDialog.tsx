'use client';

import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Lock, ShieldAlert } from 'lucide-react';

import { usePhone } from '@/hooks';
import {
  SAS_TITLE,
  SAS_BODY,
  SAS_QUESTION,
  SAS_CONFIRM_LABEL,
  SAS_REJECT_LABEL,
  SAS_REFUSED_TITLE,
  SAS_REFUSED_BODY,
  SAS_DIGIT_COUNT,
  renderSasDigits,
  sasSpokenLabel,
  sasIsBlocking,
  type E2eStateName,
} from '@/lib/encryptedModeCopy';

/**
 * components/SasConfirmDialog.tsx — E2E-P5a (b). The blocking short-code
 * confirm, §12.2 and §13.3.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER MODAL IN THE REPO ────────────
 * components/admin/ConfirmDialog.tsx is the house pattern and I deliberately
 * did NOT reuse it, for one reason: it can be dismissed. It closes on Escape
 * and on a backdrop click, and both are correct for "delete this row?" and
 * disqualifying here. §12.2 makes this a BLOCKING step, and the brief is
 * explicit that when mode is ON there is no way out without choosing. A
 * dismissable security confirmation is worse than none, because the dismissal
 * looks to the user exactly like approval: the dialog goes away and the session
 * continues.
 *
 * So: no Escape handler, no backdrop click-through, no close affordance. The
 * only exits are [Matches] and [Doesn't match]. Everything else about the a11y
 * contract — focus trap, initial focus, focus return, portal, scroll lock — is
 * the same as ConfirmDialog and is implemented here in the same shape so the
 * two read alike to the next person.
 *
 * ── THE FIVE DIGITS ─────────────────────────────────────────────────────────
 * §13.3 is frozen: `digits = be32(HKDF(...)[0..4]) mod 100000, zero-padded to 5`.
 * FIVE. The slice-2 dispatch brief says "the 6-digit (per §13.3) short code";
 * §13 is frozen and the brief is not, so this renders five and
 * lib/encryptedModeCopy.ts carries the note. tests/sas-vectors.json pins it.
 * The code is never padded or reformatted to fit — a wrong-length code is a
 * transcript bug and must LOOK wrong.
 *
 * ── WHAT THIS COMPONENT CANNOT DO YET ───────────────────────────────────────
 * `E2eApi` (hooks/useE2e.ts) exposes `e2e.sas.confirmed` but nothing that SETS
 * it: `confirmed: false` is written once at accept and never changes, and there
 * is no reject path. Pixel does not edit that lane's files, so the decision is
 * held here and the hook action is requested in the résumé as a one-liner
 * (`confirmSas(matches: boolean)`). Until it lands, [Matches] releases the
 * block locally and [Doesn't match] renders the refusal — the full UI, the
 * correct copy, and the real a11y behaviour, with the session-teardown half
 * owned by the lane that owns the session. This is stated rather than hidden
 * because a security dialog that LOOKS like it refused a session and did not is
 * the worst possible thing to leave undocumented.
 */

type Decision = 'pending' | 'matched' | 'refused' | 'acknowledged';

/** Never changes, so the client snapshot never needs to be re-read. */
const subscribeNever = () => () => {};

export function SasConfirmDialog() {
  const phone = usePhone() as {
    e2e?: {
      mode: 'off' | 'on';
      state: E2eStateName;
      sas: { digits: string | null; confirmed: boolean };
    };
    confirmSas?: (matches: boolean) => void;
  };

  const e2e = phone?.e2e;
  const digits = e2e?.sas?.digits ?? null;

  /**
   * The decision is KEYED BY THE DIGITS, in one piece of state, and derived
   * during render rather than reset by an effect.
   *
   * A new pairing mints new digits, and a stale "matched" carried over from the
   * previous pair would silently approve the next one — the single worst bug
   * this component could have. An effect that reset on `digits` would do the
   * job, but only AFTER a render in which the old decision was still live, and
   * `react-hooks/set-state-in-effect` is right to refuse it. Storing the digits
   * alongside the decision makes the staleness impossible to express: a
   * decision that does not name the current code is not a decision.
   */
  const [decided, setDecided] = useState<{ digits: string | null; value: Decision }>({
    digits: null,
    value: 'pending',
  });
  const decision: Decision = decided.digits === digits ? decided.value : 'pending';
  const setDecision = useCallback(
    (value: Decision) => setDecided({ digits, value }),
    [digits],
  );

  const blocking = e2e ? sasIsBlocking(e2e) : false;
  const open = Boolean(digits) && (decision === 'refused' || (blocking && decision === 'pending'));

  const onDecide = useCallback(
    (matches: boolean) => {
      phone?.confirmSas?.(matches);
      setDecision(matches ? 'matched' : 'refused');
    },
    [phone, setDecision],
  );

  // Closes the refusal panel only. The refusal itself is carried on by the
  // banner, which cannot be dismissed — see EncryptionBanner.
  const onAcknowledge = useCallback(() => setDecision('acknowledged'), [setDecision]);

  if (!open || !digits) return null;
  return (
    <SasDialogSurface
      digits={digits}
      refused={decision === 'refused'}
      onDecide={onDecide}
      onAcknowledge={onAcknowledge}
    />
  );
}

function SasDialogSurface({
  digits,
  refused,
  onDecide,
  onAcknowledge,
}: {
  digits: string;
  refused: boolean;
  onDecide: (matches: boolean) => void;
  onAcknowledge: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // SSR guard for createPortal. useSyncExternalStore is the React 18 idiom for
  // "am I on the client", and unlike a useState+useEffect mounted flag it needs
  // no effect at all — server snapshot false, client snapshot true.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  // Remember who had focus, lock the page behind, restore on unmount.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus?.();
    };
  }, []);

  // Initial focus. The REJECT button, not the confirm one — this is the same
  // reasoning as a destructive-action dialog inverted: the dangerous outcome
  // here is approving a code you have not actually compared, and a stray Enter
  // must never be the thing that approves it.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>('[data-cc-sas-initial]');
    first?.focus();
  }, []);

  // Focus trap. NOTE what is absent: no Escape handler. See the file header —
  // the dialog is non-dismissable by design while the block is live.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className="cc-e2e-surface fixed inset-0 z-[120] flex items-center justify-center p-4"
      // No onClick. The backdrop is inert on purpose.
      data-cc-sas-open="true"
      data-cc-sas-refused={refused ? 'true' : 'false'}
    >
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-[2px]" aria-hidden="true" />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="cc-e2e-motion relative w-full max-w-[360px] rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.45)]"
      >
        {refused ? (
          <>
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" aria-hidden="true" />
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                {SAS_REFUSED_TITLE}
              </h2>
            </div>
            <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-slate-600">
              {SAS_REFUSED_BODY}
            </p>
            {/* The ONE dismissable moment in this component, and only because
                the refusal does not stop existing when the dialog closes: the
                non-dismissable banner (EncryptionBanner) takes the state over
                and stays. Without this button the refusal branch would be a
                modal with no exit at all, which is a worse outcome than the one
                it is warning about. */}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                data-cc-sas-initial
                data-cc-sas-action="acknowledge"
                onClick={onAcknowledge}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2.5">
              <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-500" aria-hidden="true" />
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                {SAS_TITLE}
              </h2>
            </div>
            <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-slate-600">
              {SAS_BODY}
            </p>

            {/* The code. Rendered UNGROUPED per SPEC §13.3 R-BK (M-A6-5): the
                phone hero face shows the same five characters with no
                separator, so the two surfaces are one exact string compare.
                Tabular figures and generous tracking because the whole
                job of this element is character-by-character comparison against
                a phone held next to the screen — this is the one place in the
                product where legibility beats every other typographic concern.
                role="img" + aria-label is what stops a screen reader reading
                "twelve thousand three hundred forty-five", which is useless for
                comparing digits. */}
            <div
              className="mt-4 rounded-xl border border-slate-200 bg-slate-50 py-4 text-center"
              role="img"
              aria-label={sasSpokenLabel(digits)}
              data-cc-sas-digits={digits}
            >
              <span
                className="font-mono text-[30px] font-semibold leading-none tracking-[0.18em] text-slate-900"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {renderSasDigits(digits)}
              </span>
            </div>
            {digits.length !== SAS_DIGIT_COUNT && (
              // Never silently tidied. A wrong-length code means the transcript
              // is wrong, and the user must not be asked to approve it.
              <p className="mt-2 text-[12px] font-medium text-red-600">
                This code is the wrong length. Don&apos;t approve it — pair again.
              </p>
            )}

            <p className="mt-4 text-[13px] font-medium text-slate-900">{SAS_QUESTION}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-cc-sas-initial
                data-cc-sas-action="reject"
                onClick={() => onDecide(false)}
                className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
              >
                {SAS_REJECT_LABEL}
              </button>
              <button
                type="button"
                data-cc-sas-action="confirm"
                onClick={() => onDecide(true)}
                disabled={digits.length !== SAS_DIGIT_COUNT}
                className="flex-1 rounded-xl bg-emerald-600 px-3 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {SAS_CONFIRM_LABEL}
              </button>
            </div>
          </>
        )}

        {/* Announced to screen readers the moment the dialog arrives. The
            dialog is `role="alertdialog"`, which most readers announce on
            focus; this live region covers the readers that do not, and carries
            the digits in spoken form. */}
        <span className="sr-only" role="status" aria-live="assertive">
          {refused ? `${SAS_REFUSED_TITLE}. ${SAS_REFUSED_BODY}` : `${SAS_TITLE}. ${sasSpokenLabel(digits)}. ${SAS_QUESTION}`}
        </span>
      </div>
    </div>,
    document.body,
  );
}
