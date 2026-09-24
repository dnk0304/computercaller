'use client';

import React from 'react';
import { Lock, LockOpen, ShieldAlert } from 'lucide-react';

import { usePhone } from '@/hooks';
import {
  encryptionIndicator,
  type PeerSupport,
  type E2eErrorName,
  type E2eStateName,
  type EncryptionIndicator,
} from '@/lib/encryptedModeCopy';

/**
 * components/EncryptionStatus.tsx — E2E-P5a (c).
 *
 * ── THE INDEPENDENCE RULE, AND WHY IT IS A SEPARATE COMPONENT ───────────────
 * P5a slice 1's finding, and the recurring defect of this whole programme, is
 * an ENCRYPTION problem repainting the surface as "signed-out" or
 * "disconnected". The durable fix is not a careful `if`; it is that the two
 * state machines cannot reach each other's inputs.
 *
 * So the encryption indicator is its own component, rendered ALONGSIDE
 * ConnectionStatus and never inside its branch dispatch. ConnectionStatus keeps
 * switching on `lobbyState` exactly as it does today — this file adds no case,
 * removes none, and touches none of its tones. `encryptionIndicator()` in
 * lib/encryptedModeCopy.ts takes only e2e fields and is not given a lobbyState
 * to read even if someone wanted to.
 *
 * scripts/e2e-ui-proof.mjs asserts the consequence directly: across the product
 * of every lobby state and every e2e state, the lobby pill's rendered identity
 * is byte-stable. If a future edit folds encryption into the pill, that
 * assertion is what goes red.
 *
 * ── NEVER COLOUR-ALONE ──────────────────────────────────────────────────────
 * Each state carries a glyph AND words. The lock is drawn only when the pairing
 * really is encrypted, so an open padlock is never used decoratively; "Not
 * encrypted" reads the same in greyscale as in colour. The tonal inks used here
 * (text-emerald-700, text-amber-700, text-red-600) are the three that
 * app/extension/extension.css deliberately leaves unmapped because they carry
 * meaning and are legible on both grounds.
 */

interface E2eLike {
  mode: 'off' | 'on';
  state: E2eStateName;
  error?: E2eErrorName;
  peer: { supports: PeerSupport };
  /** T-WEB-HEADER-VERIFIED-BEFORE-CONFIRM: the header may not claim the code
   *  was confirmed before the user confirmed it, so the answer has to reach
   *  the copy function. */
  sas?: { confirmed: boolean };
}

function useIndicator(): { view: E2eLike; indicator: EncryptionIndicator } | null {
  const phone = usePhone() as { e2e?: E2eLike };
  const view = phone?.e2e;
  if (!view) return null;
  return { view, indicator: encryptionIndicator(view) };
}

const toneInk: Record<EncryptionIndicator['tone'], string> = {
  encrypted: 'text-emerald-700',
  attention: 'text-amber-700',
  plain: 'text-slate-500',
};

/**
 * The chip that sits beside the connection pill and in the header badge slot.
 *
 * `compact` drops the word on the extension surface's 40px row, where AC-1 caps
 * the whole row's width — the glyph keeps its accessible name via `title` and
 * the visually-hidden span, so the meaning survives even though the word cannot
 * fit. On /app the word is always shown; a lock glyph alone is not a claim a
 * user can read.
 */
export function EncryptionChip({ compact = false }: { compact?: boolean }) {
  const data = useIndicator();
  if (!data) return null;
  const { indicator } = data;

  // Error states are the banner's job — a 40px chip cannot carry a reason, and
  // a chip that said "Pairing refused" with no explanation is worse than one
  // that stays quiet while a banner says it properly one row below.
  if (indicator.banner) return null;

  const Glyph = indicator.lock ? Lock : LockOpen;

  return (
    <span
      // flex-shrink-0, and it is a fix rather than a default: inside the
      // header's `min-w-0 flex-1` slot the chip was being squeezed by the
      // connection pill and rendered as "Not encry…". A truncated security
      // label is worse than no label — "Not encry…" and "Encrypted" share a
      // prefix at a glance. The pill beside it already truncates a device NAME,
      // which is the right thing to sacrifice first; these three words are not.
      className={`cc-e2e-surface inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap ${toneInk[indicator.tone]}`}
      data-cc-e2e-chip={indicator.tone}
      data-cc-e2e-label={indicator.label}
      title={indicator.detail}
    >
      <Glyph className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      {!compact && (
        <span className="text-[11px] font-medium">{indicator.label}</span>
      )}
      <span className="sr-only">{indicator.detail}</span>
    </span>
  );
}

/**
 * The non-dismissable banner for every `state === 'error'` outcome.
 *
 * NO close button, and that is the requirement rather than an oversight: all
 * six errors are conditions that are still true after the user clicks a ✕, and
 * a dismissed banner would leave the product silently unencrypted while looking
 * normal. It disappears when the underlying state changes, and only then.
 *
 * `role="status"` + `aria-live="polite"`, not `alert`/`assertive`: this arrives
 * alongside the SAS dialog's own assertive announcement in the refusal case,
 * and two assertive regions firing together means a screen-reader user hears
 * neither cleanly.
 */
export function EncryptionBanner() {
  const data = useIndicator();
  if (!data) return null;
  const { indicator } = data;
  if (!indicator.banner) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-cc-e2e-banner={indicator.label}
      className="cc-e2e-surface flex items-start gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" aria-hidden="true" />
      <p className="min-w-0 text-[12px] leading-snug text-slate-700">
        <span className="font-semibold text-slate-900">{indicator.label}.</span>{' '}
        {indicator.detail}
      </p>
    </div>
  );
}
