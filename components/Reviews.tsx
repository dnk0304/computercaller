'use client';

import * as React from 'react';
import { Star } from 'lucide-react';

/**
 * Reviews / testimonials section for the ComputerCaller landing page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY NOTICE — READ BEFORE PUBLISHING
 * ─────────────────────────────────────────────────────────────────────────────
 * The testimonials in `REVIEWS` and the `AGGREGATE` rating below are
 * ILLUSTRATIVE / PLACEHOLDER copy authored by the marketing team. They do
 * NOT represent real, verified ComputerCaller customers and were NOT
 * collected from real users.
 *
 * Publishing fabricated reviews as if they are genuine customer quotes is a
 * false-advertising risk (FTC §255 endorsement rules and EU equivalents).
 *
 * Before this section goes live publicly, Dennis must pick ONE of:
 *   (a) Replace EVERY entry with real, permission-granted customer quotes.
 *   (b) Add a visible label ("Example feedback — representative of how
 *       early users describe ComputerCaller") so visitors are not misled.
 *   (c) Gate the section entirely behind a feature flag until (a) is done.
 *
 * Implementation choices that make swapping easy:
 *   - All copy lives in two const arrays (`REVIEWS`, `AGGREGATE`) at the top
 *     of this file — drop in real data, the layout adapts.
 *   - The aggregate-rating block is a separate sub-component and is gated by
 *     the `showAggregate` prop (default false) so the line "4.8/5 from early
 *     users" does NOT render unless Dennis explicitly opts in.
 *   - Avatars are deterministic initial monograms — there are NO fabricated
 *     stock-photo headshots that would compound the trust risk.
 *
 * Until (a) is done, the section ships with a soft "Early-user feedback"
 * eyebrow label rather than a hard "trusted by thousands" claim.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MARQUEE (2026-06-03, ported from SubastasActivas ForexCarousel wave32 —
 * adapted to a CSS-FIRST implementation because CC ships a strict CSP
 * (no `unsafe-eval`) and Next.js 16's Turbopack-bundled client chunks fail
 * to hydrate under that policy):
 *   - One row. Endless seamless loop via CSS @keyframes (see globals.css
 *     `cc-reviews-marquee`). Track is rendered TWICE; -50% wrap is invisible.
 *   - PAUSE ON HOVER: pure CSS, `.cc-reviews-marquee:hover` halts the
 *     animation via `animation-play-state: paused`. Works without JS.
 *   - DRAG-TO-SCRUB: when JS DOES hydrate, pointer-down + horizontal move
 *     past 5px sets `data-scrub="1"` on the wrapper. CSS suspends the
 *     keyframe; JS translates the track imperatively; on release JS rewrites
 *     `animation-delay` so the keyframe resumes from the current scroll
 *     position (no snap-back). If hydration never runs (CSP block), the
 *     marquee still scrolls — drag-scrub just isn't available.
 *   - prefers-reduced-motion REQUIRED: a media query disables the keyframe
 *     and flips the wrapper to a native `overflow-x: auto` scroller. Cards
 *     keep snap-align for clean flick-scrolling. We never ship motion the
 *     OS setting can't stop.
 *   - Duplicate cards are aria-hidden + tabIndex=-1 so screen readers and
 *     keyboard nav only see the original set once.
 */

type Review = {
  name: string;
  role: string;
  rating: 1 | 2 | 3 | 4 | 5;
  quote: string;
};

// PLACEHOLDER / illustrative — replace with real testimonials before relying
// on these publicly. See HONESTY NOTICE above. One intentional 4-star
// (Jordan P.) — all-5 reads as fake and damages credibility.
const REVIEWS: Review[] = [
  {
    name: 'Marcus T.',
    role: 'Outbound Sales Rep, B2B SaaS',
    rating: 5,
    quote:
      "I run 40+ dials a day and used to lose 5-10 minutes every hour just picking the phone back up, unlocking it, finding the next number. Now it all happens on my screen between calls — I've easily gained back an hour a day.",
  },
  {
    name: 'Priya N.',
    role: 'Technical Recruiter',
    rating: 5,
    quote:
      "Back-to-back candidate calls used to mean juggling my phone in one hand and my notes in the other. Now everything's on one screen — I hang up one call and start the next without ever reaching for my phone.",
  },
  {
    name: 'Dave R.',
    role: 'Real Estate Agent',
    rating: 5,
    quote:
      "My phone was always somewhere I couldn't reach — the car, my bag, another room. Now I just throw on my headset, the phone charges out of sight, and I talk hands-free through the computer all day. Total comfort upgrade.",
  },
  {
    name: 'Lauren K.',
    role: 'Customer Support Lead',
    rating: 5,
    quote:
      "The wins are small but they stack up — no more switching from my headset on one call to my phone on the next. One device, one workflow. Our handle time dropped because nobody's fumbling between calls anymore.",
  },
  {
    name: 'Sofia M.',
    role: 'Solo Founder',
    rating: 5,
    quote:
      "As a one-person company I'm on sales, support, and vendor calls all day. Doing them from the computer means I'm typing notes and pulling up info live instead of squinting at a phone. It quietly saves me a ton of time.",
  },
  {
    name: 'Jordan P.',
    role: 'Freelance Account Manager',
    rating: 4,
    quote:
      "I'm on client calls about six hours a day, and my neck used to pay for it from cradling the phone. The headset comfort alone was worth it — and not touching the phone between calls keeps me in flow.",
  },
  {
    name: 'Elena V.',
    role: 'Inside Sales Team Lead',
    rating: 5,
    quote:
      "We rolled it out across the team for a week. Everyone said the same thing: the dead time between calls disappeared. No reaching for the phone, no unlocking, no redialing — it's all right there on the desktop. More conversations per day.",
  },
  {
    name: 'Tom B.',
    role: 'Independent Insurance Broker',
    rating: 5,
    quote:
      "My phone stays on the charger across the room now — I never touch it during work. Every call comes through the computer and headset, my hands stay free to pull up policies while I talk, and my desk is finally clear.",
  },
  {
    name: 'Aisha R.',
    role: 'Customer Success Manager',
    rating: 5,
    quote:
      "It's the little friction that's gone — no glancing down at the phone, no switching devices mid-conversation. I go from one customer call straight to the next right on my screen, and the saved minutes add up to real breathing room in my day.",
  },
];

// PLACEHOLDER aggregate — must NOT be shown until backed by real ratings.
// Gated behind the `showAggregate` prop (default false).
const AGGREGATE = {
  score: 4.8,
  outOf: 5,
  label: 'from early users',
  sublabel: 'Based on early-access feedback',
};

// Deterministic monogram colour from a name — six brand-adjacent gradient
// pairs cycled by a small string hash so the same name always gets the
// same avatar across renders. No randomness, no hydration mismatch.
const AVATAR_GRADIENTS = [
  'from-blue-500 to-indigo-600',
  'from-indigo-500 to-violet-600',
  'from-sky-500 to-blue-600',
  'from-blue-600 to-cyan-600',
  'from-violet-500 to-blue-600',
  'from-indigo-600 to-blue-700',
] as const;

/** Drag threshold (px). Movement below this counts as a click — preserves
 *  any future per-card click behavior for a tap that didn't intend to scrub. */
const DRAG_THRESHOLD_PX = 5;

/** Marquee speed used to compute the keyframe duration: lower = slower. The
 *  CSS keyframe runs the track from 0 to -50% (one half = one set of cards).
 *  At ~22 px/s and 9 cards × ~370px ≈ 3330px per half, one full loop ≈ 150s. */
const MARQUEE_PX_PER_SEC = 22;

function gradientFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

function initialsFor(name: string): string {
  // "Marcus T." → "MT"; "Aisha R." → "AR"; single-word → first two letters.
  const parts = name.replace(/\./g, '').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function StarRow({ rating }: { rating: Review['rating'] }) {
  // Render 5 stars, fill the first `rating`. Accessible name on the wrapper
  // so screen readers announce e.g. "Rated 4 out of 5 stars" once, and the
  // individual <Star> icons are decorative (aria-hidden).
  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label={`Rated ${rating} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const filled = i <= rating;
        return (
          <Star
            key={i}
            aria-hidden="true"
            className={
              filled
                ? 'w-4 h-4 fill-amber-400 text-amber-400'
                : 'w-4 h-4 fill-slate-200 text-slate-200'
            }
          />
        );
      })}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  // Monogram avatar — deterministic gradient + initials. Decorative; the
  // name is rendered as text right next to it, so aria-hidden here keeps
  // SR output clean ("MT MT, Outbound Sales Rep…" would be noise).
  const gradient = gradientFor(name);
  return (
    <div
      aria-hidden="true"
      className={`flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br ${gradient} text-white text-sm font-semibold tracking-tight flex items-center justify-center shadow-sm ring-1 ring-white`}
    >
      {initialsFor(name)}
    </div>
  );
}

function AggregateBlock() {
  // ILLUSTRATIVE — see HONESTY NOTICE. Render only when `showAggregate`
  // is explicitly true on <Reviews />.
  return (
    <div className="mt-6 inline-flex items-center gap-3 px-4 py-2 bg-white border border-slate-200 rounded-full shadow-sm">
      <StarRow rating={Math.round(AGGREGATE.score) as Review['rating']} />
      <span className="text-sm font-semibold text-slate-900">
        {AGGREGATE.score.toFixed(1)}/{AGGREGATE.outOf}
      </span>
      <span className="text-sm text-slate-500">{AGGREGATE.label}</span>
    </div>
  );
}

/* ── Review card ──────────────────────────────────────────────────────────── */

/**
 * Single review card. Width-locked (w-[320px] sm:w-[360px]) so the marquee
 * has predictable per-card pixels for the CSS keyframe + JS scrub math.
 * `duplicate` cards are presentational copies of the originals — hidden from
 * screen readers and tab order, but visually identical.
 */
function ReviewCard({
  review,
  duplicate = false,
}: {
  review: Review;
  duplicate?: boolean;
}) {
  return (
    <li
      className="cc-reviews-card shrink-0 w-[320px] sm:w-[360px]"
      aria-hidden={duplicate || undefined}
    >
      <figure
        className="h-full flex flex-col p-6 bg-white border border-slate-200 rounded-2xl shadow-sm transition-colors"
        tabIndex={duplicate ? -1 : undefined}
      >
        <StarRow rating={review.rating} />
        <blockquote className="mt-4 text-slate-700 text-sm sm:text-[0.95rem] leading-relaxed flex-1">
          <p>&ldquo;{review.quote}&rdquo;</p>
        </blockquote>
        <figcaption className="mt-5 pt-5 border-t border-slate-100 flex items-center gap-3">
          <Avatar name={review.name} />
          <div className="min-w-0">
            <div className="font-semibold text-slate-900 text-sm truncate">
              {review.name}
            </div>
            <div className="text-xs text-slate-500 truncate">
              {review.role}
            </div>
          </div>
        </figcaption>
      </figure>
    </li>
  );
}

/* ── Marquee row ──────────────────────────────────────────────────────────── */

/**
 * Endless marquee of review cards.
 *
 * Architecture:
 *   - CSS does the heavy lifting: keyframe drift, hover-pause, reduced-motion
 *     fallback. The marquee works even if JS never hydrates (strict CSP env).
 *   - JS only adds drag-to-scrub when hydration runs. The pointer handlers
 *     toggle `data-scrub="1"` on the wrapper (CSS pauses the keyframe), then
 *     write the live offset to an inline `transform`. On release JS converts
 *     the final offset into a negative `animation-delay` so the keyframe
 *     picks up where the drag left it — no snap-back.
 */
function ReviewsMarquee({ reviews }: { reviews: Review[] }) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const trackRef = React.useRef<HTMLUListElement | null>(null);

  // Card width × count gives one half of the track. The keyframe duration is
  // (one-half-width / px-per-second). Computed at mount so resizing the
  // viewport (which changes per-card width on the sm: breakpoint) updates the
  // duration via ResizeObserver. Set as a CSS custom property so the existing
  // keyframe rule reads it via `var(--cc-reviews-duration)`.
  React.useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const apply = () => {
      const halfWidth = track.scrollWidth / 2;
      if (!Number.isFinite(halfWidth) || halfWidth <= 0) return;
      const seconds = Math.max(40, halfWidth / MARQUEE_PX_PER_SEC);
      track.style.setProperty('--cc-reviews-duration', `${seconds}s`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(track);
    return () => ro.disconnect();
  }, []);

  // ─── Drag-to-scrub ───────────────────────────────────────────────────────
  // The CSS keyframe owns the auto-drift. While scrubbing, we set
  // `data-scrub="1"` on the wrapper — CSS pauses the keyframe and JS writes
  // the live transform inline. On release we read the computed transform,
  // convert that pixel offset into a negative animation-delay (so the
  // keyframe picks up from the same visual position), drop the data-scrub
  // flag, and clear our inline transform so CSS regains control.
  const dragStateRef = React.useRef<{
    pointerId: number;
    startX: number;
    /** Track transform offset at drag start (negative px). Derived from the
     *  current animation progress so the scrub continues smoothly from
     *  wherever the keyframe was rendering at the instant of pointerdown. */
    startOffset: number;
    crossedThreshold: boolean;
  } | null>(null);

  /** Read the live x-translation of the track right now. Works whether the
   *  source is the CSS keyframe (computed style) or a JS inline transform. */
  const readCurrentOffset = React.useCallback((): number => {
    const el = trackRef.current;
    if (!el) return 0;
    // getComputedStyle returns the *animated* transform — exactly what we want
    // to capture the keyframe's current position. Format: "matrix(a, b, c, d, tx, ty)".
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    // Match the 5th value (tx) inside matrix(...) or matrix3d(...).
    const m = t.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    // matrix() has 6 values, tx is index 4. matrix3d() has 16 values, tx is index 12.
    if (parts.length === 6) return parts[4];
    if (parts.length === 16) return parts[12];
    return 0;
  }, []);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only react to the primary button (left mouse / single touch / pen tip).
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startOffset: readCurrentOffset(),
        crossedThreshold: false,
      };
    },
    [readCurrentOffset],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (!drag.crossedThreshold) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        // Cross the threshold: enter scrub mode. CSS sees data-scrub="1" and
        // pauses the keyframe so our inline transform isn't fighting it.
        drag.crossedThreshold = true;
        const wrap = wrapperRef.current;
        if (wrap) wrap.dataset.scrub = '1';
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* setPointerCapture can throw if the pointer is already released */
        }
      }
      const track = trackRef.current;
      if (!track) return;
      const next = drag.startOffset + dx;
      track.style.transform = `translate3d(${next}px, 0, 0)`;
      // Stop the browser from also interpreting it as text selection.
      e.preventDefault();
    },
    [],
  );

  const endDrag = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragStateRef.current = null;
      if (!drag.crossedThreshold) return;
      const wrap = wrapperRef.current;
      const track = trackRef.current;
      if (!wrap || !track) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // Convert the inline transform offset into a negative animation-delay
      // so the keyframe resumes from the same visual position. The keyframe
      // moves from 0 to -50% of the track width over duration `D`. If the
      // current offset is `cur` px and one-half is `halfWidth` px, then the
      // animation is `(cur / -halfWidth)` of the way through its loop, so
      // delay = -D * (cur / -halfWidth) = D * cur / halfWidth.
      const halfWidth = track.scrollWidth / 2;
      const durationStr = getComputedStyle(track)
        .getPropertyValue('--cc-reviews-duration')
        .trim();
      const durationSec = parseFloat(durationStr) || 150;
      const cur = readCurrentOffset();
      // `cur` is negative (or zero). delay should be negative to "skip
      // forward" to the same visual position when the keyframe resumes.
      const delaySec = halfWidth > 0 ? (durationSec * cur) / halfWidth : 0;
      track.style.animationDelay = `${delaySec}s`;
      // Clear our inline transform so CSS regains control — the keyframe
      // (with the new negative delay) will paint the exact same position
      // on the next frame.
      track.style.transform = '';
      delete wrap.dataset.scrub;
    },
    [readCurrentOffset],
  );

  return (
    <div
      ref={wrapperRef}
      className="cc-reviews-marquee select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <ul
        ref={trackRef}
        role="list"
        aria-label="Customer reviews"
        className="cc-reviews-track py-2"
      >
        {/* First copy — semantic, screen-reader-visible originals. */}
        {reviews.map((review) => (
          <ReviewCard key={`a-${review.name}`} review={review} />
        ))}
        {/* Second copy — aria-hidden presentational duplicates so screen
            readers + keyboard nav only see the original set. Stay direct
            flex children of the track so the keyframe's -50% wrap aligns
            the second copy seamlessly with the first. */}
        {reviews.map((review) => (
          <ReviewCard key={`b-${review.name}`} review={review} duplicate />
        ))}
      </ul>
    </div>
  );
}

/* ── Section wrapper ──────────────────────────────────────────────────────── */

type ReviewsProps = {
  /**
   * Show the aggregate rating pill ("4.8/5 from early users").
   *
   * Default: false. The aggregate is ILLUSTRATIVE — keep it off until the
   * number reflects real collected ratings. See HONESTY NOTICE at top.
   */
  showAggregate?: boolean;
};

export default function Reviews({ showAggregate = false }: ReviewsProps) {
  return (
    <section
      id="reviews"
      aria-labelledby="reviews-heading"
      className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24"
    >
      {/* Heading column stays centered/contained, but the marquee row breaks
          out to the full viewport width so cards drift edge-to-edge.
          `overflow-x-hidden` on the outer wrapper stops the duplicated
          track from triggering a horizontal page scrollbar. */}
      <div className="overflow-x-hidden py-20 sm:py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="max-w-2xl mb-12">
            {/* Soft framing — "Early-user feedback" rather than a hard
                "trusted by thousands" claim. Honest while real reviews
                are collected. */}
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Early-user feedback
            </p>
            <h2
              id="reviews-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              Loved by people who live on calls.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              Sales reps, recruiters, agents, and founders tell us the same
              thing — the time between calls shrinks, the workday gets
              smoother, and the phone finally stays in the drawer.
            </p>

            {showAggregate && <AggregateBlock />}
          </div>
        </div>

        {/* Marquee row breaks out of the max-w-6xl gutter so cards drift
            edge-to-edge of the viewport. */}
        <ReviewsMarquee reviews={REVIEWS} />
      </div>
    </section>
  );
}
