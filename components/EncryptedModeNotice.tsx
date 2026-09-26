'use client';

import React, { useState } from 'react';
import { Lock, X } from 'lucide-react';

import { dismissRemoteChangeNotice, useAccountE2ePref } from '@/lib/e2eAccountPref';
import { remoteNoticeCopy } from '@/lib/e2eAccountPref-core';

/**
 * components/EncryptedModeNotice.tsx — T-E2E-ACCOUNT-PREF step 3 (DESIGN §8):
 * "Encrypted mode was turned <on|off> from <device> at <time>".
 *
 * Shown ONCE, in both directions, after the account value was changed from
 * somewhere other than this device (lib/e2eAccountPref-core applyIncoming
 * decides). It persists in the account mirror until dismissed, so a reload
 * does not swallow it and a dismissal is not undone by one.
 *
 * A strip under the header next to EncryptionBanner, not a line inside the
 * setting: on the extension the setting lives in a closed menu, and a notice
 * nobody opens the menu to find has not been shown. Informational, so it is a
 * polite status region; no downgrade prompt here (the phone latch + OR rule
 * cover B1 — brief item 5).
 */
export function EncryptedModeNotice() {
  const { mirror } = useAccountE2ePref();
  const [now] = useState(() => new Date());
  const notice = mirror?.notice ?? null;
  if (!notice) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-cc-e2e-remote-notice={notice.value}
      className="cc-e2e-surface flex items-start gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2"
    >
      <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-600" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-slate-700">
        {remoteNoticeCopy(notice, now)}
      </p>
      <button
        type="button"
        onClick={dismissRemoteChangeNotice}
        aria-label="Dismiss"
        className="-my-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
