'use client';

import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

/**
 * Lightweight context for controlling the GlobalDialer widget's open/closed state
 * from anywhere in the tree (e.g. a button in the top bar) without prop drilling.
 *
 * Kept intentionally small — open/closed, plus the suppression flag below.
 * Tab selection inside the dialer stays local to GlobalDialer.
 */
interface DialerOpenContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (next: boolean) => void;
  /**
   * True while another surface owns the in-call UI and the floating panel must
   * not exist at all (PIXEL-H, 2026-09-15). Today that means exactly one
   * thing: a Phone Mode shell is on screen, and it renders its own in-call
   * UI (PhoneModeCallBanner while connected, PhoneModeCallSurface while an
   * incoming call is still ringing). Two surfaces wired to the same `endCall`
   * inside a ~390px viewport is the bug this prevents — and the panel
   * auto-opens on every incoming call, so it would cover the call UI at
   * precisely the moment it matters most.
   */
  suppressed: boolean;
  /**
   * Publish the suppression flag. This is a PUBLICATION channel, not a second
   * source of truth: the only caller is PhoneModeProvider, which owns
   * `phoneMode` and mirrors it here verbatim. It exists because
   * `GlobalDialerMount` is mounted in the ROOT layout, a sibling of
   * `{children}` and therefore OUTSIDE PhoneModeProvider (which lives in
   * `app/app/layout.tsx` and `ExtensionProviders`) — so it cannot call
   * `usePhoneMode()` and read anything but the context fallback. Rather than
   * re-derive the viewport rule at root (which WOULD be a second source of
   * truth, and would drift from AUTO_COLLAPSE_BELOW_PX the first time that
   * threshold moved), the one owner pushes its answer up to the one provider
   * both sides can see.
   */
  setSuppressed: (next: boolean) => void;
}

const DialerOpenContext = createContext<DialerOpenContextValue | null>(null);

export function DialerOpenProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [suppressed, setSuppressedState] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const setOpen = useCallback((next: boolean) => setIsOpen(next), []);
  const setSuppressed = useCallback((next: boolean) => setSuppressedState(next), []);

  const value = useMemo<DialerOpenContextValue>(
    () => ({ isOpen, open, close, toggle, setOpen, suppressed, setSuppressed }),
    [isOpen, open, close, toggle, setOpen, suppressed, setSuppressed]
  );

  return <DialerOpenContext.Provider value={value}>{children}</DialerOpenContext.Provider>;
}

/**
 * Read/control the global dialer's open state. Safe to call without a provider —
 * returns a no-op fallback so older trees don't crash during HMR.
 */
export function useDialerOpen(): DialerOpenContextValue {
  const ctx = useContext(DialerOpenContext);
  if (!ctx) {
    return {
      isOpen: false,
      open: () => {},
      close: () => {},
      toggle: () => {},
      setOpen: () => {},
      suppressed: false,
      setSuppressed: () => {},
    };
  }
  return ctx;
}
