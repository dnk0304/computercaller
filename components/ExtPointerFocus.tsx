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
 * Accessibility is not traded away here. The cue is not removed: it is restyled
 * (an underline rather than a box) and withheld only when the user already
 * knows where the caret is — they just clicked there, or the panel autofocused
 * the dial field on open and nobody asked for it. Tab into a field and the cue
 * is there on arrival, because that is the only way a keyboard user can see
 * where focus went. Type into a field you clicked and it appears too.
 *
 * `data-cc-pointer-focus` keeps the name the dispatch gave it; what it really
 * marks is "focus that did not come from the keyboard", which includes
 * autofocus.
 */

/** Everything that takes a caret. Not `:read-write` — Safari support is spotty. */
const EDITABLE =
  'input, textarea, [contenteditable=""], [contenteditable="true"]';

const ATTR = 'data-cc-pointer-focus';

export function ExtPointerFocus() {
  useEffect(() => {
    /**
     * Was the LAST interaction a key press? This is the same heuristic the
     * browser applies to buttons for `:focus-visible`; it is reimplemented here
     * only because the browser refuses to apply it to editables.
     */
    let keyboard = false;

    const flag = (el: Element | null) => {
      if (el && el.closest('.cc-ext')) el.setAttribute(ATTR, '1');
    };
    const unflag = (el: Element | null) => el && el.removeAttribute(ATTR);

    const onPointerDown = () => { keyboard = false; };

    const onKeyDown = () => {
      keyboard = true;
      // Typing in a field the user CLICKED into brings the cue back: they are
      // working in it now, and from here on the caret position matters.
      // Runs before focusin for Tab, so the element being left is the one
      // cleared and the element arriving is judged on `keyboard` above.
      unflag(document.activeElement);
    };

    const onFocusIn = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const field = target.closest(EDITABLE);
      if (!field) return;
      // Three ways a field gets focus, and only one of them should paint a cue:
      //   Tab / arrow keys  -> keyboard === true  -> CUE. The user cannot see
      //                        where focus went any other way.
      //   a click or tap    -> keyboard === false -> no cue. Their finger is
      //                        on it; a box around it says nothing new. This is
      //                        Dennis's complaint.
      //   autofocus on open -> keyboard === false -> no cue. Nobody asked for
      //                        the caret to be there, so nothing should be lit
      //                        up because of it. (The dial field autofocuses on
      //                        every panel open, so this is the state the panel
      //                        spends most of its life in.)
      if (keyboard) unflag(field); else flag(field);
    };

    // Catch a field that was already focused when this mounted (autofocus wins
    // the race against the effect often enough to matter).
    if (document.activeElement && document.activeElement.matches(EDITABLE)) {
      flag(document.activeElement);
    }

    // Capture phase so a component that stops propagation (the composer's
    // Escape handler, the search fields' clear-on-Escape) cannot blind this.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
    };
  }, []);

  return null;
}
