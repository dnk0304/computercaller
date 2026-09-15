'use client';

/**
 * Light / dark / system for the EXTENSION surface only.
 *
 * WHY (dispatch J addendum, Dennis 2026-09-15 13:05): "when clicking on the
 * avatar username and the dropdown menu comes, there should be a quick toggle
 * for light/dark mode there as well." Until now the extension's dark mode was
 * whatever the OS said and nothing else — app/extension/extension.css did the
 * whole remap inside `@media (prefers-color-scheme: dark)`. Those media queries
 * are now gated on `[data-cc-theme=dark]` on <html>, and this module is what
 * puts it there.
 *
 * /app IS DELIBERATELY NOT INCLUDED. The dashboard has no dark theme at all
 * (Pixel-G, finding 3): its components paint with hard-coded light Tailwind
 * utilities and the extension only gets away with remapping them because it
 * remaps the ~60 utilities it actually renders, under its own scope. Giving
 * /app a dark mode is a real project, not a toggle, and it needs Dennis's
 * order. Nothing here is imported outside app/extension + the extension branch
 * of PhoneModeHeader.
 *
 * STORAGE
 * Per account, `cc:theme:<email>` — a shared browser profile is the normal case
 * for this product (it is a Chrome extension), and one person's choice of dark
 * should not follow the next person into the same popup. `cc:theme:last`
 * mirrors the most recent write and exists for ONE reason: the boot script has
 * to paint before the session is known, and reading the previous user's last
 * choice is a far better guess than defaulting to light and flashing.
 *
 * Every read and write is wrapped: localStorage throws outright in a profile
 * with site data blocked, and a theme preference is not worth a blank panel.
 */

export type CcTheme = 'system' | 'light' | 'dark';
export type CcResolvedTheme = 'light' | 'dark';

export const CC_THEMES: CcTheme[] = ['system', 'light', 'dark'];

const LAST_KEY = 'cc:theme:last';

function keyFor(email: string | null | undefined) {
  return email ? `cc:theme:${email.toLowerCase()}` : 'cc:theme:anon';
}

function isTheme(v: unknown): v is CcTheme {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function readStoredTheme(email: string | null | undefined): CcTheme {
  try {
    const v = window.localStorage.getItem(keyFor(email));
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(email: string | null | undefined, theme: CcTheme) {
  try {
    window.localStorage.setItem(keyFor(email), theme);
    window.localStorage.setItem(LAST_KEY, theme);
  } catch {
    /* site data blocked — the choice still applies for this session */
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(theme: CcTheme): CcResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/**
 * Stamp the resolved theme on <html>. The attribute is the ONLY gate the CSS
 * reads, so "System" resolves to an explicit light/dark here rather than
 * leaving the attribute off — that keeps one code path instead of two
 * (attribute set) and (attribute absent, media query decides), which is the
 * split that makes theme toggles disagree with themselves.
 */
export function applyTheme(resolved: CcResolvedTheme) {
  document.documentElement.setAttribute('data-cc-theme', resolved);
}

/**
 * The blocking boot script, inlined by app/extension/layout.tsx.
 *
 * It runs during HTML parse, before the first paint, and before React exists —
 * which is the whole point: the server renders .cc-ext without knowing the
 * user's preference, so anything that waits for hydration paints a white panel
 * first and corrects it a frame later. Kept to one expression and one try/catch
 * because it is on the critical path of every popup open.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${LAST_KEY}');if(t!=='light'&&t!=='dark'&&t!=='system')t='system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-cc-theme',d?'dark':'light');}catch(e){}})();`;
