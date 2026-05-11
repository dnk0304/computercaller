'use client';

import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

/**
 * Lightweight context for controlling the GlobalDialer widget's open/closed state
 * from anywhere in the tree (e.g. a button in the top bar) without prop drilling.
 *
 * Kept intentionally small — open/closed only. Tab selection inside the dialer
 * stays local to GlobalDialer.
 */
interface DialerOpenContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (next: boolean) => void;
}

const DialerOpenContext = createContext<DialerOpenContextValue | null>(null);

export function DialerOpenProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const setOpen = useCallback((next: boolean) => setIsOpen(next), []);

  const value = useMemo<DialerOpenContextValue>(
    () => ({ isOpen, open, close, toggle, setOpen }),
    [isOpen, open, close, toggle, setOpen]
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
    };
  }
  return ctx;
}
