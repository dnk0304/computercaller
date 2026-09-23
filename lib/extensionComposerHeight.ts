'use client';

/**
 * COMPOSER HEIGHT for the EXTENSION surface only — the auto-grow cap, and the
 * user's own dragged height when they have set one.
 *
 * WHY (dispatch PIXEL EXT-UI-COMPOSER, Dennis 2026-09-23 11:06): "in the
 * extension, when i now write a message, the text field expands, i want it to
 * expand 20% more. Or is it possible to make it so user can drag to expand it
 * and it gets saved in his settings (that i remembers it)?" — both, so both
 * live here:
 *
 *   autoCapFor(innerHeight)  the +20% auto-grow cap (A1)
 *   read/writeStoredHeight   the dragged height, per account (A2)
 *
 * SEMANTICS, and the only subtle part: a stored height PINS the box — it is
 * both the floor and the ceiling, and long text scrolls inside it exactly as
 * it scrolls past the derived cap today. No stored height = pure A1 auto-grow,
 * and double-click on the handle returns to it.
 *
 * The dispatch's literal wording was "auto-grow still runs from 36 up to the
 * user cap". That reads fine and fails in the hand: with an empty draft you
 * drag the box to 200px, release, and it collapses back to one line, so the
 * gesture looks broken. A resize handle sets the size — that is the whole
 * meaning of the gesture, and it is what Dennis asked for ("drag to expand
 * it"). The auto behaviour is not lost, it is one double-click away.
 *
 * STORAGE mirrors lib/extensionTextSize.ts EXACTLY — per account under
 * `cc:composer:<email>`, `cc:composer:last` beside it, every read and write
 * wrapped because localStorage throws outright in a profile with site data
 * blocked. Niki's dispatch proposed chrome.storage.local keyed by userId; Ken
 * RULED for this plumbing instead so the two extension prefs live and die
 * together — one storage model to reason about, one sign-out story, and the
 * composer height cannot outlive a text size that was cleared beside it.
 *
 * NO BOOT SCRIPT, unlike text size and theme. Those two paint on the very
 * first frame, so reading them late is a visible jump. The composer is inside
 * a thread view that mounts after the shell — by the time it exists React has
 * the value, so there is nothing to flash.
 *
 * NOT RESET ON SIGN-OUT, mirroring text size and theme: neither clears its key
 * today (there is no removeItem for `cc:size:` or `cc:theme:` anywhere in the
 * tree), and the keys are per-email, so the next account in a shared profile
 * reads its own value rather than inheriting this one. Signing back in finds
 * your box the size you left it — which is the whole ask.
 */

/** One line. Today's composer minimum, unchanged by this dispatch. */
export const COMPOSER_MIN_PX = 36;

/**
 * A sanity ceiling for STORED values only — not the live max, which is
 * computed from the panel DOM. A number past this is a corrupt record (or
 * another tab's), not a tall panel, and is ignored on read.
 */
const COMPOSER_STORE_MAX_PX = 2000;

const LAST_KEY = 'cc:composer:last';

function keyFor(email: string | null | undefined) {
  return email ? `cc:composer:${email.toLowerCase()}` : 'cc:composer:anon';
}

/**
 * The auto-grow cap, +20% on every term of the 2026-09-16 formula
 * (`clamp(96, round(h*0.4), 168)`). Derived from the window rather than
 * hardcoded for the original reason: in the 560px side panel it lands at the
 * ceiling (202px, ~7 lines) while the conversation above stays readable, and
 * in a short pop-out it shrinks instead of eating the thread.
 */
export function autoCapFor(viewportPx: number): number {
  const h = Number.isFinite(viewportPx) && viewportPx > 0 ? viewportPx : 560;
  return Math.max(115, Math.min(202, Math.round(h * 0.48)));
}

/** Integer px inside [min, max]. The one clamp every caller goes through. */
export function clampHeight(px: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return min;
  return Math.max(min, Math.min(Math.round(px), Math.max(min, max)));
}

/**
 * The user's stored height, or null for "no preference — use the auto cap".
 * Validated rather than trusted: a non-integer, NaN, or an out-of-range value
 * is treated as absent, because the alternative is a composer that opens at
 * 0px or fills the panel and cannot be argued with.
 */
export function readStoredHeight(email: string | null | undefined): number | null {
  try {
    const raw = window.localStorage.getItem(keyFor(email));
    if (raw == null) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    if (n < COMPOSER_MIN_PX || n > COMPOSER_STORE_MAX_PX) return null;
    return n;
  } catch {
    return null;
  }
}

export function writeStoredHeight(email: string | null | undefined, px: number) {
  try {
    const n = clampHeight(px, COMPOSER_MIN_PX, COMPOSER_STORE_MAX_PX);
    window.localStorage.setItem(keyFor(email), String(n));
    window.localStorage.setItem(LAST_KEY, String(n));
  } catch {
    /* site data blocked — the drag still applies for this session */
  }
}

/** Double-click on the handle: back to auto. */
export function clearStoredHeight(email: string | null | undefined) {
  try {
    window.localStorage.removeItem(keyFor(email));
    window.localStorage.removeItem(LAST_KEY);
  } catch {
    /* nothing was stored anyway */
  }
}
