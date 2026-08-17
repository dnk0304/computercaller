'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useEntitlement, type Entitlement } from '@/hooks/useEntitlement';
import { UpgradeModal, type LimitContext } from '@/components/UpgradeModal';
import type { UpgradePath } from '@/lib/tiers';

// ---------------------------------------------------------------------------
// UpgradeModalProvider — one shared entitlement read + one upgrade-modal
// instance for the whole /app surface (dispatch feature/tier-gating).
//
// WHY A PROVIDER (mirrors the app's PhoneProvider / DashboardTabProvider
// pattern): three surfaces need the same two things — the caller's tier/limits,
// and a way to open the pricing/upgrade modal:
//   • the header tier badge          (reads tier)
//   • the Templates "limit reached"  (opens the modal on cap)
//   • SyncSetupPanel gating          (reads limits, opens the modal on a lock)
// Centralising here means ONE GET /api/entitlement for the whole app (not one
// per surface) and ONE modal mounted once — so focus management and the
// checkout embed live in a single place, never stacked or duplicated.
//
// Mounted in app/app/layout.tsx wrapping BOTH <AppShell> and <SyncSetupPanel>
// so every consumer is inside the provider.
// ---------------------------------------------------------------------------

interface UpgradeModalContextValue {
  /** The shared entitlement (null while loading or when unauthenticated). */
  entitlement: Entitlement | null;
  loading: boolean;
  error: boolean;
  /** Refetch the shared entitlement (e.g. after an upgrade). */
  refetchEntitlement: () => void;
  /**
   * Open the upgrade prompt. `context` names which limit was hit (descriptive
   * line only). `upgradeOverride` lets a 409 handler pass the freshest server
   * `upgrade` signal; when omitted, the modal uses the shared entitlement's
   * `upgrade`. The PROMPT (activate-$5 vs upgrade-$7) is always the server's
   * choice — never guessed here.
   */
  openUpgrade: (context?: LimitContext, upgradeOverride?: UpgradePath) => void;
  /** Close the modal. */
  closeUpgrade: () => void;
}

// Safe default so a consumer rendered outside the provider never crashes —
// openUpgrade becomes a no-op and entitlement reads as "still loading".
const DEFAULT_VALUE: UpgradeModalContextValue = {
  entitlement: null,
  loading: true,
  error: false,
  refetchEntitlement: () => {},
  openUpgrade: () => {},
  closeUpgrade: () => {},
};

const UpgradeModalContext = createContext<UpgradeModalContextValue>(DEFAULT_VALUE);

export function UpgradeModalProvider({ children }: { children: React.ReactNode }) {
  const { entitlement, loading, error, refetch } = useEntitlement();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<LimitContext>(undefined);
  // An explicit upgrade signal from a 409 body, if the opener supplied one.
  const [upgradeOverride, setUpgradeOverride] = useState<UpgradePath | null>(null);

  const openUpgrade = useCallback((c?: LimitContext, override?: UpgradePath) => {
    setContext(c);
    setUpgradeOverride(override ?? null);
    setOpen(true);
  }, []);

  const closeUpgrade = useCallback(() => setOpen(false), []);

  const value = useMemo<UpgradeModalContextValue>(
    () => ({
      entitlement,
      loading,
      error,
      refetchEntitlement: refetch,
      openUpgrade,
      closeUpgrade,
    }),
    [entitlement, loading, error, refetch, openUpgrade, closeUpgrade],
  );

  return (
    <UpgradeModalContext.Provider value={value}>
      {children}
      <UpgradeModal
        open={open}
        onClose={closeUpgrade}
        upgrade={upgradeOverride ?? entitlement?.upgrade ?? null}
        context={context}
      />
    </UpgradeModalContext.Provider>
  );
}

/**
 * Read the shared entitlement + open the upgrade modal. Safe to call anywhere
 * under <UpgradeModalProvider>; outside it, returns inert defaults.
 */
export function useUpgrade(): UpgradeModalContextValue {
  return useContext(UpgradeModalContext);
}
