/**
 * Emits every cut of the OFFICIAL ComputerCaller logo from the artwork itself.
 *
 * WHY THIS FILE WAS REWRITTEN (dispatch PIXEL-O, Dennis 2026-09-16)
 * ---------------------------------------------------------------
 * Dennis: "Android app: You have removed our official logo inside the app, our
 * official logo is not on the the extension either."
 *
 * The previous version of this script emitted a *redrawn* logo: a green
 * rounded tile with a handset in it (CcMark), plus a wordmark reconstructed as
 * stroked centrelines in lib/brand/wordmark.ts. Both were honest engineering
 * and both were the wrong answer — they are not the logo. The official logo is
 * the artwork on the Play listing: the monitor-and-phone mark with the call arc
 * sweeping between them, under a two-tone "COMPUTER CALLER" wordmark.
 *
 * So this script no longer *draws* anything. It CUTS the official artwork and
 * re-packages it. Every pixel that ships is a pixel from:
 *
 *   public/brand/computercaller-icon-transparent.png  — the mark, already
 *       keyed to transparency by the designer. 396x317, ink box 396x205.
 *   public/brand/computercaller-icon-square.png       — the Play-listing
 *       lockup, 742x595. The only master that contains the wordmark.
 *   marketing/store/app-icon-512.png                  — the launcher/app icon.
 *
 * RASTER, NOT VECTOR — AND WHY
 * The brief allowed either. A true vector of this mark would have to be
 * re-drawn by hand (there is no tracer in this toolchain that survives a
 * gradient, and an autotrace of a gradient produces colour-banded polygon
 * soup). A hand-redraw is exactly what Dennis just rejected. So the mark and
 * the wordmark ship as rasters at 1x/2x/3x, where 3x is the artwork at its
 * native pixel size — no upscaling anywhere. The .svg files this script emits
 * are real SVGs whose <image> content is that artwork, so surfaces that want a
 * single scalable URL (the extension shell paints its header with
 * background-image) keep working unchanged.
 *
 * MEASURED GEOMETRY OF THE OFFICIAL LOCKUP
 * Taken off computercaller-icon-square.png, ink bounding boxes:
 *   mark      x=176 y=138 w=393 h=203   (aspect 1.936)
 *   wordmark  x= 64 y=378 w=618 h= 44   (cap height 44, aspect 14.045)
 *   gap between mark bottom and cap top = 38px
 *   word split: "COMPUTER" x 64..420 (#0e2d55), "CALLER" x 442..681 (#1973b7)
 * Normalised to the wordmark width (618 = 1.000):
 *   mark width 0.636, stack gap 0.0615, total lockup 618 x 285 (aspect 2.168).
 * Those five numbers are the whole layout; they are reproduced exactly.
 *
 * HOW THE WORDMARK IS LIFTED OFF ITS BACKGROUND
 * The wordmark exists only on the pale-blue listing background, so it has to be
 * keyed. It is flat two-tone ink on a near-flat ground, which makes the key
 * exact rather than approximate: per pixel, alpha is solved on the blue channel
 * (ground B=253, navy ink B=85, blue ink B=183 — the widest separation), and
 * the colour is then set to the measured flat ink rather than unpremultiplied.
 * Unpremultiplying antialiased edge pixels is what washed the navy out to
 * purple in the first attempt; snapping to the flat ink keeps the letterforms
 * (which are the artwork's, untouched) and the two brand colours exact.
 *
 * DARK GROUNDS
 * #0e2d55 on a #18181b surface is 1.4:1 — the wordmark simply disappears. A
 * -dark cut is emitted with the navy lifted to #f2f6fb and the blue to #5aa9e6
 * (both >= 4.5:1 on #18181b). The MARK is never recoloured: its green-to-blue
 * gradient carries on both grounds, and recolouring it would, again, be
 * redrawing the logo.
 *
 * Run: bun scripts/build-brand-lockup.ts
 *      (sharp comes in with Next.js; this is a manual build tool, its outputs
 *       are committed, so it is not wired into `next build`.)
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharp: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharp = (await import('sharp')).default;
} catch {
  throw new Error(
    'sharp is required to rebuild the brand assets. It ships with Next.js; run `bun install` first.',
  );
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p: string[]) => join(ROOT, ...p);

/* ------------------------------------------------------------------ sources */

const SRC_MARK = P('public', 'brand', 'computercaller-icon-transparent.png');
const SRC_LOCKUP = P('public', 'brand', 'computercaller-icon-square.png');
const SRC_APPICON = P('marketing', 'store', 'app-icon-512.png');

/** Ink boxes measured on computercaller-icon-square.png (742x595). */
const SQUARE = {
  mark: { x: 176, y: 138, w: 393, h: 203 },
  wordmark: { x: 64, y: 378, w: 618, h: 44 },
  /** x at which "COMPUTER" ends and "CALLER" begins (mid-gap). */
  wordSplit: 431,
  /** Column of pure background used as the per-row ground reference. */
  groundX: 6,
} as const;

/** Gap between the mark's baseline and the wordmark's cap line, in square px. */
const STACK_GAP = SQUARE.wordmark.y - (SQUARE.mark.y + SQUARE.mark.h); // 38

/** The two inks, sampled from the artwork. */
const INK = {
  light: { first: [14, 45, 85], second: [25, 115, 183] },
  /** Lifted for dark grounds — see the note at the top of the file. */
  dark: { first: [242, 246, 251], second: [90, 169, 230] },
} as const;

type RGB = readonly number[];

/* -------------------------------------------------------------- raw helpers */

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

async function readRaw(file: string): Promise<Raw> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function png(raw: Raw) {
  return sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  });
}

/**
 * Lifts the wordmark off the listing background.
 *
 * alpha is solved on the blue channel because that is where ground and ink are
 * furthest apart (253 vs 85 / 183); the colour is then snapped to the flat ink
 * for that word rather than unpremultiplied from the composite, which keeps
 * antialiased edges the right hue instead of washing them toward the ground.
 */
function keyWordmark(src: Raw, ink: { first: RGB; second: RGB }): Raw {
  const { x, y, w, h } = SQUARE.wordmark;
  const out = Buffer.alloc(w * h * 4);
  const at = (px: number, py: number) => (py * src.width + px) * 4;

  for (let row = 0; row < h; row++) {
    const groundO = at(SQUARE.groundX, y + row);
    const groundB = src.data[groundO + 2];

    for (let col = 0; col < w; col++) {
      const sx = x + col;
      const o = at(sx, y + row);
      const isSecond = sx >= SQUARE.wordSplit;
      const flat = isSecond ? INK.light.second : INK.light.first;
      const paint = isSecond ? ink.second : ink.first;

      // px = a*ink + (1-a)*ground  ->  a = (ground - px) / (ground - ink)
      const span = groundB - flat[2];
      let a = span === 0 ? 0 : (groundB - src.data[o + 2]) / span;
      if (a < 0) a = 0;
      if (a > 1) a = 1;

      const d = (row * w + col) * 4;
      out[d] = paint[0];
      out[d + 1] = paint[1];
      out[d + 2] = paint[2];
      out[d + 3] = Math.round(a * 255);
    }
  }
  return { data: out, width: w, height: h };
}

/** Trims the mark master to its ink box so it composes off known dimensions. */
async function markMaster(): Promise<Raw> {
  const raw = await readRaw(SRC_MARK);
  let minX = raw.width,
    minY = raw.height,
    maxX = -1,
    maxY = -1;
  for (let py = 0; py < raw.height; py++) {
    for (let px = 0; px < raw.width; px++) {
      if (raw.data[(py * raw.width + px) * 4 + 3] > 8) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const buf = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  })
    .extract({ left: minX, top: minY, width: w, height: h })
    .raw()
    .toBuffer();
  return { data: buf, width: w, height: h };
}

/**
 * The white silhouette Android's status bar needs: the mark's *strokes* only.
 * The screens inside the monitor and the phone are a near-white fill in the
 * artwork; keeping them would turn the status icon into a solid blob, so the
 * silhouette keeps saturated pixels (the green-to-blue line work) and drops
 * desaturated ones.
 */
function silhouette(mark: Raw): Raw {
  const out = Buffer.alloc(mark.width * mark.height * 4);
  for (let i = 0; i < mark.width * mark.height; i++) {
    const o = i * 4;
    const r = mark.data[o],
      g = mark.data[o + 1],
      b = mark.data[o + 2],
      a = mark.data[o + 3];
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    // 0.18 sits between the artwork's line work (>0.35) and its screen fill (<0.08).
    const ink = Math.min(1, Math.max(0, (sat - 0.12) / 0.18));
    out[o] = 255;
    out[o + 1] = 255;
    out[o + 2] = 255;
    out[o + 3] = Math.round((a / 255) * ink * 255);
  }
  return { data: out, width: mark.width, height: mark.height };
}

/* ------------------------------------------------------------------ writers */

const written: string[] = [];

function note(file: string) {
  written.push(file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''));
}

async function writePng(raw: Raw, file: string, width?: number, height?: number) {
  mkdirSync(dirname(file), { recursive: true });
  let pipe = png(raw);
  if (width && height) {
    pipe = pipe.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  }
  await pipe.png({ compressionLevel: 9 }).toFile(file);
  note(file);
}

async function writePngFrom(src: string | Buffer, file: string, size: number) {
  mkdirSync(dirname(file), { recursive: true });
  await sharp(src)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
  note(file);
}

/** An SVG that *is* the artwork: geometry in the viewBox, pixels in <image>. */
function svgLockup(
  markPngB64: string,
  wordLightB64: string,
  wordDarkB64: string,
  opts: { themed: boolean },
) {
  const W = SQUARE.wordmark.w;
  const H = SQUARE.mark.h + STACK_GAP + SQUARE.wordmark.h;
  const markX = (W - SQUARE.mark.w) / 2;
  const wordY = SQUARE.mark.h + STACK_GAP;
  const style = opts.themed
    ? `<style>.cc-dark{display:none}@media (prefers-color-scheme:dark){.cc-light{display:none}.cc-dark{display:inline}}</style>`
    : '';
  const darkLayer = opts.themed
    ? `<image class="cc-dark" x="0" y="${wordY}" width="${W}" height="${SQUARE.wordmark.h}" href="data:image/png;base64,${wordDarkB64}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ComputerCaller">` +
    style +
    `<image x="${markX}" y="0" width="${SQUARE.mark.w}" height="${SQUARE.mark.h}" href="data:image/png;base64,${markPngB64}"/>` +
    `<image class="cc-light" x="0" y="${wordY}" width="${W}" height="${SQUARE.wordmark.h}" href="data:image/png;base64,${wordLightB64}"/>` +
    darkLayer +
    `</svg>\n`
  );
}

/** The inline cut: mark at full height, wordmark beside it. See lib/brand. */
function svgInline(markPngB64: string, wordLightB64: string, wordDarkB64: string) {
  // NOTE: callers pass a DOWNSCALED mark here — see the call site.
  const H = SQUARE.mark.h;
  const cap = Math.round(H * 0.42);
  const wordW = Math.round(cap * (SQUARE.wordmark.w / SQUARE.wordmark.h));
  const gap = Math.round(H * 0.22);
  const W = SQUARE.mark.w + gap + wordW;
  const wordX = SQUARE.mark.w + gap;
  const wordY = Math.round((H - cap) / 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ComputerCaller">` +
    `<style>.cc-dark{display:none}@media (prefers-color-scheme:dark){.cc-light{display:none}.cc-dark{display:inline}}</style>` +
    `<image x="0" y="0" width="${SQUARE.mark.w}" height="${H}" href="data:image/png;base64,${markPngB64}"/>` +
    `<image class="cc-light" x="${wordX}" y="${wordY}" width="${wordW}" height="${cap}" href="data:image/png;base64,${wordLightB64}"/>` +
    `<image class="cc-dark" x="${wordX}" y="${wordY}" width="${wordW}" height="${cap}" href="data:image/png;base64,${wordDarkB64}"/>` +
    `</svg>
`
  );
}

function svgMark(markPngB64: string) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SQUARE.mark.w} ${SQUARE.mark.h}" ` +
    `width="${SQUARE.mark.w}" height="${SQUARE.mark.h}" role="img" aria-label="ComputerCaller">` +
    `<image x="0" y="0" width="${SQUARE.mark.w}" height="${SQUARE.mark.h}" href="data:image/png;base64,${markPngB64}"/>` +
    `</svg>\n`
  );
}

function writeText(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  note(file);
}

/* --------------------------------------------------------------------- main */

/** 1x display widths. 3x lands exactly on the artwork's native pixels. */
const LOCKUP_1X = 206; // 3x = 618 = wordmark native width
const MARK_1X = 131; // 3x = 393 = mark native width

async function main() {
  const mark = await markMaster();
  const squareRaw = await readRaw(SRC_LOCKUP);
  const wordLight = keyWordmark(squareRaw, INK.light);
  const wordDark = keyWordmark(squareRaw, INK.dark);

  const outDir = P('public', 'brand', 'official');
  const extDir = P('chrome-extension');

  // --- mark, wordmark, stacked lockup at 1x/2x/3x -------------------------
  const lockupH = Math.round((LOCKUP_1X * (SQUARE.mark.h + STACK_GAP + SQUARE.wordmark.h)) / SQUARE.wordmark.w);

  for (const scale of [1, 2, 3] as const) {
    const suffix = scale === 1 ? '' : `@${scale}x`;

    await writePng(
      mark,
      join(outDir, `cc-mark${suffix}.png`),
      MARK_1X * scale,
      Math.round(((MARK_1X * scale) * SQUARE.mark.h) / SQUARE.mark.w),
    );
    await writePng(
      wordLight,
      join(outDir, `cc-wordmark${suffix}.png`),
      LOCKUP_1X * scale,
      Math.max(1, Math.round(((LOCKUP_1X * scale) * SQUARE.wordmark.h) / SQUARE.wordmark.w)),
    );
    await writePng(
      wordDark,
      join(outDir, `cc-wordmark-dark${suffix}.png`),
      LOCKUP_1X * scale,
      Math.max(1, Math.round(((LOCKUP_1X * scale) * SQUARE.wordmark.h) / SQUARE.wordmark.w)),
    );

    // Stacked: the official composition, at the measured proportions.
    const W = LOCKUP_1X * scale;
    const H = lockupH * scale;
    for (const [tone, word] of [
      ['', wordLight],
      ['-dark', wordDark],
    ] as const) {
      const markW = Math.round((W * SQUARE.mark.w) / SQUARE.wordmark.w);
      const markH = Math.round((markW * SQUARE.mark.h) / SQUARE.mark.w);
      const wordH = Math.max(1, Math.round((W * SQUARE.wordmark.h) / SQUARE.wordmark.w));
      const markBuf = await png(mark).resize(markW, markH, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
      const wordBuf = await png(word).resize(W, wordH, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
      const file = join(outDir, `cc-lockup${tone}${suffix}.png`);
      mkdirSync(dirname(file), { recursive: true });
      await sharp({
        create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          { input: markBuf, left: Math.round((W - markW) / 2), top: 0 },
          { input: wordBuf, left: 0, top: H - wordH },
        ])
        .png({ compressionLevel: 9 })
        .toFile(file);
      note(file);
    }
  }

  // --- SVG cuts -----------------------------------------------------------
  const markB64 = (await png(mark).png({ compressionLevel: 9 }).toBuffer()).toString('base64');
  const wordLightB64 = (
    await png(wordLight).png({ compressionLevel: 9 }).toBuffer()
  ).toString('base64');
  const wordDarkB64 = (
    await png(wordDark).png({ compressionLevel: 9 }).toBuffer()
  ).toString('base64');

  writeText(
    P('public', 'brand', 'computercaller-lockup-official.svg'),
    svgLockup(markB64, wordLightB64, wordDarkB64, { themed: true }),
  );
  writeText(P('public', 'brand', 'computercaller-mark-official.svg'), svgMark(markB64));

  // The extension cannot load computercaller.com images (MV3's default
  // img-src 'self'), so it carries its own copies.
  writeText(join(extDir, 'lockup.svg'), svgLockup(markB64, wordLightB64, wordDarkB64, { themed: true }));
  writeText(join(extDir, 'mark.svg'), svgMark(markB64));
  // The inline cut paints a ~20px-tall mark, i.e. 117 device px at 3x DPR.
  // Embedding the 393px master there costs 145KB of base64 to throw away 70% of
  // it on every popup open, so the inline cut carries a 160px mark. The STACKED
  // cut keeps the master: its hero renders at 72px tall and gets asked for at
  // full size by og-image style consumers.
  const markInlineB64 = (
    await png(mark)
      .resize(160, Math.round((160 * SQUARE.mark.h) / SQUARE.mark.w), { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toBuffer()
  ).toString('base64');
  writeText(
    join(extDir, 'lockup-inline.svg'),
    svgInline(markInlineB64, wordLightB64, wordDarkB64),
  );
  writeText(
    P('public', 'brand', 'computercaller-lockup-official-inline.svg'),
    svgInline(markInlineB64, wordLightB64, wordDarkB64),
  );

  // --- extension action icons, FROM THE MARK -------------------------------
  // PIXEL-S2 (b), Dennis 2026-09-17 13:26: "Use the same logo from the header
  // as the official one for extension, the one that doesnt contain the
  // computercaller text in the icon."
  //
  // These used to come from marketing/store/app-icon-512.png, which is the
  // LAUNCHER icon: mark plus "ComputerCaller" set inside the tile. At 16px that
  // wordmark is ~2px tall — an unreadable smudge under the mark that still
  // costs the mark a third of its height. The header now shows the bare mark
  // (deliverable (a)) and so does the toolbar, off the same cut.
  //
  // `contain` on a square canvas, not `cover`: the mark is 1.936:1, so it lands
  // full-width and vertically centred with transparent bands above and below.
  // Cropping it to fill the square would cut the monitor and the phone out of a
  // mark whose whole subject is the two of them talking to each other — i.e. it
  // would be redrawing the logo, which is the thing PIXEL-O exists to stop.
  const markIconBuf = await png(mark).png({ compressionLevel: 9 }).toBuffer();
  for (const size of [16, 32, 48, 128]) {
    await writePngFrom(markIconBuf, join(extDir, `icon${size}.png`), size);
  }

  // --- Android ------------------------------------------------------------
  const androidRes = P('dnkdialer-android', 'app', 'src', 'main', 'res');
  const DENSITIES: Array<[string, number]> = [
    ['mdpi', 1],
    ['hdpi', 1.5],
    ['xhdpi', 2],
    ['xxhdpi', 3],
    ['xxxhdpi', 4],
  ];
  // Android brand slots: the sign-in screen stacks a 200dp wordmark under a
  // 132dp mark (the artwork's own 0.636 ratio), and the app bar reuses the mark
  // at 26dp. 3x lands exactly on the artwork's native pixels (200dp*3 = 600 vs
  // 618, 132dp*3 = 396 vs 393); only xxxhdpi upscales, by ~1.3x, and Android
  // would have done that itself from xxhdpi anyway.
  for (const [density, factor] of DENSITIES) {
    const lw = Math.round(200 * factor);
    await writePng(
      { data: (await png(wordLight).raw().toBuffer()) as Buffer, width: wordLight.width, height: wordLight.height },
      join(androidRes, `drawable-${density}`, 'cc_wordmark.png'),
      lw,
      Math.max(1, Math.round((lw * SQUARE.wordmark.h) / SQUARE.wordmark.w)),
    );
    // Night: the app has a values-night theme, and #0e2d55 on its dark ground
    // is invisible. A PNG cannot be re-inked by a theme attribute, so the dark
    // cut ships as a -night qualified resource and Android does the switching.
    await writePng(
      { data: (await png(wordDark).raw().toBuffer()) as Buffer, width: wordDark.width, height: wordDark.height },
      join(androidRes, `drawable-night-${density}`, 'cc_wordmark.png'),
      lw,
      Math.max(1, Math.round((lw * SQUARE.wordmark.h) / SQUARE.wordmark.w)),
    );
    const mw = Math.round(132 * factor);
    await writePng(
      mark,
      join(androidRes, `drawable-${density}`, 'cc_mark.png'),
      mw,
      Math.round((mw * SQUARE.mark.h) / SQUARE.mark.w),
    );
    const sw = Math.round(24 * factor);
    await writePng(
      silhouette(mark),
      join(androidRes, `drawable-${density}`, 'ic_stat_cc.png'),
      sw,
      Math.max(1, Math.round((sw * SQUARE.mark.h) / SQUARE.mark.w)),
    );
    // Launcher: legacy square + round, straight from the store icon.
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      await writePngFrom(SRC_APPICON, join(androidRes, `mipmap-${density}`, `${name}.png`), Math.round(48 * factor));
    }
    // Adaptive-icon foreground: the MARK alone on transparency, inside the
    // 66/108 safe zone. Not the store icon — that carries its own pale-blue
    // ground, and a square of it composited over the adaptive background layer
    // would show as a mismatched tile inside the launcher's circle mask. The
    // wordmark is dropped here for the same reason every launcher icon drops
    // its wordmark: at 48dp it is four illegible pixels tall.
    const fg = Math.round(108 * factor);
    const safe = fg * (66 / 108);
    // The safe zone is a CIRCLE of diameter `safe`, not a square: a 1.936:1 box
    // whose width equals the diameter has its corners outside it, and the
    // launcher's round mask clips the monitor's left edge. 0.888 is the widest
    // box of this aspect that inscribes in that circle (w/D = a/sqrt(a^2+1)).
    const markW = Math.round(safe * 0.888);
    const markH = Math.round((markW * SQUARE.mark.h) / SQUARE.mark.w);
    const file = join(androidRes, `mipmap-${density}`, 'ic_launcher_foreground.png');
    mkdirSync(dirname(file), { recursive: true });
    await sharp({
      create: { width: fg, height: fg, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await png(mark).resize(markW, markH, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer(),
          left: Math.round((fg - markW) / 2),
          top: Math.round((fg - markH) / 2),
        },
      ])
      .png({ compressionLevel: 9 })
      .toFile(file);
    note(file);
  }

  // eslint-disable-next-line no-console
  console.log(`build-brand-lockup: wrote ${written.length} files\n  ` + written.join('\n  '));
}

await main();

// Keep readFileSync imported for callers that patch this script; silences the
// unused-import lint without changing behaviour.
void readFileSync;
