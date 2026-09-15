/**
 * The ComputerCaller wordmark, as geometry.
 *
 * WHY THIS FILE EXISTS
 * The only place the product's wordmark had ever been drawn was inside two
 * raster files — public/brand/computercaller-icon-square.png (742×595) and the
 * colour banner. Every surface that wanted "the logo with the name under it"
 * had to ship a PNG, so the extension (which cannot load computercaller.com
 * images under MV3's default CSP) simply showed the bare mark, and the web app
 * set "ComputerCaller" in whatever UI face the page happened to use. Three
 * surfaces, three wordmarks, one of them missing.
 *
 * WHAT WAS TRACED, AND FROM WHERE
 * public/brand/computercaller-icon-square.png, the Play-listing lockup. Its
 * wordmark measures, by ink bounding box: cap height 44px, total width 618px
 * (aspect 14.05), inter-letter gap ~6px (0.136 cap), word gap 22px (0.50 cap),
 * set in a geometric extra-bold sans, ALL CAPS, as TWO words — "COMPUTER" in
 * #0b2d5c and "CALLER" in #1d76b6. Both the case and the two-tone split are
 * reproduced here: it is the brand's own lockup, not a styling choice, and
 * quietly "fixing" it to a camel-case "ComputerCaller" would have made the
 * app disagree with the Play listing and the banner.
 *
 * HOW IT IS DRAWN
 * Stroked geometry, not filled outlines. A geometric extra-bold sans has a
 * near-uniform stem weight, so each glyph is a centreline path stroked at 26
 * units on a 100-unit cap height (0.26 cap — extra-bold). That keeps the whole
 * wordmark at ~1.6KB instead of the ~14KB a faithful outline trace of 14
 * glyphs would cost, and it stays crisp at the 6px cap height the 40px
 * extension header can afford. Terminals are cut flat (butt caps), which is
 * what the source does.
 *
 * COORDINATE SYSTEM
 * y=0 is the cap line, y=100 the baseline, x=0 the left sidebearing of the
 * first glyph. Advance = width + TRACKING, plus WORD_GAP once between the two
 * words. Nothing here has a unit; callers scale the viewBox.
 */

/** Stroke weight at cap height 100. 0.26 cap = extra-bold. */
export const STROKE = 26;
/** Cap height the glyph table is drawn against. */
export const CAP = 100;
/** Letter gap, measured from the source at 6/44 cap. */
const TRACKING = 13.6;
/** Extra space between "COMPUTER" and "CALLER", measured at 22/44 cap. */
const WORD_GAP = 36;

/** Ink colours sampled from the source PNG at (200,395) and (650,395). */
export const WORDMARK_COLORS = {
  light: { first: '#0b2d5c', second: '#1d76b6' },
  /**
   * Dark-surface cut. The navy half cannot survive on a #18181b card (1.4:1),
   * so it lifts to the same near-white the extension already uses for ink, and
   * the blue half lifts just enough to keep the two-tone split readable while
   * staying recognisably the brand blue. Both clear 4.5:1 on --cc-card.
   */
  dark: { first: '#fafafa', second: '#5fb0e8' },
} as const;

/**
 * Centreline path + advance width for each glyph, at CAP=100.
 * Widths are the INK width; the stroke is centred, so a glyph's drawing spans
 * x = 0 … width with the centreline inset STROKE/2 from each edge.
 */
const GLYPHS: Record<string, { w: number; d: string }> = {
  C: { w: 88, d: 'M63.1 19.7A31 38.5 0 1 0 63.1 80.3' },
  O: { w: 92, d: 'M13 50a33 38.5 0 1 0 66 0a33 38.5 0 1 0-66 0' },
  M: { w: 112, d: 'M13 100V0L56 66L99 0V100' },
  P: { w: 80, d: 'M13 100V13H41A26 21 0 1 1 41 55H13' },
  U: { w: 90, d: 'M13 0V58A32 30.5 0 0 0 77 58V0' },
  T: { w: 84, d: 'M42 100V13M6 13H78' },
  E: { w: 78, d: 'M65 13H13V87H65M13 50H58' },
  R: { w: 84, d: 'M13 100V13H41A28 21 0 1 1 41 55H13M45 55L71 100' },
  A: { w: 94, d: 'M13 100L44 6H50L81 100M29 70H65' },
  L: { w: 74, d: 'M13 0V87H61' },
};

const FIRST = 'COMPUTER';
const SECOND = 'CALLER';

function layout(word: string, startX: number) {
  const parts: string[] = [];
  let x = startX;
  for (const ch of word) {
    const g = GLYPHS[ch];
    parts.push(translate(g.d, x));
    x += g.w + TRACKING;
  }
  return { d: parts.join(''), end: x - TRACKING };
}

/** Which argument slots of each command are absolute x coordinates. */
const X_SLOTS: Record<string, { arity: number; xs: number[] }> = {
  M: { arity: 2, xs: [0] },
  L: { arity: 2, xs: [0] },
  H: { arity: 1, xs: [0] },
  V: { arity: 1, xs: [] },
  A: { arity: 7, xs: [5] }, // rx ry rot large-arc sweep X y — slot 5, not 0.
  m: { arity: 2, xs: [] },
  l: { arity: 2, xs: [] },
  h: { arity: 1, xs: [] },
  v: { arity: 1, xs: [] },
  a: { arity: 7, xs: [] },
};

/**
 * Shift a path in x so each word can be ONE <path> element instead of a <g>
 * per glyph. Written as a real tokeniser rather than a regex because the arc
 * command's x coordinate is its SIXTH argument — a naive "number after the
 * letter" substitution would translate the ellipse radii of every C, O, P, R
 * and U instead, which distorts rather than moves them.
 */
function translate(d: string, dx: number): string {
  if (dx === 0) return d;
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const out: string[] = [];
  let cmd = '';
  let i = 0;
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i];
      out.push(cmd);
      i += 1;
      continue;
    }
    const spec = X_SLOTS[cmd];
    if (!spec) throw new Error(`wordmark: unhandled path command "${cmd}"`);
    for (let slot = 0; slot < spec.arity; slot += 1) {
      const n = parseFloat(tokens[i + slot]);
      out.push(String(spec.xs.includes(slot) ? round(n + dx) : n));
    }
    i += spec.arity;
  }
  // Join with spaces only where two numbers meet, so "-66" keeps its sign and
  // "A31 37" does not become "A3137".
  return out.reduce(
    (acc, t) => (acc === '' || /[A-Za-z]/.test(t) || /[A-Za-z]$/.test(acc) ? acc + t : `${acc} ${t}`),
    '',
  );
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

const first = layout(FIRST, 0);
const second = layout(SECOND, first.end + TRACKING + WORD_GAP);

/** Path data for "COMPUTER" (the navy half). */
export const WORDMARK_D_FIRST = first.d;
/** Path data for "CALLER" (the blue half). */
export const WORDMARK_D_SECOND = second.d;
/** viewBox width at CAP=100. Height is CAP. */
export const WORDMARK_W = round(second.end);
/** width ÷ cap height. The source measures 14.05; stay within ~2% of it. */
export const WORDMARK_ASPECT = round(WORDMARK_W / CAP);
