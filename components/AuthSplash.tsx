'use client';

/**
 * Post-signin splash transition with cross-fade handoff to the dashboard.
 *
 * Goal: after a successful sign-in (or register-then-sign-in), show a brief
 * full-screen splash with the ComputerCaller banner before navigating to
 * /app — and crucially, cross-fade the splash AWAY over the dashboard so
 * the new route reveals underneath rather than slamming into view.
 *
 * Timing (~3700ms total — fade-out tripled per Dennis QA 2026-05-26):
 *   0-250ms      Phase 1: splash fades IN over the auth form
 *                (cc-splash-fade-in keyframe).
 *   80-430ms     Banner + subtitle lift up (cc-splash-rise, overlapping
 *                with phase 1's fade-in so the entrance feels coordinated).
 *   250-1300ms   Phase 2: splash holds at full opacity (~1050ms of stillness).
 *                The eye reads the banner. The brain registers "launching".
 *   1300ms       HANDOFF: we clone the splash DOM into document.body as a
 *                detached node, then fire onDone() which calls router.push().
 *                The React splash unmounts (its owner page navigates away),
 *                but the clone is now a free-standing DOM element that the
 *                React tree no longer controls.
 *   1300-3700ms  Phase 3: the cloned splash fades from opacity 1 -> 0 over
 *                2400ms ease-out via a CSS transition. The dashboard, rendered
 *                underneath, becomes progressively visible.
 *   3700ms       transitionend fires; the clone removes itself from the DOM.
 *
 * Why the DOM clone? React-managed nodes inside the auth page unmount the
 * moment router.push() resolves the new route. To make the splash survive
 * across the route boundary we hand it off to plain DOM — outside React's
 * reconciler — so it can continue its fade-out independently while the new
 * route mounts beneath it. The clone is pointer-events:none so the user can
 * interact with the dashboard immediately, even during the fade.
 *
 * Reduced-motion: users who set prefers-reduced-motion: reduce skip the
 * entire splash. We fire onDone() synchronously on mount — no overlay, no
 * delay, no cross-fade. They get straight to the dashboard.
 *
 * The banner uses `priority` so if it was preloaded by the blurred backdrop
 * on the previous step (login page), it's an instant paint from cache.
 *
 * Render strategy: position:fixed/z-50 overlay rather than mounting a route
 * — no extra navigation, no router latency, no flicker between auth card
 * and splash. The auth page mounts the splash on top in-place, then unmounts
 * itself when the splash hands off and navigates away.
 */

import { useEffect, useRef } from 'react';
import Image from 'next/image';

interface AuthSplashProps {
  /** Called at ~1300ms (start of fade-out / route push), or immediately under reduced motion. */
  onDone: () => void;
  /** Optional subtitle to set tone — defaults to "Welcome back". */
  subtitle?: string;
}

// Phase timings — declared as constants so the comment block above stays
// in lockstep with the code if anyone tunes the durations later.
const SPLASH_HOLD_MS = 1300; // duration until handoff fires (phase 1 + phase 2)
const SPLASH_FADE_OUT_MS = 2400; // duration of the post-handoff fade (3x slower per Dennis QA 2026-05-26 — keep in lockstep with .cc-splash-fade-out transition in globals.css)
// Class used on the cloned DOM node so we can ensure no duplicate handoffs
// run if the component remounts unexpectedly.
const CLONE_MARKER_CLASS = 'cc-splash-clone';

export function AuthSplash({ onDone, subtitle = 'Welcome back' }: AuthSplashProps) {
  // The element we'll clone at handoff. Capturing via ref means we don't
  // need to re-query the DOM at the critical moment — and avoids selector
  // brittleness if a parent ever wraps the splash.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Guard against double-invocation in React 18 strict-mode dev double-mounts
  // and against re-renders that change `onDone` identity mid-flight.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    // Respect the system motion preference. matchMedia is universally
    // available in the browsers we target; SSR-safe because this lives
    // inside useEffect (client-only).
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    if (prefersReducedMotion) {
      // No splash for users who asked for less motion — fire immediately
      // so the parent's router.push runs without delay. They still get the
      // session set; they just skip the launch animation entirely.
      onDone();
      return;
    }

    const handoffTimer = window.setTimeout(() => {
      // Phase 2 -> Phase 3 handoff. Clone the splash into document.body
      // as a free-standing DOM node, kick off its fade-out, then call
      // onDone() so the parent navigates. The React splash will unmount
      // a beat later when the route changes; the clone keeps fading.
      const sourceEl = rootRef.current;
      if (sourceEl && typeof document !== 'undefined') {
        // Defensive: if a prior splash clone is still mid-fade (hot reload
        // in dev, fast back/forward, etc.), remove it before adding a new
        // one so we never end up with stacked overlays.
        document
          .querySelectorAll(`.${CLONE_MARKER_CLASS}`)
          .forEach((node) => node.remove());

        const clone = sourceEl.cloneNode(true) as HTMLElement;
        clone.classList.add(CLONE_MARKER_CLASS, 'cc-splash-fade-out');
        // Strip animation classes from the clone — the entrance animations
        // already played on the original; replaying them on the clone would
        // cause it to fade back in before fading out. We want it to start
        // at opacity:1 and only fade out.
        clone.classList.remove('animate-cc-splash-fade-in');
        const inner = clone.querySelector('.animate-cc-splash-rise');
        if (inner) inner.classList.remove('animate-cc-splash-rise');
        // Ensure starting opacity is explicit so the transition has a
        // defined "from" value when we flip to 0 on the next frame.
        clone.style.opacity = '1';
        // Sit above the new route's chrome (route content is typically
        // z-auto / z-0); we used z-50 inside the React tree, keep parity
        // for the clone via inline style so it doesn't depend on Tailwind
        // class re-evaluation outside the React tree.
        clone.style.zIndex = '50';
        // Mark the clone aria-hidden — the original already announced
        // "Welcome back" via role=status; we don't want SR users to hear
        // it twice during the fade-out.
        clone.setAttribute('aria-hidden', 'true');
        clone.removeAttribute('role');
        clone.removeAttribute('aria-live');

        document.body.appendChild(clone);

        // Force a reflow so the browser registers opacity:1 as the start
        // state before we transition to 0. Without this, some browsers
        // collapse the change into a single paint and the fade skips.
        void clone.offsetHeight;

        // Self-cleanup once the fade completes. We listen on the clone
        // itself (the transition target) and fall back to a setTimeout
        // in case transitionend never fires (background tabs throttle
        // transitions; a paranoid backstop keeps the DOM clean).
        const cleanup = () => {
          clone.removeEventListener('transitionend', cleanup);
          clone.remove();
        };
        clone.addEventListener('transitionend', cleanup, { once: true });
        window.setTimeout(cleanup, SPLASH_FADE_OUT_MS + 200);

        // Kick the transition off on the next frame so the browser has a
        // chance to paint opacity:1 first. rAF is more reliable than a
        // setTimeout(0) here across browsers.
        requestAnimationFrame(() => {
          clone.style.opacity = '0';
        });
      }

      // Trigger the navigation. The new route renders UNDER the cloned
      // splash, which is now mid-fade and pointer-events-none.
      onDone();
    }, SPLASH_HOLD_MS);

    return () => window.clearTimeout(handoffTimer);
  }, [onDone]);

  return (
    <div
      ref={rootRef}
      // role=status — assistive tech announces "Welcome back" so SR users
      // also get launch feedback even without seeing the visual.
      role="status"
      aria-live="polite"
      // Background gradient sampled from the banner PNG's top edge (#dfeaf3,
      // light cool blue) to its bottom edge (#f6fbfd, near-white blue-tinted).
      // This makes the banner's own internal gradient dissolve into the splash
      // surface so there's no visible image edge — the whole screen reads as
      // a single illustrated surface rather than "image on a white card".
      // (Per Dennis QA 2026-05-26: "make the background match the banner".)
      className="
        fixed inset-0 z-50
        flex items-center justify-center
        bg-gradient-to-b from-[#dfeaf3] to-[#f6fbfd]
        animate-cc-splash-fade-in
        motion-reduce:animate-none
      "
    >
      {/* Subtle radial brand wash — feels less clinical than pure white. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,_rgba(37,99,235,0.06),_transparent_60%)]"
      />

      <div
        className="
          relative flex flex-col items-center
          animate-cc-splash-rise
          motion-reduce:animate-none
        "
      >
        <Image
          src="/brand/computercaller-logo-color-banner.png"
          alt="ComputerCaller"
          width={801}
          height={406}
          priority
          // Cap visual width — the banner is wide; we don't want it bumping
          // viewport edges on tablets. max-w + h-auto keeps the aspect ratio
          // intact across breakpoints.
          className="w-[min(440px,82vw)] h-auto"
        />
        <p className="mt-6 text-sm font-medium tracking-wide text-slate-500">
          {subtitle}
        </p>
      </div>
    </div>
  );
}
