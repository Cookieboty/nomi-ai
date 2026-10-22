#!/usr/bin/env python3
"""ROUND42a — split head.png (original pixels) into cap / face / sidebits / neck + backfills.

Partition is per-pixel (each original pixel lands in exactly one layer, RGBA untouched), so the
stacked rest pose is the original head.png.  Backfills live only under pixels that are opaque in
head.png (hidden at rest) and are derived from neighbouring original pixels:
  face  : forehead skin under hair-cap -> cv2 Telea inpaint from face skin
  neck  : skin under lower face -> vertical mirror of neck skin below the chin (+Telea for gaps)
  scalp : hair behind face/cap -> per-column triangle-wave reflection of the cap's lowest hair band
Writes head-{cap,face,sidebits,neck,scalp}.png + head-split-r42.json."""
from __future__ import annotations
import json, hashlib
import numpy as np, cv2
from PIL import Image
import round10_layers as L10

RIG = L10.PROJECT / "reference/svg-rig"


def chin(x):
    xs = [180, 190, 225, 250, 275, 300, 320]
    ys = [200, 205, 221, 229, 222, 210, 200]
    return np.interp(x, xs, ys)


def split():
    im = np.array(Image.open(RIG / "head.png").convert("RGBA"))
    H, W = im.shape[:2]
    a = im[..., 3]; A = a > 0
    R, G, B = [im[..., i].astype(int) for i in range(3)]
    yy, xx = np.mgrid[0:H, 0:W]
    lum = (R * 3 + G * 6 + B) / 10
    cy = chin(xx)
    skin = (R > 205) & (G > 150) & (B > 120) & (R - B < 110)
    clip = (R > 232) & (G > 232) & (B > 232) & (xx >= 288) & (yy <= 126)
    face = A & skin & (yy >= 92) & (yy <= cy) & (xx >= 186) & (xx <= 314) & ~clip
    # keep main connected component (+ small islands inside face bbox)
    n, lab, st, _ = cv2.connectedComponentsWithStats(face.astype(np.uint8), 8)
    keep = np.zeros_like(face)
    big = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    for i in range(1, n):
        if i == big or st[i, cv2.CC_STAT_AREA] < 40:
            keep |= lab == i
    face = keep
    # shaded cheek skin (left jaw in shadow) fails the bright-skin test: take everything inside the
    # face hull that is not dark hair and is warm skin-ish
    f8 = face.astype(np.uint8)
    cs, _ = cv2.findContours(f8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    fh = np.zeros_like(f8); cv2.fillPoly(fh, [cv2.convexHull(np.vstack(cs))], 1)
    warm = (R > 150) & (R - B > 20) & (R - B < 120) & (G > 95)
    face = face | (A & (fh > 0) & warm & (yy <= cy) & ~clip)
    # nose / mouth line: pixels that deviate from the smooth skin around them, inside small boxes
    blur = cv2.medianBlur(np.ascontiguousarray(im[..., :3]), 11).astype(int)
    dev = np.abs(im[..., :3].astype(int) - blur).max(-1)
    def feat(x0, y0, x1, y1, t):
        m = face & (dev > t) & (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
        n_, lb, st_, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        k = np.zeros_like(m)
        for i in range(1, n_):
            x, y, w, h, ar = st_[i]
            # feature strokes, not the cheek gradient touching the box border
            if ar >= 4 and x > x0 and x + w - 1 < x1 and y > y0 and y + h - 1 < y1:
                k |= lb == i
        return (cv2.dilate(k.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & face
    nose = feat(234, 158, 268, 196, 12)
    mouth = feat(214, 186, 288, 216, 12) & ~nose
    face = face & ~nose & ~mouth
    hairish = (lum < 175) & (R - B > 15)
    fm = face | nose | mouth
    choker_box = (xx >= 222) & (xx <= 294) & (yy >= 226) & (yy <= 256)
    side = A & ~fm & (yy >= 165) & hairish & ~choker_box
    clipres = A & ~fm & ~side & (cv2.dilate(clip.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    cap = A & ~fm & ~side & ~clipres & (yy < 176)
    neck = A & ~fm & ~side & ~cap & ~clipres
    parts = [clipres, cap, nose, mouth, face, side, neck]
    assert sum(m.astype(int) for m in parts).max() == 1 and (sum(m.astype(int) for m in parts) > 0).sum() == A.sum()

    # Backfill targets are generous; texels that would be visible at rest (under semi-transparent
    # layers / at window edges) are removed by the calibrated trim mask (offline round42_calibrate_trim.py, removed; see git history).
    opaque = A
    def layer(m):
        o = np.zeros_like(im); o[m] = im[m]; return o
    L0 = None
    # white clip backing baked in head.png: keep only the texels visible at rest (calibrated, ride
    # with the N clip in bangs.c); the hidden remainder becomes hair (Telea from cap) so it can't pop out
    cv_p = L10.ROOT / "scripts/rive-complete/head-split-r42-clipvis.png"
    clip_hidden = np.zeros_like(A)
    if cv_p.exists():
        cvis = np.array(Image.open(cv_p).convert("L")) > 0
        clip_hidden = clipres & ~cvis
        clipres = clipres & cvis
        cap = cap | clip_hidden
    L = {k: layer(m) for k, m in dict(clipres=clipres, cap=cap, nose=nose, mouth=mouth, face=face, side=side, neck=neck).items()}

    if clip_hidden.any():
        capk = cap & ~clip_hidden & hairish
        ci = cv2.inpaint(np.ascontiguousarray(im[..., :3][..., ::-1]), (~capk).astype(np.uint8) * 255, 5,
                         cv2.INPAINT_TELEA)[..., ::-1]
        L["cap"][clip_hidden, :3] = ci[clip_hidden]

    # ---- face backfill: forehead under cap (opaque head px only)
    fz = (yy >= 80) & (yy <= 180) & (xx >= 184) & (xx <= 318)
    tgt_f = cap & opaque & fz
    src = im[..., :3].copy()
    unknown = (~face).astype(np.uint8) * 255
    inp = cv2.inpaint(np.ascontiguousarray(src[..., ::-1]), unknown, 7, cv2.INPAINT_TELEA)[..., ::-1]
    # restore fine grain: add face high-frequency noise sampled from nearby skin rows (std-matched)
    L["face"][tgt_f, :3] = inp[tgt_f]; L["face"][tgt_f, 3] = 255
    # skin under nose / mouth (Telea from face skin; hidden at rest under the feature layers)
    tgt_nm = nose | mouth
    L["face"][tgt_nm, :3] = inp[tgt_nm]; L["face"][tgt_nm, 3] = im[tgt_nm, 3]

    # ---- socket: skin under eye windows + bang windows of head.png (moves with face, drawn below eyes)
    fz8 = ((face | nose | mouth) & (yy >= 96) & (yy <= 200)).astype(np.uint8)
    cnts, _ = cv2.findContours(fz8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = np.zeros_like(fz8)
    cv2.fillPoly(hull, [cv2.convexHull(np.vstack(cnts))], 1)
    win = (hull > 0) & ~A
    win = (cv2.dilate(win.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~(a >= 245)
    so = np.zeros_like(im)
    so[win, :3] = inp[win]; so[win, 3] = 255
    L["socket"] = so

    # ---- face skin under the side strands that hang over the cheeks (inside the face hull, above the
    # chin): the strands ride the skull, the face must not reveal the static neck through their gaps
    fz9 = (face | nose | mouth).astype(np.uint8)
    cnts9, _ = cv2.findContours(fz9, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull9 = np.zeros_like(fz9)
    cv2.fillPoly(hull9, [cv2.convexHull(np.vstack(cnts9))], 1)
    chin_px = np.array([chin(x) for x in range(W)])[None, :]
    tgt_s = side & (hull9 > 0) & (yy < chin_px) & opaque
    L["face"][tgt_s, :3] = inp[tgt_s]; L["face"][tgt_s, 3] = 255

    # ---- neck backfill: under lower face (y >= 150) — mirror neck skin upward about chin
    # only the jaw/chin band slides over the static neck; above it the moving skull backs itself
    tgt_n = (((face | nose | mouth) & (yy >= cy - 28)) | (side & (yy >= 200))) & opaque
    nk = neck & opaque & skin
    out = L["neck"]
    miss = np.zeros_like(tgt_n)
    for (y, x) in zip(*np.where(tgt_n)):
        c = int(round(chin(x)))
        ys = c + (c - y) + 1
        if 0 <= ys < H and nk[ys, x]:
            out[y, x, :3] = im[ys, x, :3]; out[y, x, 3] = 255
        else:
            miss[y, x] = True
    if miss.any():
        known = (out[..., 3] == 255)
        inp2 = cv2.inpaint(np.ascontiguousarray(out[..., :3][..., ::-1]), (~known).astype(np.uint8) * 255, 7,
                           cv2.INPAINT_TELEA)[..., ::-1]
        out[miss, :3] = inp2[miss]; out[miss, 3] = 255

    # ---- scalp: hair texture under face/cap/side (opaque head px), behind everything
    region = (cv2.dilate((A & ~neck).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0) & (yy >= 40) & (yy <= 235)
    hairpx = cap & hairish
    sc = np.zeros_like(im)
    for x in range(W):
        col = np.where(region[:, x])[0]
        if not len(col):
            continue
        hy = np.where(hairpx[:, x])[0]
        hy = hy[hy < 150]
        if len(hy) < 6:
            continue
        band = hy[-min(40, len(hy)):]
        n_ = len(band)
        for y in col:
            if hairpx[y, x]:
                sc[y, x, :3] = im[y, x, :3]; sc[y, x, 3] = 255; continue
            k = abs(y - band[-1])
            k = k % (2 * n_ - 2) if n_ > 1 else 0
            k = k if k < n_ else 2 * n_ - 2 - k
            v = im[band[n_ - 1 - k], x, :3].astype(float) * 0.82  # behind face → in shade
            sc[y, x, :3] = v.clip(0, 255); sc[y, x, 3] = 255
    # columns without hair above (outer edges): Telea from scalp neighbours
    holes = region & (sc[..., 3] == 0)
    if holes.any():
        inp3 = cv2.inpaint(np.ascontiguousarray(sc[..., :3][..., ::-1]), (sc[..., 3] == 0).astype(np.uint8) * 255, 9,
                           cv2.INPAINT_TELEA)[..., ::-1]
        sc[holes, :3] = inp3[holes]; sc[holes, 3] = 255
    L["scalp"] = sc

    # ---- calibrated trim: drop backfill texels that showed at rest (measured vs R41 render)
    bf = {"face": tgt_f | tgt_nm | tgt_s, "socket": L["socket"][..., 3] > 0, "neck": tgt_n,
          "scalp": L["scalp"][..., 3] > 0}
    trim_p = L10.ROOT / "scripts/rive-complete/head-split-r42-trim.png"
    trimmed = 0
    if trim_p.exists():
        trim = np.array(Image.open(trim_p).convert("L")) > 0
        for k, m in bf.items():
            t = m & trim
            L[k][t] = 0
            trimmed += int(t.sum())

    # ---- underlap: each lower layer gets a 2 px ring of ORIGINAL pixels under the layers above, so
    # bilinear edges of the upper layer composite over true pixels (no AA seam at partition borders)
    order = [("clipres", clipres), ("cap", cap), ("nose", nose), ("mouth", mouth), ("face", face), ("side", side), ("neck", neck)]
    k5 = np.ones((5, 5), np.uint8)
    above = np.zeros_like(A)
    for name, m in order:
        if above.any():
            ring = (cv2.dilate(m.astype(np.uint8), k5) > 0) & above
            if name == "neck":
                # the neck is static: a ring of original face/cheek pixels on it would stay behind as a
                # streak when the face parallaxes; keep the ring only along the jaw / below the chin
                ring &= yy >= chin_px - 6
            L[name][ring] = im[ring]
        above |= m
    # upper layers also overhang 1 texel of ORIGINAL pixels onto the layers below, so their bilinear
    # fade falls over low-contrast same-layer texels (kills the AA seam at partition borders)
    below = np.zeros_like(A)
    for name, m in reversed(order):
        if below.any():
            oh = (cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & below & ~m
            L[name][oh] = im[oh]
        below |= m

    meta = {}
    for k, v in L.items():
        p = RIG / f"head-{'sidebits' if k == 'side' else k}.png"
        Image.fromarray(v).save(p)
        meta[k] = {"px": int((v[..., 3] > 0).sum()), "sha": hashlib.sha256(p.read_bytes()).hexdigest()}
    meta["backfill_px"] = {"face_forehead": int(tgt_f.sum()),  "socket": int(win.sum()), "under_nose_mouth": int((nose|mouth).sum()), "neck_under_face": int(tgt_n.sum()),
                           "neck_telea": int(miss.sum()), "face_under_side": int(tgt_s.sum()), "clip_backing_to_hair": int(clip_hidden.sum()), "trimmed_visible_at_rest": trimmed, "scalp": int(region.sum())}
    meta["method"] = "ROUND42a per-pixel partition of head.png; backfills only under opaque px"
    (L10.ROOT / "scripts/rive-complete/head-split-r42.json").write_text(json.dumps(meta, indent=1))
    return meta


if __name__ == "__main__":
    print("ROUND42a head split", json.dumps(split()))
