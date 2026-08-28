'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useUsage, type Usage } from '@/hooks/useUsage';
import { usePhone } from '@/hooks/PhoneProvider';
import { useUpgrade } from '@/hooks/upgradeModalContext';
import { LimitReachedModal } from '@/components/LimitReachedModal';

// ---------------------------------------------------------------------------
// FreeTierProvider — the single owner of free-tier daily-cap UX (dispatch
// forge/free-tier-p1, 2026-08-28). It ties together three things:
//
//   1. The live usage snapshot (useUsage → GET /api/usage) that the proactive
//      meter and the pre-send guard read.
//   2. A PROACTIVE synchronous guard, `guard(kind)`, that the compose box and
//      dialer call BEFORE sending. When the local snapshot already shows the
//      cap reached it opens the block modal and returns false WITHOUT sending —
//      so, critically, the SMS compose box is never cleared on a blocked send.
//   3. The AUTHORITATIVE async safety net: the relay's LIMIT_REACHED frame
//      (surfaced via usePhone().limitReached) for the boundary race where the
//      local count was stale. It opens the same modal and refetches usage. The
//      hook has already rolled back the optimistic row by the time we see it.
//
// Mounted INSIDE both PhoneProvider (for limitReached) and UpgradeModalProvider
// (so the modal's Subscribe CTA reuses the existing Whop checkout via
// useUpgrade().openUpgrade — one checkout implementation, no duplication).
// ---------------------------------------------------------------------------

export type LimitKind = 'call' | 'message';

interface FreeTierValue {
  /** Live usage snapshot, or null (loading / unauthenticated / non-metered). */
  usage: Usage | null;
  loading: boolean;
  /** True when this tier has a finite daily cap (i.e. the free tier). */
  isMetered: boolean;
  /**
   * Proactive pre-send guard. Returns true if the action may proceed; when the
   * local snapshot shows the cap is already reached it opens the block modal,
   * returns false, and admits NOTHING. On admit it optimistically bumps the
   * local counter so a rapid second action can't slip past a stale count.
   * Fail-open when usage is unknown — the server (LIMIT_REACHED) is the real
   * enforcer, and we must never wrongly block a paid user mid-load.
   */
  guard: (kind: LimitKind) => boolean;
  /**
   * Monotonic counter that increments on every MESSAGE block (proactive OR the
   * async relay breach). The compose box watches it to restore a draft that was
   * optimistically cleared before an async breach arrived.
   */
  messageBlockNonce: number;
  /** Force a usage refetch. */
  refetch: () => void;
}

const DEFAULT_VALUE: FreeTierValue = {
  usage: null,
  loading: true,
  isMetered: false,
  guard: () => true,
  messageBlockNonce: 0,
  refetch: () => {},
};

const FreeTierContext = createContext<FreeTierValue>(DEFAULT_VALUE);

export function FreeTierProvider({ children }: { children: React.ReactNode }) {
  const { usage, loading, refetch, bump } = useUsage();
  const { limitReached, clearLimitReached } = usePhone();
  const { openUpgrade } = useUpgrade();

  // The block modal's state — unified for both the proactive and async paths.
  const [blocked, setBlocked] = useState<{ kind: LimitKind; resetAt: number } | null>(null);
  const [messageBlockNonce, setMessageBlockNonce] = useState(0);

  const isMetered = useMemo(
    () => !!usage && (usage.calls.limit !== null || usage.messages.limit !== null),
    [usage],
  );

  const openBlock = useCallback((kind: LimitKind, resetAt: number) => {
    setBlocked({ kind, resetAt });
    if (kind === 'message') setMessageBlockNonce(n => n + 1);
  }, []);

  const guard = useCallback(
    (kind: LimitKind): boolean => {
      // Unknown usage → fail-open; the relay still enforces and will send
      // LIMIT_REACHED if we're actually over.
      if (!usage) return true;
      const counter = kind === 'call' ? usage.calls : usage.messages;
      if (counter.limit === null) return true; // unlimited tier
      if (counter.used >= counter.limit) {
        openBlock(kind, usage.resetAt);
        return false;
      }
      bump(kind);
      return true;
    },
    [usage, bump, openBlock],
  );

  // Async safety net — the relay refused an outbound action. Open the same
  // modal (authoritative resetAt from the wire), refetch usage so the meter
  // snaps to the true count, then consume the signal so it fires once.
  const lastAsyncNonce = useRef<number>(-1);
  useEffect(() => {
    if (!limitReached) return;
    if (limitReached.nonce === lastAsyncNonce.current) return;
    lastAsyncNonce.current = limitReached.nonce;
    const { kind, resetAt } = limitReached;
    // Defer the state updates out of the effect body: this effect is a
    // subscription to an EXTERNAL event (the relay's breach frame), and the
    // opens/refetch/clear are the reaction to it. A microtask keeps them off the
    // synchronous effect path (no cascading render) and runs before paint.
    queueMicrotask(() => {
      openBlock(kind, resetAt);
      refetch();
      clearLimitReached();
    });
  }, [limitReached, openBlock, refetch, clearLimitReached]);

  const closeBlock = useCallback(() => setBlocked(null), []);

  const handleSubscribe = useCallback(() => {
    // Reuse the existing Whop checkout flow. Close the block modal first so the
    // two dialogs never stack; openUpgrade with no context uses the shared
    // entitlement's server-selected upgrade path (the correct plan for a free
    // user) — pricing is never restructured here.
    setBlocked(null);
    openUpgrade();
  }, [openUpgrade]);

  const value = useMemo<FreeTierValue>(
    () => ({ usage, loading, isMetered, guard, messageBlockNonce, refetch }),
    [usage, loading, isMetered, guard, messageBlockNonce, refetch],
  );

  return (
    <FreeTierContext.Provider value={value}>
      {children}
      <LimitReachedModal
        open={blocked !== null}
        kind={blocked?.kind ?? 'call'}
        resetAt={blocked?.resetAt ?? 0}
        limit={
          blocked
            ? (blocked.kind === 'call' ? usage?.calls.limit : usage?.messages.limit) ?? null
            : null
        }
        onSubscribe={handleSubscribe}
        onClose={closeBlock}
      />
    </FreeTierContext.Provider>
  );
}

/** Read usage + the proactive guard. Inert defaults outside the provider. */
export function useFreeTier(): FreeTierValue {
  return useContext(FreeTierContext);
}
