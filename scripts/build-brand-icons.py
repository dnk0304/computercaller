#!/usr/bin/env python3
"""
build-brand-icons.py — every raster icon surface, derived mechanically from ONE master.

MASTER
    brand-icon-lockup/official/computercaller-official-icon-FINAL-2026-09-24.png
    sha256 201255f9053a73aa17b6ced1aff2b251b101e0f875173635593c1c1a8d32a8ed
    1024x1024, RGB, opaque, pure-white ground. Dennis's pick ("option B"), 2026-09-24.
    The file lives in the agent-memory brand ledger, not in this repo; MASTER below
    resolves it, and the sha256 is asserted before a single pixel is written. If the
    ledger is not present, pass --master <path>.

RULES THIS SCRIPT OBEYS (dispatch brief, LOCKED)
    Mechanical derivation only: resample (Lanczos), crop, mask, key the ground,
    composite on white. No redraw, no repaint, no inpainting, no colour change.
    Every output below comes out of this one script; re-running reproduces them
    byte-identical. There are no manual pixel edits anywhere in the pipeline.

THE TWO-AND-A-HALF CUTS, DEFINED ONCE
    FULL       the master as-is: an opaque white square. Used wherever the platform
               draws its own tile shape (iOS, Android legacy, the Play listing) or
               the surface is an opaque square.
    MARK       ring + monitor + phone + wordmark, ground keyed to transparency.
               The key is a flood fill inward from the canvas border ONLY, so the
               white *inside* the artwork — the monitor screen, the phone screen,
               the keylines inside the letters — stays opaque. The fringe is matted
               with a soft alpha ramp and unpremultiplied against white, which is
               what keeps a light halo off dark toolbars (see halo-check evidence).
    MARK-SMALL ring + devices only, for 16/32 px where the wordmark is illegible.
               Produced by masking MARK to (ring annulus u monitor u phone) and
               cropping to that bounding box. A mask and a crop are a mask and a
               crop — no pixel is invented. NOTE: "CALLER" overlaps the blue ring on
               the right and "COMPUTER" the green ring on the left in the master, so
               a few letter pixels survive on the ring band. At 16-32 px they read as
               ring texture. Removing them would mean repainting the ring underneath,
               which the rules forbid; this is recorded rather than fixed.

GEOMETRY MEASURED FROM THE MASTER (not assumed)
    ink bbox            x 53..939, y 73..947  (887 x 875)
    ink centre          (496, 510)
    ink circumradius    454 px — the green arrowhead at top-left, NOT the ring edge
    ring annulus        r in [345, 443]
    The brief's note that "the wordmark sits inside the ring" does not hold for this
    artwork: the wordmark overhangs the ring on both sides and is in fact what sets
    the bbox width. The Android safe-area fit therefore uses the measured
    circumradius (454), which bounds every ink pixel, instead of the ring radius.

USAGE
    python scripts/build-brand-icons.py [--master PATH] [--evidence DIR] [--check]
    --check writes nothing; it verifies the on-disk outputs match what would be built.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = Path(__file__).resolve().parent.parent

MASTER_SHA256 = "201255f9053a73aa17b6ced1aff2b251b101e0f875173635593c1c1a8d32a8ed"
MASTER_DEFAULT = Path(
    os.path.expanduser(
        r"~/.claude/agent-memory/ken/PROJECTS/computercaller/brand-icon-lockup"
        r"/official/computercaller-official-icon-FINAL-2026-09-24.png"
    )
)

# Ground-key thresholds, in "distance from pure white" units (0..255).
# Below KEY_LO a background pixel is fully transparent; above KEY_HI it is fully
# opaque; between, alpha ramps linearly. KEY_HI is generous enough to swallow the
# master's JPEG-ish fringe, which is what a hard binary key would leave as a halo.
KEY_LO, KEY_HI = 6.0, 44.0
# Flood-fill reachability: a pixel is "maybe background" while it is this close to
# white. Kept above KEY_HI so the ramp is computed over pixels the fill actually owns.
FILL_TOL = 60.0

SS = 4  # mask supersampling factor


# --------------------------------------------------------------------------- io


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def load_master(path: Path) -> Image.Image:
    if not path.exists():
        sys.exit(f"master not found: {path}\npass --master <path>")
    got = sha256_file(path)
    if got != MASTER_SHA256:
        sys.exit(f"master sha256 mismatch\n  expected {MASTER_SHA256}\n  got      {got}")
    im = Image.open(path).convert("RGB")
    if im.size != (1024, 1024):
        sys.exit(f"master must be 1024x1024, got {im.size}")
    return im


# ------------------------------------------------------------------- the cuts


def key_ground(master: Image.Image) -> Image.Image:
    """MARK: flood the white ground in from the border, matte the fringe, unpremultiply.

    Flood fill (4-connected) from every border pixel through anything within FILL_TOL
    of white. Interior whites — monitor screen, phone screen, letter keylines — are
    walled off by the artwork's own ink and are never reached, so they stay opaque.
    """
    rgb = np.asarray(master, dtype=np.float64)
    dist = (255.0 - rgb).max(axis=2)  # 0 = pure white
    h, w = dist.shape

    reachable = dist <= FILL_TOL
    # Connected components of the "maybe background" set; the ones touching the
    # canvas border are the ground. Interior whites form their own components and
    # are walled off by the artwork's ink, so they are never selected.
    lab, n = ndimage.label(reachable)
    border = np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])
    outside = np.unique(border[border > 0])
    bg = np.isin(lab, outside)

    alpha = np.full((h, w), 255.0)
    ramp = np.clip((dist - KEY_LO) / (KEY_HI - KEY_LO), 0.0, 1.0) * 255.0
    alpha[bg] = ramp[bg]

    # Unpremultiply the matted fringe against the white it was composited over, so a
    # dark ground shows the artwork's own colour instead of a pale rim.
    out = rgb.copy()
    part = bg & (alpha > 0) & (alpha < 255)
    a = (alpha[part] / 255.0)[:, None]
    out[part] = np.clip((rgb[part] - (1.0 - a) * 255.0) / a, 0.0, 255.0)

    rgba = np.dstack([out, alpha]).round().astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def ink_geometry(mark: Image.Image) -> dict:
    a = np.asarray(mark)[:, :, 3]
    ys, xs = np.nonzero(a > 12)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    r = float(np.hypot(xs - cx, ys - cy).max())
    return {"bbox": (x0, y0, x1 + 1, y1 + 1), "centre": (cx, cy), "circumradius": r}


def mark_small(mark: Image.Image, geo: dict) -> Image.Image:
    """Ring annulus + monitor + phone, cropped to its own bbox. Wordmark dropped.

    The annulus bounds are measured from the master's radial ink profile: ink density
    rises through r=345 and collapses past r=443, and the monitor and phone straddle
    the band on the vertical centre line. So the cut is subtractive: clear the ring's
    interior across the wordmark's rows only, and keep everything else as it is.
    """
    cx, cy = geo["centre"]
    h, w = mark.size[1], mark.size[0]
    Y, X = np.mgrid[0:h, 0:w]
    R = np.hypot(X - cx, Y - cy)

    # Drop only the ring's interior across the wordmark's rows. Measured: inside
    # r=335 the master has ink at rows 176-220 (monitor stand) and 790-842 (phone
    # body) and nothing else outside the wordmark, so a [280, 760] band takes the
    # wordmark and leaves both devices and the whole annulus untouched.
    drop = (R < 340.0) & (Y >= 280) & (Y <= 760)

    a = np.asarray(mark).copy()
    a[:, :, 3] = np.where(drop, 0, a[:, :, 3])
    out = Image.fromarray(a, "RGBA")
    bb = out.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox()
    return out.crop(bb)


# ------------------------------------------------------------------ resampling


def fit_into(img: Image.Image, size: int, *, radius_frac: float | None = None,
             geo: dict | None = None) -> Image.Image:
    """Centre `img` (already cropped to its ink) on a transparent size x size canvas.

    Default: contain the ink bbox edge-to-edge.
    radius_frac: instead, scale so the ink's circumradius equals radius_frac * size.
    Used for the Android foreground, where the safe area is a circle, not a box.
    """
    bb = img.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox()
    ink = img.crop(bb)
    if radius_frac is not None:
        g = ink_geometry(ink)
        scale = (radius_frac * size) / g["circumradius"]
    else:
        scale = size / max(ink.size)
    tw, th = max(1, round(ink.size[0] * scale)), max(1, round(ink.size[1] * scale))
    small = ink.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((size - tw) // 2, (size - th) // 2))
    return canvas


def fit_box(img: Image.Image, w: int, h: int) -> Image.Image:
    """Contain the ink in a w x h transparent canvas, aspect preserved, centred."""
    bb = img.getchannel("A").point(lambda v: 255 if v > 12 else 0).getbbox()
    ink = img.crop(bb)
    scale = min(w / ink.size[0], h / ink.size[1])
    tw, th = max(1, round(ink.size[0] * scale)), max(1, round(ink.size[1] * scale))
    small = ink.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((w - tw) // 2, (h - th) // 2))
    return canvas


def full(master: Image.Image, size: int) -> Image.Image:
    return master if size == 1024 else master.resize((size, size), Image.LANCZOS)


# ----------------------------------------------------------------------- masks


def _mask(size: int, fn) -> Image.Image:
    n = size * SS
    u = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    X, Y = np.meshgrid(u, u)
    m = fn(X, Y).astype(np.float64) * 255.0
    big = Image.fromarray(m.round().astype(np.uint8), "L")
    return big.resize((size, size), Image.LANCZOS)


def circle_mask(size: int) -> Image.Image:
    return _mask(size, lambda X, Y: np.hypot(X, Y) <= 1.0)


def squircle_mask(size: int, n: float = 5.0) -> Image.Image:
    return _mask(size, lambda X, Y: (np.abs(X) ** n + np.abs(Y) ** n) <= 1.0)


def rounded_rect_mask(size: int, radius_frac: float = 0.20) -> Image.Image:
    r = radius_frac * 2.0  # in the [-1,1] coordinate system

    def fn(X, Y):
        ax, ay = np.abs(X), np.abs(Y)
        dx, dy = np.maximum(ax - (1.0 - r), 0.0), np.maximum(ay - (1.0 - r), 0.0)
        return np.hypot(dx, dy) <= r

    return _mask(size, fn)


def apply_mask(img: Image.Image, mask: Image.Image) -> Image.Image:
    out = img.convert("RGBA")
    a = np.asarray(out).astype(np.float64)
    a[:, :, 3] *= np.asarray(mask).astype(np.float64) / 255.0
    return Image.fromarray(a.round().astype(np.uint8), "RGBA")


# --------------------------------------------------------------------- writing


class Writer:
    def __init__(self, check: bool) -> None:
        self.check = check
        self.rows: list[tuple[str, str, str, str]] = []
        self.failed: list[str] = []

    def png(self, rel: str, img: Image.Image, mode: str) -> None:
        path = REPO / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        img = img.convert(mode)
        from io import BytesIO

        buf = BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        if self.check:
            same = path.exists() and path.read_bytes() == data
            if not same:
                self.failed.append(rel)
        else:
            path.write_bytes(data)
        self.rows.append(
            (rel, f"{img.size[0]}x{img.size[1]}", mode, hashlib.sha256(data).hexdigest())
        )


# ------------------------------------------------------------------------ main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", type=Path, default=MASTER_DEFAULT)
    ap.add_argument("--evidence", type=Path, default=None)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    master = load_master(args.master)
    MARK = key_ground(master)
    geo = ink_geometry(MARK)
    SMALL = mark_small(MARK, geo)
    print(f"ink bbox={geo['bbox']} centre={geo['centre']} circumradius={geo['circumradius']:.1f}")
    print(f"MARK-SMALL crop={SMALL.size}")

    w = Writer(args.check)

    # ---- web -------------------------------------------------------------
    w.png("public/brand/computercaller-icon-transparent.png", fit_into(MARK, 512), "RGBA")
    w.png("public/brand/computercaller-icon-square-padded-1024.png", full(master, 1024), "RGB")
    w.png("app/icon.png", fit_into(SMALL, 256), "RGBA")
    w.png("app/apple-icon.png", full(master, 180), "RGB")
    # MARK_CUT = 'cc-mark' -> these three are what CcMark.tsx renders, and it renders
    # them at a HEIGHT of 18 px (extension header) to 28 px (/app header). That is
    # squarely rule 2's illegibility case, so these get MARK-SMALL: at 18 px the full
    # wordmark is an unreadable smudge sitting next to the real text wordmark, which
    # is noise, not brand. Proven by the gate's own harness shots
    # (p5a-c-app-header-unencrypted-1280.png, p5a-a-ext-menu-light-400.png).
    for name, (bw, bh) in (
        ("cc-mark", (131, 68)),
        ("cc-mark@2x", (262, 135)),
        ("cc-mark@3x", (393, 203)),
    ):
        w.png(f"public/brand/official/{name}.png", fit_box(SMALL, bw, bh), "RGBA")
    w.png("marketing/store/app-icon-512.png", full(master, 512), "RGB")

    # ---- extension -------------------------------------------------------
    w.png("chrome-extension/icon16.png", fit_into(SMALL, 16), "RGBA")
    w.png("chrome-extension/icon32.png", fit_into(SMALL, 32), "RGBA")
    for s in (48, 128):
        w.png(f"chrome-extension/icon{s}.png", apply_mask(full(master, s), rounded_rect_mask(s)), "RGBA")

    # ---- android ---------------------------------------------------------
    # Adaptive foreground: 108 dp canvas, artwork inside the 66 dp safe circle.
    # circumradius = 33/108 of the canvas edge bounds EVERY ink pixel.
    RES = "dnkdialer-android/app/src/main/res"
    for bucket, s in (("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324), ("xxxhdpi", 432)):
        w.png(f"{RES}/mipmap-{bucket}/ic_launcher_foreground.png",
              fit_into(MARK, s, radius_frac=33.0 / 108.0), "RGBA")
    for bucket, s in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        w.png(f"{RES}/mipmap-{bucket}/ic_launcher.png", apply_mask(full(master, s), squircle_mask(s)), "RGBA")
        w.png(f"{RES}/mipmap-{bucket}/ic_launcher_round.png", apply_mask(full(master, s), circle_mask(s)), "RGBA")

    # colors.xml: ic_launcher_background only.
    colors = REPO / RES / "values/colors.xml"
    if colors.exists():
        src = colors.read_text(encoding="utf-8")
        new = re.sub(
            r'(<color name="ic_launcher_background">)#[0-9A-Fa-f]{6,8}(</color>)',
            r"\1#FFFFFF\2",
            src,
        )
        if args.check:
            if new != src:
                w.failed.append(str(colors.relative_to(REPO)))
        elif new != src:
            colors.write_text(new, encoding="utf-8")

    # ---- evidence --------------------------------------------------------
    if args.evidence:
        ev = args.evidence
        ev.mkdir(parents=True, exist_ok=True)
        for ground, tag in (((0, 0, 0), "000"), ((26, 26, 26), "1a1a1a")):
            for size in (512, 32):
                sheet = Image.new("RGB", (size * 2 + 48, size + 32), ground)
                sheet.paste(fit_into(MARK, size), (16, 16), fit_into(MARK, size))
                sm = fit_into(SMALL, size)
                sheet.paste(sm, (size + 32, 16), sm)
                sheet.save(ev / f"halo-check-{tag}-{size}.png")
        # android mask sheet: fg over white bg, cropped to the 72 dp viewport
        cell = 432
        crop = round(cell * 72 / 108)
        off = (cell - crop) // 2
        bg = Image.new("RGBA", (cell, cell), (255, 255, 255, 255))
        fg = fit_into(MARK, cell, radius_frac=33.0 / 108.0)
        comp = Image.alpha_composite(bg, fg).crop((off, off, off + crop, off + crop))
        sheet = Image.new("RGB", (crop * 3 + 64, crop + 32), (90, 90, 96))
        for i, m in enumerate((circle_mask(crop), squircle_mask(crop), rounded_rect_mask(crop))):
            masked = apply_mask(comp, m)
            sheet.paste(masked, (16 + i * (crop + 16), 16), masked)
        sheet.save(ev / "android-mask-sheet.png")

    # ---- manifest --------------------------------------------------------
    lines = ["| path | px | mode | sha256 |", "| --- | --- | --- | --- |"]
    lines += [f"| `{p}` | {d} | {m} | `{h}` |" for p, d, m, h in w.rows]
    print("\n".join(lines))
    if args.check and w.failed:
        print("\nCHECK FAILED — differs from build:\n  " + "\n  ".join(w.failed))
        return 1
    if args.check:
        print("\nCHECK OK — every output reproduces byte-identical.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
