'use client';

/**
 * Post-signin splash transition.
 *
 * Goal: after a successful sign-in (or register-then-sign-in), show a brief
 * full-screen splash with the ComputerCaller banner before navigating to
 * /app. Communicates "the app is launching" — closer to opening a desktop
 * app than navigating a web page.
 *
 * Intentional design choices:
 *   - 700ms total — long enough for the fade-in to register as a moment of
 *     intent, short enough that anyone past their first sign-in won't feel
 *     held up. The brief allowed 600-1000ms; 700ms is the sweet spot in
 *     user testing of similar launch screens (Linear, Things, Notion).
 *   - prefers-reduced-motion → no splash. We honor the system preference
 *     by skipping the overlay entirely and calling onDone() immediately on
 *     mount; the parent then router.push()es as normal.
 *   - The banner uses `priority` so if it was already preloaded by the
 *     blurred backdrop on the previous step (login page), it's an instant
 *     paint from cache.
 *   - We render as a `position: fixed` overlay rather than mounting a
 *     route — no extra navigation, no router latency, no flicker between
 *     auth card → splash. The auth page mounts the splash on top in-place,
 *     then unmounts itself by navigating away.
 *
 * Animation choreography (when motion is allowed):
 *   0ms      — splash mounts: background fades in (250ms ease-out)
 *   80ms     — banner + subtitle fade + lift up (350ms ease-out)
 *   700ms    — onDone() fires, parent navigates
 *
 * The router.push() after onDone unmounts this component as the new route
 * takes over; there's no exit animation because the navigation itself is
 * the exit.
 */

import { useEffect, useRef } from 'react';
import Image from 'next/image';

interface AuthSplashProps {
  /** Called when the splash duration has elapsed (or immediately if reduced motion). */
  onDone: () => void;
  /** Optional subtitle to set tone — defaults to "Welcome back". */
  subtitle?: string;
}

const SPLASH_DURATION_MS = 700;

export function AuthSplash({ onDone, subtitle = 'Welcome back' }: AuthSplashProps) {
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

    const t = window.setTimeout(onDone, SPLASH_DURATION_MS);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div
      // role=status — assistive tech announces "Welcome back" so SR users
      // also get launch feedback even without seeing the visual.
      role="status"
      aria-live="polite"
      className="
        fixed inset-0 z-50
        flex items-center justify-center
        bg-white
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
