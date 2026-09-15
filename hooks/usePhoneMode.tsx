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

// Direct module import, not via hooks/index — going through the barrel would
// make this file and dialerContext mutually reachable through index.ts.
import { useDialerOpen } from './dialerContext';

// Viewport thresholds. AUTO_COLLAPSE is the "should we be in Phone Mode?"
// boundary. We DON'T auto-flip at every tiny intermediate viewport; once the
// user expanded manually below the threshold, the suppression flag holds them
// expanded until the window crosses the clear-ceiling.
//
// 2026-08-10 — raised 600 → 1000, from measurement rather than taste.
// The old 600 was an arbitrary ceiling and it left a dead zone: Phone Mode
// stopped at 600 but the full dashboard does not FIT until far above it.
// Measured on the live dashboard (empty/disconnected state, sidebar expanded):
//
//   main 3-pane grid intrinsic minimum ......  826px  (Dashboard.tsx grid-cols)
//   + content-slot padding (p-6) ............   48px
//   + notification rail + gap ...............  ~64px
//   + Sidebar expanded (w-64) ...............  256px
//   = full dashboard floor ..................  ~1194px
//
// So every viewport from 600px to ~1194px rendered the desktop layout clipped.
// Two changes close that band together:
//   1. this threshold, so 600–1000 gets the phone shell instead of a clipped
//      desktop layout, and
//   2. SIDEBAR_AUTO_COLLAPSE_BELOW_PX below, which reclaims the sidebar's
//      256→64px and drops the dashboard floor to ~1002px.
// 1000 is chosen to sit just under that reclaimed floor while staying below
// 1024 so no laptop or landscape tablet is ever pushed into Phone Mode.
export const AUTO_COLLAPSE_BELOW_PX = 1000;
export const SUPPRESS_CLEAR_ABOVE_PX = 1000;

// Below this width the Sidebar renders in its icon-only w-16 form regardless of
// the user's stored preference. This is what makes the 1000–1200 band fit; the
// user's own expanded/collapsed choice is untouched and reasserts itself above
// the threshold. 1200 (not 1194) leaves a small margin over the measured floor.
export const SIDEBAR_AUTO_COLLAPSE_BELOW_PX = 1200;

/** The three root tabs. A stacked view always belongs to one of them. */
export type PhoneModeTab = 'dialer' | 'texts' | 'bell';

export type PhoneModeView =
  | { kind: 'dialer' }
  | { kind: 'texts' }
  | { kind: 'bell' }
  // `from` is the tab the user was standing on when this view was pushed.
  // Back from a stacked view returns THERE, not to wherever the stack root
  // happens to be (Dennis 2026-09-15: "If I clicked new message from the dial
  // tab, then I should get sent back to dial tab"). Optional so older call
  // sites that have no meaningful origin still compile and fall back to pop().
  | { kind: 'thread'; threadId: string; from?: PhoneModeTab }
  // `to` pre-addresses the composer (dispatch PIXEL-B2 / AC-4: the Dial view's
  // Send-message action lands in Texts with that recipient already filled and
  // focus in the body, rather than opening a second parallel compose UI).
  // Optional — `push({ kind: 'compose' })` still means "blank new message".
  | { kind: 'compose'; to?: string; from?: PhoneModeTab };

interface PhoneModeContextValue {
  /** Whether Phone Mode is currently rendered. */
  phoneMode: boolean;
  /**
   * Whether the viewport is narrow enough that the Sidebar must render in its
   * icon-only form for the dashboard to fit. Derived from the same width this
   * provider already tracks, so the app keeps exactly one resize listener.
   * Consumers should OR this with the user's own collapse preference rather
   * than writing to it — the stored preference must survive a resize.
   */
  forceSidebarCollapsed: boolean;
  /** Underlying view stack — last entry is the visible view. */
  stack: PhoneModeView[];
  /** Top of stack — convenience alias. */
  current: PhoneModeView;
  /** Push a new view onto the stack (e.g. open a thread from the list). */
  push: (view: PhoneModeView) => void;
  /** Pop one level (e.g. thread back arrow). No-op if stack depth ≤ 1. */
  pop: () => void;
  /**
   * Swap the TOP of the stack for another view, at the same depth and without
   * adding a history entry. This is how "send an SMS" leaves the composer:
   * the compose entry becomes the thread entry, so the composer is no longer
   * behind the user and back lands on the tab they came from.
   */
  replace: (view: PhoneModeView) => void;
  /** Replace the entire stack (e.g. tab-bar switch). */
  setTab: (kind: PhoneModeTab) => void;
  /** User clicked Expand — leave Phone Mode and suppress auto-collapse. */
  expandManually: () => void;
  /** User clicked the entry button — enter Phone Mode and pin to dialer. */
  enterManually: () => void;
  /**
   * Opens the current /app URL in a separate ~380x760 popup window. Lets the
   * user have a TRUE phone-sized window alongside the desktop dashboard —
   * something `window.resizeTo()` on the main window cannot deliver because
   * the DOM spec forbids it outside windows opened by `window.open()`
   * (dispatch #34 item 4). The popup inherits the same-origin auth cookie,
   * lands on /app, and `usePhoneMode` auto-collapses it because window width
   * is below AUTO_COLLAPSE_BELOW_PX.
   *
   * Returns the WindowProxy (or null if the browser blocked the popup). The
   * window is named so clicking the button twice focuses the existing popup
   * instead of spawning a second one.
   *
   * MUST be called synchronously inside a user-gesture click handler — any
   * async hop before `window.open` causes most popup blockers to reject it.
   */
  openInPopup: () => Window | null;
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

  // ---------- Publish Phone Mode to the floating dialer (PIXEL-H) ----------
  // While a Phone Mode shell is on screen, the shell owns the in-call UI
  // (banner while connected, full body while ringing), so GlobalDialer's
  // floating panel must not exist: two surfaces wired to the same `endCall`
  // in a ~390px viewport, with the panel auto-opening over the call UI on
  // every incoming call. GlobalDialerMount
  // sits outside this provider and cannot read `phoneMode`, so we push it into
  // DialerOpenProvider (root layout) — see `setSuppressed`'s doc comment for
  // why that is a publication channel and not a second source of truth.
  //
  // The cleanup returns the flag to false on unmount, so leaving /app (or the
  // extension) for a route with no PhoneModeProvider restores the panel.
  const { setSuppressed } = useDialerOpen();
  useEffect(() => {
    setSuppressed(phoneMode);
    return () => setSuppressed(false);
  }, [phoneMode, setSuppressed]);

  // ---------- popstate guard (risk #4) --------------------------------------
  // Every `push` adds exactly ONE sentinel history entry, and every way OUT of
  // a stacked view consumes exactly as many as it unwinds. Keeping those two
  // depths equal is the whole trick: the previous implementation re-pushed a
  // sentinel on every back, so history grew one entry per back-tap and a tab
  // switch left orphaned entries behind — which is what made back feel like it
  // needed pressing twice once a compose had been in the stack.
  //
  //   push()             depth +1, history +1
  //   pop()              depth -1, history.go(-1)
  //   setTab()/reset     depth -> 0, history.go(-depth)
  //   replace()          depth unchanged, history unchanged
  //   browser back       depth -1, stack -1 (the event already moved history)
  const sentinelDepthRef = React.useRef(0);
  // Back-steps WE asked for. popstate fires for those too, and it must not be
  // read as the user navigating — that double-pop is the "two backs" bug.
  const selfPopsRef = React.useRef(0);
  // Stack depth readable from the popstate listener without re-subscribing it
  // on every push (the listener is registered once per phoneMode flip).
  const stackRef = React.useRef(stack);
  useEffect(() => { stackRef.current = stack; }, [stack]);

  const unwindHistory = useCallback((steps: number) => {
    if (steps <= 0) return;
    selfPopsRef.current += steps;
    try {
      window.history.go(-steps);
    } catch {
      // Sandboxed iframes can refuse history navigation — the in-app stack is
      // already correct, so this only costs a stale entry, never a wrong view.
      selfPopsRef.current = Math.max(0, selfPopsRef.current - steps);
    }
  }, []);

  useEffect(() => {
    if (!phoneMode) return;
    const onPopState = () => {
      // One of ours (pop / setTab unwinding). Already accounted for.
      if (selfPopsRef.current > 0) {
        selfPopsRef.current -= 1;
        return;
      }
      if (sentinelDepthRef.current > 0) sentinelDepthRef.current -= 1;
      // Nothing left to pop → the user really did leave; let it through.
      if (stackRef.current.length <= 1) return;
      setStack(prev => (prev.length <= 1 ? prev : prev.slice(0, -1)));
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
      sentinelDepthRef.current += 1;
    } catch {
      // history may throw under tight sandbox iframes — non-fatal for the UX.
    }
  }, []);

  const pop = useCallback(() => {
    let moved = false;
    setStack(prev => {
      if (prev.length <= 1) return prev;
      moved = true;
      return prev.slice(0, -1);
    });
    if (moved && sentinelDepthRef.current > 0) {
      sentinelDepthRef.current -= 1;
      unwindHistory(1);
    }
  }, [unwindHistory]);

  // Same depth, no history entry: the entry the user is looking at becomes a
  // different entry. After a send, the composer must not be reachable by back.
  const replace = useCallback((view: PhoneModeView) => {
    setStack(prev => (prev.length === 0 ? [view] : [...prev.slice(0, -1), view]));
  }, []);

  const setTab = useCallback((kind: PhoneModeTab) => {
    // Tabs reset the stack to a single view — tabs are siblings, not children.
    setStack([{ kind }]);
    const depth = sentinelDepthRef.current;
    sentinelDepthRef.current = 0;
    unwindHistory(depth);
  }, [unwindHistory]);

  // ---------- Manual entry / exit ------------------------------------------
  const expandManually = useCallback(() => {
    // User opted out → suppress auto-collapse until the window widens past
    // SUPPRESS_CLEAR_ABOVE_PX (handled in the resize listener). Reset the
    // stack so re-entering later opens cleanly on the dialer.
    setOverride('expand');
    setStack([{ kind: 'dialer' }]);
    const depth = sentinelDepthRef.current;
    sentinelDepthRef.current = 0;
    unwindHistory(depth);
  }, [unwindHistory]);

  const enterManually = useCallback(() => {
    // User opted in → force Phone Mode on regardless of width. The auto rule
    // takes back over the moment the user clicks Expand from inside Phone
    // Mode (which sets 'expand') or widens the window past threshold (which
    // doesn't auto-clear 'enter' — wide-screen Phone Mode is intentional).
    setOverride('enter');
    setStack([{ kind: 'dialer' }]);
    const depth = sentinelDepthRef.current;
    sentinelDepthRef.current = 0;
    unwindHistory(depth);
  }, [unwindHistory]);

  // Open a true narrow popup window. window.open is wrapped in a thin
  // try/catch — some sandbox-iframe contexts throw on .open access entirely.
  // We deliberately do NOT do any async work before this call: popup blockers
  // tie the gesture-allowed grant to the synchronous call stack of the
  // user click. The window is named `computercaller-phone-popup` so a second
  // click focuses the existing popup rather than spawning a duplicate.
  //
  // The reused window name DOES inherit cookies/auth from the opener (same
  // origin), so the popup arrives at /app already-signed-in. The popup
  // viewport (~380px) is below AUTO_COLLAPSE_BELOW_PX, so it auto-collapses
  // into Phone Mode on first render — no extra wiring needed.
  const openInPopup = useCallback((): Window | null => {
    if (typeof window === 'undefined') return null;
    try {
      const features = 'width=380,height=760,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes';
      const w = window.open(window.location.href, 'computercaller-phone-popup', features);
      if (!w) {
        // Popup blocked. We don't surface UI from inside the hook — the
        // caller (ProfileMenu entry) can show a toast or silent-fail. Most
        // browsers also show a native "site wants to open a popup" prompt
        // the first time at this origin; from then on the user's per-origin
        // choice is honoured automatically.
        console.warn('[PhoneMode] openInPopup blocked by browser');
        return null;
      }
      // Best-effort focus. Some browsers focus the popup automatically, but
      // returning user to an already-open popup (named-window reuse) doesn't
      // refocus by default — explicit focus() fixes that.
      try { w.focus(); } catch { /* cross-origin races during navigation can throw — ignore */ }
      return w;
    } catch (e) {
      console.warn('[PhoneMode] openInPopup failed:', e);
      return null;
    }
  }, []);

  const current = useMemo(
    () => stack[stack.length - 1] ?? { kind: 'dialer' },
    [stack],
  );

  // Narrow-but-not-phone band: the dashboard renders, but only if the Sidebar
  // gives back its 256px. Pure derivation of the width we already track.
  const forceSidebarCollapsed = useMemo<boolean>(
    () => width < SIDEBAR_AUTO_COLLAPSE_BELOW_PX,
    [width],
  );

  const value = useMemo<PhoneModeContextValue>(
    () => ({
      phoneMode,
      forceSidebarCollapsed,
      stack,
      current,
      push,
      pop,
      replace,
      setTab,
      expandManually,
      enterManually,
      openInPopup,
    }),
    [phoneMode, forceSidebarCollapsed, stack, current, push, pop, replace, setTab, expandManually, enterManually, openInPopup],
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
      forceSidebarCollapsed: false,
      stack: [{ kind: 'dialer' }],
      current: { kind: 'dialer' },
      push: () => {},
      pop: () => {},
      replace: () => {},
      setTab: () => {},
      expandManually: () => {},
      enterManually: () => {},
      openInPopup: () => null,
    };
  }
  return ctx;
}
