'use client';

import { useEffect } from 'react';

/**
 * ExtPointerFocus — EXT-UI-8 item 3. Marks the editable a POINTER just focused
 * so the stylesheet can drop the focus box for that one interaction.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Dennis, 2026-09-22 12:49Z: "when i click to dial number a square marking that
 * field comes up, see image from extension. This should not be visible, neither
 * dark nor light mode."
 *
 * `app/extension/extension.css` gives every focused element in the panel a 2px
 * brand-green outline (`.cc-ext :focus-visible`). That is correct for buttons
 * and links. It is wrong on a text field, because of a rule most people expect
 * to save them and which does not: per the CSS-UI spec heuristic, a focused
 * EDITABLE element always matches `:focus-visible`, pointer or keyboard. So
 * `:focus:not(:focus-visible)` — the usual "mouse users get no ring" idiom —
 * is a no-op on an input, and the green rectangle appears on a plain click.
 * That is why this needs a flag at all.
 *
 * ── WHY ONE DELEGATED LISTENER AND NOT A PROP ON FIVE INPUTS ────────────────
 * The complaint named the dial field, but the same rectangle is on the Texts
 * search, the call-log search, the composer and the new-message recipient — and
 * on the next input anyone adds. Threading a hook through five call sites fixes
 * five inputs and quietly re-opens the defect on the sixth. Two capture-phase
 * document listeners fix the CLASS of defect, cost nothing per render, and stay
 * correct for inputs that do not exist yet.
 *
 * The flag is a DOM attribute set imperatively, not React state: it must not
 * re-render a field the user is typing into, and its only consumer is a
 * stylesheet.
 *
 * ── WHEN THE CUE COMES BACK ─────────────────────────────────────────────────
 * The flag is cleared by ANY keydown and by any subsequent pointerdown, so a
 * user who clicks into a field and then starts typing — or tabs away and back —
 * gets the keyboard cue immediately. Accessibility is not traded away here: the
 * cue is not removed, it is restyled (an underline rather than a box) and
 * withheld for exactly the one gesture that already told the user where focus
 * went, because their finger is on it.
 */

/** Everything that takes a caret. Not `:read-write` — Safari support is spotty. */
const EDITABLE =
  'input, textarea, [contenteditable=""], [contenteditable="true"]';

const ATTR = 'data-cc-pointer-focus';

export function ExtPointerFocus() {
  useEffect(() => {
    const clear = () => {
      document
        .querySelectorAll(`[${ATTR}]`)
        .forEach((el) => el.removeAttribute(ATTR));
    };

    const onPointerDown = (e: Event) => {
      // Previous mark first: only ever one pointer-focused field at a time.
      clear();
      const target = e.target;
      if (!(target instanceof Element)) return;
      const field = target.closest(EDITABLE);
      // `.cc-ext` scope, in CSS and in JS: /app shares these components and
      // must keep the focus behaviour it has today.
      if (field && field.closest('.cc-ext')) field.setAttribute(ATTR, '1');
    };

    // Capture phase so a component that stops propagation (the composer's
    // Escape handler, the search fields' clear-on-Escape) cannot blind this.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', clear, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', clear, true);
      clear();
    };
  }, []);

  return null;
}
