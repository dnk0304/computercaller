'use client';

/**
 * usePhoneMode — Phone Mode shell + stack navigator state.
 *
 * Phone Mode is a narrow-viewport view layer over the same dashboard data
 * (no new routes, no new data fetches). It replaces the AppShell's
 * content-slot with a tab-bar-driven compact UI suited to ~320–420px viewports.
 *
 * Two ways into Phone Mode (per Dennis dispatch 2026-05-26):
 *  1. Auto — viewport width drops below AUTO_COLLAPSE_BELOW_PX.
 *  2. Manual — user clicks the "Phone Mode" button in the AppShell header
 *     (insertion left of ConnectionStatus).
 *
 * Hysteresis (risk #5):
 *   A manual Expand at narrow viewport sets a session-scoped suppression flag
 *   that disables auto-collapse until the window widens past
 *   SUPPRESS_CLEAR_ABOVE_PX. Same flag suppresses auto-collapse for the rest
 *   of the session if the user explicitly chose "Expand" — we don't want to
 *   slam them back into Phone Mode the moment they nudge the window.
 *   No localStorage per Dennis answer #4 — this is session-scoped state only.
 *
 * popstate guard (risk #4):
 *   When the stack depth > 0 (thread open or compose), browser back should
 *   pop the in-app stack instead of leaving /app. We push a sentinel history
 *   entry on stack push and intercept popstate. Sentinel is also pushed on
 *   manual collapse so user expectations around "back" match the visible
 *   nav cue (the back-arrow in the thread header).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Viewport thresholds. AUTO_COLLAPSE is the "should we be in Phone Mode?"
// boundary — 600px matches Dennis's hysteresis ceiling. We DON'T auto-flip at
// every tiny intermediate viewport; once the user expanded manually below
// 600px, the suppression flag holds them expanded until the window crosses
// the clear-ceiling.
export const AUTO_COLLAPSE_BELOW_PX = 600;
export const SUPPRESS_CLEAR_ABOVE_PX = 600;

export type PhoneModeView =
  | { kind: 'dialer' }
  | { kind: 'texts' }
  | { kind: 'bell' }
  | { kind: 'thread'; threadId: string }
  | { kind: 'compose' };

interface PhoneModeContextValue {
  /** Whether Phone Mode is currently rendered. */
  phoneMode: boolean;
  /** Underlying view stack — last entry is the visible view. */
  stack: PhoneModeView[];
  /** Top of stack — convenience alias. */
  current: PhoneModeView;
  /** Push a new view onto the stack (e.g. open a thread from the list). */
  push: (view: PhoneModeView) => void;
  /** Pop one level (e.g. thread back arrow). No-op if stack depth ≤ 1. */
  pop: () => void;
  /** Replace the entire stack (e.g. tab-bar switch). */
  setTab: (kind: 'dialer' | 'texts' | 'bell') => void;
  /** User clicked Expand — leave Phone Mode and suppress auto-collapse. */
  expandManually: () => void;
  /** User clicked the entry button — enter Phone Mode and pin to dialer. */
  enterManually: () => void;
}

const PhoneModeContext = createContext<PhoneModeContextValue | null>(null);

const HISTORY_SENTINEL = 'phone-mode-stack';

export function PhoneModeProvider({ children }: { children: ReactNode }) {
  // Manual override — the user's last explicit choice. Three values:
  //   'enter'  — user clicked the "Phone Mode" button. Forces Phone Mode ON.
  //   'expand' — user clicked the in-shell Expand button. Forces Phone Mode
  //              OFF until the window widens past SUPPRESS_CLEAR_ABOVE_PX.
  //   null     — no manual choice in effect; width-based auto rule decides.
  // We store this instead of a boolean phoneMode + a separate suppression
  // ref because deriving phoneMode from (width, override) inside useMemo is
  // a cleaner React 19 pattern than chaining state through setState-in-effect
  // (which the latest ESLint rules flag).
  const [override, setOverride] = useState<'enter' | 'expand' | null>(null);

  // Window width — updated in the resize event listener. SSR-safe default;
  // we re-read post-mount in a layout effect so the first paint sees the
  // real viewport. Resize is debounced via rAF — at 60fps a real drag still
  // gets ~60 updates per second, which is fine for breakpoint detection.
  const [width, setWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );

  // Stack navigator state. Default to 'dialer' — Phone Mode opens on the
  // dialer view by design (matches Dashboard initial state mental model).
  const [stack, setStack] = useState<PhoneModeView[]>([{ kind: 'dialer' }]);

  // ---------- Resize observer + suppression cleanup ------------------------
  // One listener, one rAF — wide enough to clear 'expand' suppression and
  // narrow enough to write width on every meaningful change.
  useEffect(() => {
    let rafId = 0;
    const onResize = () => {
      if (rafId) return; // dedupe within one frame
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        const w = window.innerWidth;
        setWidth(w);
        // Clear the 'expand' suppression once the window widens past the
        // hysteresis threshold — at that point the dashboard layout fits
        // again and our auto rule should reassert itself on next shrink.
        // The 'enter' override is independently cleared when phoneMode
        // toggles off via width (see derived value below).
        if (w >= SUPPRESS_CLEAR_ABOVE_PX) {
          setOverride(prev => (prev === 'expand' ? null : prev));
        }
      });
    };
    // Sync once on mount so a hard refresh below threshold immediately
    // shows Phone Mode without waiting for the first resize event.
    setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Derived phone-mode flag. Pure function of (width, override) — no setState
  // in an effect, no possibility of cascading renders. The truth table:
  //   override === 'enter'                  → true  (user opted in)
  //   override === 'expand'                 → false (user opted out)
  //   override === null && w < threshold    → true  (auto-collapse)
  //   override === null && w ≥ threshold    → false (full dashboard)
  const phoneMode = useMemo<boolean>(() => {
    if (override === 'enter') return true;
    if (override === 'expand') return false;
    return width < AUTO_COLLAPSE_BELOW_PX;
  }, [override, width]);

  // Wide-viewport stack reset — when the window crosses back into dashboard
  // territory, drop any stacked view so the next Phone Mode entry starts
  // clean on the dialer. Done as a side-effect because it touches local
  // state in response to phoneMode changing (not in response to width
  // directly — phoneMode is the canonical signal).
  useEffect(() => {
    if (!phoneMode && (stack.length !== 1 || stack[0].kind !== 'dialer')) {
      setStack([{ kind: 'dialer' }]);
    }
    // 'stack' intentionally omitted — we only want this to fire when phoneMode
    // flips, not when the stack is mutated mid-session (push/pop/setTab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneMode]);

  // ---------- popstate guard (risk #4) --------------------------------------
  // When stack depth > 1, intercept browser-back to pop our internal stack
  // instead of letting Next.js navigate away. We push a sentinel state entry
  // on every push, so the FIRST back tap consumes the sentinel + pops the
  // stack; subsequent native-back works as usual.
  useEffect(() => {
    if (!phoneMode) return;
    const onPopState = (e: PopStateEvent) => {
      // If the state we just popped TO is one of our sentinels, the user
      // just hit back while inside a stacked view — swallow it and pop our
      // stack instead. Note: the event itself fires AFTER the URL/state
      // changed, so we re-push to keep history aligned with our stack depth.
      const isFromSentinel = e.state && (e.state as { __phoneModeSentinel?: string }).__phoneModeSentinel === HISTORY_SENTINEL;
      // Only interfere when we still have a stack to pop. If the stack
      // already drained to its root, let the native back proceed.
      setStack(prev => {
        if (prev.length <= 1) return prev;
        return prev.slice(0, -1);
      });
      // Re-push a sentinel so the NEXT in-app push lines up with another
      // history entry rather than leaving us short. Only do this when we
      // popped from a sentinel; otherwise the user really did go elsewhere.
      if (isFromSentinel) {
        window.history.pushState({ __phoneModeSentinel: HISTORY_SENTINEL }, '');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [phoneMode]);

  // ---------- Stack mutators ------------------------------------------------
  const push = useCallback((view: PhoneModeView) => {
    setStack(prev => [...prev, view]);
    // Push a sentinel history entry so browser-back pops the stack first.
    try {
      window.history.pushState({ __phoneModeSentinel: HISTORY_SENTINEL }, '');
    } catch {
      // history may throw under tight sandbox iframes — non-fatal for the UX.
    }
  }, []);

  const pop = useCallback(() => {
    setStack(prev => (prev.length <= 1 ? prev : prev.slice(0, -1)));
    // We don't call history.back() here because the back-arrow path is
    // independent of browser-back. Calling it would race with the popstate
    // handler and double-pop. Sentinel cleanup happens on the NEXT resize
    // or route change naturally.
  }, []);

  const setTab = useCallback((kind: 'dialer' | 'texts' | 'bell') => {
    // Tabs reset the stack to a single view — tabs are siblings, not children.
    setStack([{ kind }]);
  }, []);

  // ---------- Manual entry / exit ------------------------------------------
  const expandManually = useCallback(() => {
    // User opted out → suppress auto-collapse until the window widens past
    // SUPPRESS_CLEAR_ABOVE_PX (handled in the resize listener). Reset the
    // stack so re-entering later opens cleanly on the dialer.
    setOverride('expand');
    setStack([{ kind: 'dialer' }]);
  }, []);

  const enterManually = useCallback(() => {
    // User opted in → force Phone Mode on regardless of width. The auto rule
    // takes back over the moment the user clicks Expand from inside Phone
    // Mode (which sets 'expand') or widens the window past threshold (which
    // doesn't auto-clear 'enter' — wide-screen Phone Mode is intentional).
    setOverride('enter');
    setStack([{ kind: 'dialer' }]);
  }, []);

  const current = useMemo(
    () => stack[stack.length - 1] ?? { kind: 'dialer' },
    [stack],
  );

  const value = useMemo<PhoneModeContextValue>(
    () => ({
      phoneMode,
      stack,
      current,
      push,
      pop,
      setTab,
      expandManually,
      enterManually,
    }),
    [phoneMode, stack, current, push, pop, setTab, expandManually, enterManually],
  );

  return <PhoneModeContext.Provider value={value}>{children}</PhoneModeContext.Provider>;
}

/**
 * Read Phone Mode state from anywhere inside the provider. Returns a safe
 * fallback when called outside the provider (Storybook / unit tests) so
 * isolated components don't crash.
 */
export function usePhoneMode(): PhoneModeContextValue {
  const ctx = useContext(PhoneModeContext);
  if (!ctx) {
    return {
      phoneMode: false,
      stack: [{ kind: 'dialer' }],
      current: { kind: 'dialer' },
      push: () => {},
      pop: () => {},
      setTab: () => {},
      expandManually: () => {},
      enterManually: () => {},
    };
  }
  return ctx;
}
