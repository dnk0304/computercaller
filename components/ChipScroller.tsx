'use client';

/**
 * ChipScroller — a horizontal chip strip that is actually scrollable with a
 * mouse, in a 360 px extension panel.
 *
 * THE BUG THIS EXISTS TO FIX (Dennis, 2026-09-16: "in the extension, i can
 * still not scroll the message templates")
 *
 * The previous strip WAS a real `overflow-x: auto` scroller with fade masks,
 * and B2 AC-2 was signed off on that basis. It is unreachable anyway, because
 * every input a desktop panel user actually has is a no-op on it:
 *
 *   1. A vertical mouse wheel does not scroll a horizontally-overflowing box
 *      in Chrome. Chrome only maps wheel to `scrollLeft` when the box has no
 *      vertical overflow AND the event carries `deltaX` (trackpad swipe) or
 *      Shift is held. A plain wheel over the strip scrolls the ancestor that
 *      CAN scroll vertically — the message list — so the strip looks frozen
 *      while something else moves. That is exactly what Dennis sees.
 *   2. The scrollbar is hidden (`scrollbar-width: none` +
 *      `::-webkit-scrollbar { display: none }`), so there is nothing to drag.
 *   3. A `div` is not draggable. No pointer handler existed, so click-and-drag
 *      did nothing either.
 *   4. Touch drag works — which is why this passed on a touch/trackpad check
 *      and failed on the machine the extension actually runs on.
 *
 * So the strip scrolled only for inputs Dennis does not use. The fix is to
 * give it the inputs he does:
 *
 *   - WHEEL → `scrollLeft`, via a non-passive native listener (React's
 *     synthetic `onWheel` is delegated to the root and passive in Chrome, so
 *     `preventDefault()` there is ignored and the page scrolls anyway).
 *     Only claimed while the strip actually overflows in the wheel's direction,
 *     so at either end the gesture falls through to the list behind — a strip
 *     that swallows the wheel forever is its own trap.
 *   - DRAG → pointer events with a 4 px threshold, so a press-and-release on a
 *     chip is still a chip tap and only a real drag pans. The click that
 *     follows a drag is swallowed in the capture phase; without that, letting
 *     go after a pan inserts whichever template you released over.
 *   - ARROW BUTTONS → the affordance that needs no gesture at all. A fade edge
 *     says "there is more"; it does not say "and here is how to get it". They
 *     appear only on an edge that overflows, are 28 px of always-hittable
 *     target inside the 32 px strip, and are `aria-hidden` because the
 *     scroller itself is already keyboard-operable with the arrow keys.
 *
 * Native keyboard scrolling is preserved: the scroller keeps `tabIndex={0}`
 * and the chips are real focusable children, so Tab brings an off-screen chip
 * into view for free.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ChipScrollerProps {
  /** Accessible name for the toolbar, e.g. "Insert template". */
  label: string;
  /** Noun used in the arrow buttons' titles, e.g. "templates". */
  itemNoun: string;
  /** Extra classes for the scrolling element (padding, gap, ring colour). */
  className?: string;
  children: React.ReactNode;
}

/** How much of the visible width one arrow press moves. */
const PAGE_FRACTION = 0.7;
/** Pointer travel before a press stops being a tap and becomes a pan. */
const DRAG_THRESHOLD_PX = 4;

export function ChipScroller({ label, itemNoun, className = '', children }: ChipScrollerProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Which edges are actually overflowing. Drives the fades AND the arrows — an
  // affordance on a non-overflowing edge is a lie that says "there's more".
  const [edges, setEdges] = useState({ left: false, right: false });

  const syncEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  // Re-measure on content changes, on panel resize (popup → pop-out) and on
  // scroll. ResizeObserver on the scroller catches width changes; a
  // MutationObserver catches chips arriving from the manager mid-mount.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    syncEdges();
    const ro = new ResizeObserver(syncEdges);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(syncEdges);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [syncEdges, children]);

  // ---- wheel → scrollLeft (non-passive; see the header note) --------------
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return; // nothing to scroll — let the list behind have it
      // Prefer a real horizontal gesture when the trackpad sends one;
      // otherwise translate the vertical wheel.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft >= max - 1;
      // At an end, hand the gesture back so the user can keep scrolling the
      // thread behind instead of hitting a dead zone.
      if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
      e.preventDefault();
      el.scrollLeft += delta;
      syncEdges();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [syncEdges]);

  // ---- pointer drag to pan -------------------------------------------------
  const drag = useRef<{ id: number; startX: number; startLeft: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only, and never steal a touch gesture — native touch
    // panning is already smooth and momentum-scrolled.
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const el = stripRef.current;
    if (!el || el.scrollWidth - el.clientWidth <= 1) return;
    drag.current = { id: e.pointerId, startX: e.clientX, startLeft: el.scrollLeft, moved: false };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = stripRef.current;
    if (!d || !el || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      setDragging(true);
      // Capture so the pan survives the pointer leaving the 32 px strip.
      try { el.setPointerCapture(d.id); } catch { /* capture is best-effort */ }
    }
    el.scrollLeft = d.startLeft - dx;
    syncEdges();
  }, [syncEdges]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = stripRef.current;
    if (!d || e.pointerId !== d.id) return;
    if (el?.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
    // Keep `moved` readable by the click-capture handler that fires next tick.
    justDragged.current = d.moved;
    drag.current = null;
    setDragging(false);
  }, []);

  const justDragged = useRef(false);
  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!justDragged.current) return;
    justDragged.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const page = useCallback((dir: -1 | 1) => {
    const el = stripRef.current;
    if (!el) return;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({
      left: dir * Math.max(80, el.clientWidth * PAGE_FRACTION),
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, []);

  const arrowClass =
    'absolute inset-y-0 z-10 flex w-7 items-center justify-center text-slate-500 ' +
    'transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-blue-500/50';

  return (
    <div className="relative flex-shrink-0 border-t border-slate-200/60 bg-slate-50/80">
      <div
        ref={stripRef}
        onScroll={syncEdges}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        role="toolbar"
        aria-label={label}
        // tabIndex on the scroll container: a keyboard user who is not tabbing
        // chip-by-chip can still arrow the strip.
        tabIndex={0}
        // `touch-action: pan-x` keeps native touch panning and stops the
        // browser claiming the gesture for a vertical scroll of the ancestor.
        style={{ touchAction: 'pan-x', cursor: dragging ? 'grabbing' : undefined }}
        className={
          'flex items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] ' +
          '[&::-webkit-scrollbar]:hidden focus:outline-none focus-visible:ring-2 ' +
          'focus-visible:ring-inset focus-visible:ring-emerald-500/40 ' +
          (dragging ? 'select-none ' : '') + className
        }
      >
        {children}
      </div>

      {/* Fade + arrow per overflowing edge. The fade is the "there is more"
          signal; the arrow is the way to get there without a gesture. */}
      {edges.left && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-9 bg-gradient-to-r from-slate-100 via-slate-100/85 to-transparent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => page(-1)}
            title={`Scroll ${itemNoun} left`}
            className={`${arrowClass} left-0`}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {edges.right && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-9 bg-gradient-to-l from-slate-100 via-slate-100/85 to-transparent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => page(1)}
            title={`Scroll ${itemNoun} right`}
            className={`${arrowClass} right-0`}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
