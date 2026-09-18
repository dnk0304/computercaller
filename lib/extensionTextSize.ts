'use client';

/**
 * Small / Medium / Large TYPE SIZE for the EXTENSION surface only.
 *
 * WHY (dispatch PIXEL-S, Dennis 2026-09-17 10:41): "increase the font size with
 * 20%, or can we add an option so user can pick the size themselves, small,
 * medium, large?" — and 10:42, on what the three mean: "normal size shall be
 * 20% larger than now. Small shall be the current size and large shall be 40%
 * bigger than now."
 *
 *   small  = 1.00x  today's 0.8x-density type, unchanged
 *   medium = 1.20x  THE NEW DEFAULT
 *   large  = 1.40x
 *
 * The factor multiplies the TYPE tokens in app/extension/extension.css
 * (font-size, and the two band heights that must follow taller type so nothing
 * clips). It never touches a layout WIDTH or the panel width — a Chrome side
 * panel is 360-400px and a picker that reflows the column is a different
 * feature.
 *
 * /app IS DELIBERATELY NOT INCLUDED, and the mechanism — not a promise — is
 * what keeps it out: the CSS reads `[data-cc-size=…] .cc-ext`, and .cc-ext is
 * set by PhoneModeShell surface="extension" and by nothing else. There is no
 * "absent = medium" fallback for the same reason: the dashboard would grow 20%
 * the day someone stamped the attribute one level too high.
 *
 * STORAGE, and the boot script, mirror lib/extensionTheme.ts exactly — per
 * account under `cc:size:<email>`, `cc:size:last` for the pre-session paint,
 * every read and write wrapped because localStorage throws outright in a
 * profile with site data blocked. See that file's header for the full
 * reasoning; this module deliberately does not restate it.
 */

import { CC_EXTENSION_ORIGIN } from '@/lib/extension';

export type CcSize = 'small' | 'medium' | 'large';

export const CC_SIZES: CcSize[] = ['small', 'medium', 'large'];

/** The default, and the one value that is NOT today's type. Dennis 10:42. */
export const CC_DEFAULT_SIZE: CcSize = 'medium';

/** The factor each choice multiplies the type tokens by. Mirrors the CSS. */
export const CC_SIZE_FACTOR: Record<CcSize, number> = {
  small: 1,
  medium: 1.2,
  large: 1.4,
};

const LAST_KEY = 'cc:size:last';

function keyFor(email: string | null | undefined) {
  return email ? `cc:size:${email.toLowerCase()}` : 'cc:size:anon';
}

function isSize(v: unknown): v is CcSize {
  return v === 'small' || v === 'medium' || v === 'large';
}

export function readStoredSize(email: string | null | undefined): CcSize {
  try {
    const v = window.localStorage.getItem(keyFor(email));
    return isSize(v) ? v : CC_DEFAULT_SIZE;
  } catch {
    return CC_DEFAULT_SIZE;
  }
}

export function writeStoredSize(email: string | null | undefined, size: CcSize) {
  try {
    window.localStorage.setItem(keyFor(email), size);
    window.localStorage.setItem(LAST_KEY, size);
  } catch {
    /* site data blocked — the choice still applies for this session */
  }
}

/**
 * Stamp the size on <html>, next to `data-cc-theme` and for the same reason:
 * the boot script has to set it before the React tree exists, and .cc-ext is
 * rendered by the server, which cannot know the preference.
 */
export function applySize(size: CcSize) {
  document.documentElement.setAttribute('data-cc-size', size);
  postSizeToShell(size);
}

/**
 * Tell chrome-extension/shell.js which size this frame painted, so the shell
 * chrome around the iframe (the signed-out header, the sign-in hero) is set in
 * the same type. Identical wire to the theme message, addressed to
 * CC_EXTENSION_ORIGIN rather than '*' for the same FORGE-P reason.
 */
function postSizeToShell(size: CcSize) {
  try {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage({ source: 'cc-ext', type: 'size', size }, CC_EXTENSION_ORIGIN);
  } catch {
    /* a framer that refuses postMessage must not break the type */
  }
}

/**
 * The blocking boot script, inlined by app/extension/layout.tsx beside
 * THEME_BOOT_SCRIPT. Without it the panel paints Small and jumps to Medium a
 * frame later, on every open, for everyone — which is a worse flash than the
 * theme one because the layout moves, not just the colour.
 */
export const SIZE_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('${LAST_KEY}');if(s!=='small'&&s!=='medium'&&s!=='large')s='${CC_DEFAULT_SIZE}';document.documentElement.setAttribute('data-cc-size',s);try{if(window.parent!==window)window.parent.postMessage({source:'cc-ext',type:'size',size:s},'${CC_EXTENSION_ORIGIN}');}catch(e2){}}catch(e){}})();`;
