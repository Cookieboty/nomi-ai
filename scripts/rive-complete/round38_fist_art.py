#!/usr/bin/env python3
"""ROUND38 art: dedicated closed-fist textures hand-{l,r}-fist.png, drawn procedurally (deterministic, no RNG) in the
style of the R9/R10 hand crops: 1 px warm-brown outline (151,81,66), skin base (252,218,204), highlight (254,233,222),
soft shadow (236,162,135), crease lines (215,123,104) - all sampled from hand-l-palm.png.
Frame = the hand crop frame (l 59x93, r 59x90, texel 0.8464 rig units) so it sits exactly on the palm at bind pose.
Layout (screen-left hand, i.e. arm-l; arm-r is the exact horizontal mirror): back of hand from the cuff down, fist bulb,
four curled middle phalanges as rounded bands with creases, knuckle row = scalloped bottom contour (index..little),
thumb wraps diagonally over the index/middle bands, nail at the tip.  Supersampled 8x, box-downsampled."""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 8
LINE = (151, 81, 66); BASE = (252, 218, 204); HI = (254, 233, 222); SHD = (236, 162, 135); CREASE = (205, 118, 98)
NAIL = (250, 206, 196)


def _mask(W, H, fn):
    m = Image.new("L", (W * SS, H * SS), 0)
    fn(ImageDraw.Draw(m), lambda *p: [v * SS for v in p])
    return np.asarray(m, dtype=np.float32) / 255.0


def _erode(m, px):
    im = Image.fromarray((m * 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.MinFilter(2 * int(px * SS) + 1)), dtype=np.float32) / 255.0


def _blur(m, r):
    im = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(r * SS)), dtype=np.float32) / 255.0


KN = [(14.0, 63.0), (25.0, 65.5), (36.0, 64.5), (46.0, 61.0)]      # knuckle (PIP) bumps index..little (left hand)


def draw(W, H):
    def body(d, s):
        d.polygon(s(9, 0, 49, 0, 53, 30, 54, 46, 52, 58, 6, 58, 4, 40, 6, 18), fill=255)
        for (x, y), r in zip(KN, (7.2, 7.4, 7.0, 6.2)):
            d.ellipse(s(x - r, y - r - 8, x + r, y + r), fill=255)
    def bands(d, s, i):
        x, y = KN[i]; w = (5.2, 5.4, 5.1, 4.5)[i]
        d.rounded_rectangle(s(x - w, 50, x + w, y + 5.5), radius=w * SS, fill=255)
    def thumb(d, s):
        d.line(s(7, 30, 11, 41, 19, 50, 29, 56), fill=255, width=int(12.5 * SS), joint="curve")
        d.ellipse(s(1.5, 18, 15, 38), fill=255); d.ellipse(s(23, 49.5, 35.5, 62), fill=255)
    def nail(d, s):
        d.ellipse(s(27.5, 52.5, 33.8, 59.0), fill=255)
    B = _mask(W, H, body); T = _mask(W, H, thumb); N = _mask(W, H, nail)
    sil = np.maximum(B, T)
    yy, xx = np.mgrid[0:H * SS, 0:W * SS].astype(np.float32) / SS
    # skin shading: light from upper-left, shadow on the inner (right) side and under the thumb
    t = np.clip((xx - 14) / 40.0, 0, 1) * 0.55 + np.clip((yy - 40) / 40.0, 0, 1) * 0.25
    col = np.zeros((H * SS, W * SS, 3), np.float32)
    for c in range(3):
        col[..., c] = BASE[c] * (1 - t) + SHD[c] * t
    hi = _blur(_mask(W, H, lambda d, s: d.ellipse(s(12, 6, 26, 40), fill=255)), 3.0) * 0.7
    for c in range(3):
        col[..., c] = col[..., c] * (1 - hi) + HI[c] * hi
    # curled finger bands: each band lighter centre, crease line between bands, darker fold at the top (palm crease)
    for i in range(4):
        bm = _mask(W, H, lambda d, s, i=i: bands(d, s, i))
        inner = _blur(_erode(bm, 1.2), 1.2)
        for c in range(3):
            col[..., c] = col[..., c] * (1 - 0.45 * inner) + HI[c] * 0.45 * inner
        edge = np.clip(bm - _erode(bm, 0.9), 0, 1) * (yy > 48)
        for c in range(3):
            col[..., c] = col[..., c] * (1 - 0.85 * edge) + CREASE[c] * 0.85 * edge
    tuck = _blur(_mask(W, H, lambda d, s: d.rectangle(s(6, 46, 54, 52), fill=255)), 1.5) * B
    for c in range(3):
        col[..., c] = col[..., c] * (1 - 0.5 * tuck) + SHD[c] * 0.5 * tuck
    fold = _mask(W, H, lambda d, s: d.arc(s(6, 40, 54, 54), 20, 160, fill=255, width=int(0.9 * SS)))
    for c in range(3):
        col[..., c] = col[..., c] * (1 - 0.6 * fold) + CREASE[c] * 0.6 * fold
    # thumb over the fingers: contact shadow, own shading, outline, nail
    sh = _blur(T, 1.6) * (1 - T)
    for c in range(3):
        col[..., c] = col[..., c] * (1 - 0.35 * sh) + LINE[c] * 0.35 * sh
    tt = np.clip((yy - 30) / 34.0, 0, 1) * 0.35
    for c in range(3):
        col[..., c] = col[..., c] * (1 - T) + (HI[c] * (1 - tt) + SHD[c] * tt) * T
    tl = np.clip(T - _erode(T, 1.0), 0, 1) * (B > 0.5) * (yy > 36)
    for c in range(3):
        col[..., c] = col[..., c] * (1 - tl) + LINE[c] * tl
    for c in range(3):
        col[..., c] = col[..., c] * (1 - N) + NAIL[c] * N
    nl = np.clip(N - _erode(N, 0.7), 0, 1)
    for c in range(3):
        col[..., c] = col[..., c] * (1 - 0.7 * nl) + CREASE[c] * 0.7 * nl
    # silhouette outline (1 px, like the source crops)
    ol = np.clip(sil - _erode(sil, 1.0), 0, 1) * (yy > 6)
    for c in range(3):
        col[..., c] = col[..., c] * (1 - ol) + LINE[c] * ol
    rgba = np.dstack([col, sil * 255]).clip(0, 255).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA").resize((W, H), Image.BOX)
    return im


def build(out_dir):
    out = {}
    for sd, (W, H) in (("l", (59, 93)), ("r", (59, 90))):
        im = draw(W, H)
        if sd == "r":
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        p = out_dir / f"hand-{sd}-fist.png"
        im.save(p, format="PNG", optimize=False, compress_level=9)
        out[sd] = p
    return out


if __name__ == "__main__":
    import sys, pathlib
    print(build(pathlib.Path(sys.argv[1])))
