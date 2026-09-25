/**
 * Fallback art for an app whose launcher icon has not reached this browser
 * (ALERT-ICONS, 2026-09-25) — the normal case until the phone's vc69 icon fix
 * ships, so it is designed as a first-class state, not a placeholder.
 *
 *   1. Four messengers have a brand SVG already in public/messenger-icons.
 *   2. Everything else gets a letter tile: the app name's first letter, white,
 *      on a colour picked by hashing the PACKAGE name, so one app keeps one
 *      colour across renames, locales and reloads.
 *
 * Pure: no React, no DOM. The component is components/AppIcon.tsx.
 */

/** Package -> an SVG that already ships in public/. No new brand assets. */
const MESSENGER_ICONS: Readonly<Record<string, string>> = {
  'com.whatsapp': '/messenger-icons/whatsapp.svg',
  'org.telegram.messenger': '/messenger-icons/telegram.svg',
  'com.viber.voip': '/messenger-icons/viber.svg',
  'com.discord': '/messenger-icons/discord.svg',
};

export function messengerIconFor(packageName: string): string | undefined {
  return MESSENGER_ICONS[packageName];
}

/**
 * Tile fills. Each carries WHITE text at >= 4.5:1 (asserted in
 * tests/notif-icon-store.test.ts), and the letter is on the tile rather than
 * on the panel, so the same list holds in light and dark. Deep, saturated
 * mid-tones: distinct from each other at 20 px, and none of them the brand
 * green or the unread dot's blue, so a tile never reads as a status colour.
 */
export const TILE_FILLS: readonly string[] = [
  '#0369a1', // sky       5.93:1
  '#0f766e', // teal      5.47:1
  '#b91c1c', // red       6.47:1
  '#7e22ce', // purple    6.98:1
  '#c2410c', // orange    5.18:1
  '#be185d', // pink      6.04:1
  '#4d7c0f', // olive     4.99:1
  '#4338ca', // indigo    7.90:1
  '#a16207', // amber     4.92:1
  '#475569', // slate     7.58:1
];

/** FNV-1a, 32-bit. Stable across engines, which Math.random-free hashing needs. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tileFill(packageName: string): string {
  return TILE_FILLS[hash(packageName || '?') % TILE_FILLS.length];
}

/**
 * The first letter or digit of the app name (falling back to the package's
 * last segment), upper-cased. Skips leading punctuation and emoji so "#design"
 * and "(Beta) Foo" still get a letter. "?" only when there is nothing at all.
 */
export function tileLetter(appName: string, packageName = ''): string {
  const tail = packageName.split('.').pop() ?? '';
  for (const source of [appName, tail]) {
    const m = /[\p{L}\p{N}]/u.exec(source || '');
    if (m) return m[0].toLocaleUpperCase();
  }
  return '?';
}
