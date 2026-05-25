'use client';

/**
 * Soft-blurred banner backdrop for /auth/* pages.
 *
 * Renders the approved ComputerCaller color banner as a fixed, full-viewport
 * background layer behind the auth card. The image is blurred heavily
 * (60-80px) and dropped to ~18% opacity so it reads as a color/texture wash,
 * not a recognizable logo — establishes brand presence without competing
 * with the form chrome on top.
 *
 * Why fixed (not absolute on the page wrapper):
 *   The auth card sits inside a `flex items-center` parent that uses
 *   min-h-screen. On short viewports, the form can scroll; fixing the
 *   backdrop to the viewport keeps the wash steady behind everything,
 *   matching desktop-app feel (the chrome never moves under content).
 *
 * Mobile considerations:
 *   - Banner is decorative — `aria-hidden`, no alt text needed.
 *   - We load eager-priority via next/image because the page above it is
 *     already render-blocking on the form card; pulling the backdrop in
 *     parallel doesn't hurt LCP (LCP is the auth card text/inputs).
 *   - On viewports < 640px we drop the blur intensity and opacity slightly
 *     — heavy blur on small low-end GPUs can stutter on scroll.
 *
 * Accessibility:
 *   - The card on top uses `bg-white` (not translucent) so form text stays
 *     fully crisp — WCAG AA contrast is unaffected by the backdrop.
 *   - Decorative only; semantic SR users get nothing.
 */

import Image from 'next/image';

export function AuthBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/*
        Layer 1 — the banner itself, scaled up + blurred. We oversize via
        `scale-125` so the blur halo doesn't reveal the source rectangle
        edges at the viewport corners (blur expands the visual footprint
        outward; scaling up first hides the seams).
      */}
      <div className="absolute inset-0 scale-125">
        <Image
          src="/brand/computercaller-logo-color-banner.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="
            object-cover
            opacity-[0.18]
            blur-3xl
            saturate-[0.9]
            sm:blur-[80px]
            sm:opacity-[0.22]
          "
        />
      </div>

      {/*
        Layer 2 — soft top-to-bottom white wash. Anchors the visual weight
        toward the center, keeps the upper edge from feeling busy near the
        nav-less auth header, and ensures readability of any text that
        might sit near the very top of the viewport.
      */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-50 via-slate-50/40 to-slate-50/80" />
    </div>
  );
}
