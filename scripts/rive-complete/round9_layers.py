#!/usr/bin/env python3
"""ROUND9 stage 1 — one continuous hand layer per side (wrist + palm + thumb + fingers), disjoint by construction.

Root cause recap (see REPORT-ROUND9.md): the hand pixels were drawn up to 8 times (arm cuff crop, palm crop, five
overlapping finger crops, plus orange-ribbon / thigh fragments riding on the cuff crop). ROUND9 cuts the mother hand
ONCE (``hand-l.png`` / ``hand-r.png``), and removes every hand / ribbon / thigh pixel from the cuff and sleeve crops.

Idempotent: starts from the pinned ROUND8 (be33278) cuff/sleeve/ribbon pixels and from the mother.
"""
from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "rive" / "nomi-complete"
OUT = PROJECT / "reference" / "svg-rig"
SOURCE = PROJECT / "source-nomi-master.png"
META = OUT / "rig-meta.json"
PIN_R8 = "be33278"
REL = "rive/nomi-complete/reference/svg-rig/"

HAND_REGION = {"l": (268, 352), "r": (660, 742)}   # x range of the mother hand
HAND_Y = (741, 836)
STUB = 5                                            # px of wrist stub hidden under the cuff band


def git_png(rev: str, name: str) -> Image.Image:
    data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{rev}:{REL}{name}"])
    return Image.open(io.BytesIO(data)).convert("RGBA")


def dil(x: np.ndarray, k: int) -> np.ndarray:
    return cv2.dilate(x.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def ero(x: np.ndarray, k: int) -> np.ndarray:
    return cv2.erode(x.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


class Mother:
    def __init__(self) -> None:
        self.rgba = np.array(Image.open(SOURCE).convert("RGBA"))
        self.h, self.w = self.rgba.shape[:2]
        r, g, b = [self.rgba[:, :, i].astype(int) for i in range(3)]
        self.a = self.rgba[:, :, 3]
        self.skin = (r >= 150) & (g >= 100) & (b >= 80) & (r - g >= 12) & (g - b >= 6) & (r - b >= 20) & (b * 100 >= g * 78)
        self.orange = (r >= 170) & ((g - b) >= 45) & (b * 100 < g * 60)
        self.reddish = (r - b >= 12) & (r >= g)   # skin outline / AA pixels (not grey smudge, not cuff leather)
        self.r, self.g, self.b = r, g, b


def paste_box(png: Image.Image, box: list[int], shape) -> np.ndarray:
    """full-size RGBA canvas with png pasted at box[:2]"""
    arr = np.array(png)
    full = np.zeros((shape[0], shape[1], 4), np.uint8)
    x0, y0 = box[0], box[1]
    hh = min(arr.shape[0], shape[0] - y0)
    ww = min(arr.shape[1], shape[1] - x0)
    full[y0:y0 + hh, x0:x0 + ww] = arr[:hh, :ww]
    return full


def hand_masks(M: Mother) -> dict[str, dict]:
    res = {}
    for side, (x0, x1) in HAND_REGION.items():
        reg = np.zeros((M.h, M.w), bool)
        reg[HAND_Y[0]:HAND_Y[1], x0:x1] = True
        core = M.skin & reg & (M.a >= 128)
        n, lab, st, _ = cv2.connectedComponentsWithStats(core.astype(np.uint8), connectivity=8)
        core = lab == (1 + int(np.argmax(st[1:, 4])))
        # close pin-holes / light interior cracks in the hand (never the real finger gap)
        # column top of the skin (wrist edge): nothing above it belongs to the hand
        coltop = np.full(M.w, 10**6)
        for x in range(M.w):
            ys = np.where(core[:, x])[0]
            if len(ys):
                coltop[x] = ys.min()
        for x in range(1, M.w - 1):          # smooth across neighbours so the wrist edge has no 1px notches
            coltop[x] = min(coltop[x - 1], coltop[x], coltop[x + 1]) if coltop[x] < 10**6 else coltop[x]
        yy = np.arange(M.h)[:, None]
        below = yy >= coltop[None, :]
        lum = np.maximum(np.maximum(M.r, M.g), M.b)
        below1 = yy >= coltop[None, :] + 2
        fringe = dil(core, 3) & ~core & (M.a > 0) & ~M.orange & M.reddish & (M.r - M.b >= 22) & reg & below
        fringe &= ~((lum < 120) & ~below1)          # drop the cuff-leather shadow row right under the band
        mask = core | fringe
        # white highlights fail the skin test: fill interior holes that are opaque in the mother
        # (the real gap between thumb and index is transparent in the mother and stays open)
        cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        filled = np.zeros(mask.shape, np.uint8)
        cv2.drawContours(filled, cnts, -1, 1, thickness=-1)
        mask = mask | ((filled > 0) & (M.a >= 128) & ~M.orange)
        mask &= ~((lum < 190) & ((M.r - M.b) < 15))   # grey finger-shadow smudge on the ribbon
        core = core | (mask & ~fringe)
        res[side] = {"core": core, "mask": mask, "coltop": coltop}
    return res


def build() -> dict:
    M = Mother()
    hm = hand_masks(M)
    meta = json.loads(META.read_text())
    boxes = meta["boxes"]
    info = {}
    for side in ("l", "r"):
        mask, core, coltop = hm[side]["mask"], hm[side]["core"], hm[side]["coltop"]
        # ---- cuff crop: keep the cuff band / sleeve only (no hand, no thigh chunk, no ribbon strip)
        cuff = git_png(PIN_R8, f"arm-{side}-cuff.png")
        cbox = boxes[f"arm-{side}-cuff"]
        c = paste_box(cuff, cbox, (M.h, M.w))
        calpha = c[:, :, 3]
        yy = np.arange(M.h)[:, None] * np.ones((1, M.w), int)
        remove = dil(mask, 3) & (yy >= 738)
        remove |= (M.skin & (yy >= 722))
        xs_ = np.arange(M.w)[None, :] * np.ones((M.h, 1), int)
        ribbon_side = (xs_ >= 336) if side == "l" else (xs_ <= 668)
        remove |= (M.orange & (yy >= 738))
        remove |= (M.orange & (yy >= 722) & ribbon_side)   # ribbon strip below the hem-ribbon top (y=719) rode on the forearm: streak in wave
        remove |= yy >= 752
        keep = (calpha > 0) & ~remove
        n, lab, st, _ = cv2.connectedComponentsWithStats(keep.astype(np.uint8), connectivity=8)
        keep = lab == (1 + int(np.argmax(st[1:, 4])))
        keep = keep | (dil(keep, 3) & (calpha > 0) & ~remove)   # AA fringe along the cut
        newc = c.copy()
        newc[:, :, 3] = np.where(keep, calpha, 0).astype(np.uint8)
        sub = newc[cbox[1]:cbox[3], cbox[0]:cbox[2]]
        Image.fromarray(sub).save(OUT / f"arm-{side}-cuff.png")
        cuff_cover = keep & (calpha >= 200)

        # ---- hand crop with a wrist stub hidden under the cuff band
        alpha = np.where(mask, M.a, 0).astype(np.uint8)
        alpha = np.where(alpha >= 200, 255, alpha).astype(np.uint8)
        rgb = M.rgba[:, :, :3].copy()
        stub = np.zeros_like(mask)
        for x in range(M.w):
            t = coltop[x]
            if t >= 10**6 or not core[t:t + 1, x].any():
                continue
            for k in range(1, STUB + 1):
                y = t - k
                if cuff_cover[y, x] and not mask[y, x]:
                    stub[y, x] = True
                    rgb[y, x] = rgb[t + 1, x]
        stub = stub & ero(dil(stub, 3), 1)
        alpha = np.where(stub, 255, alpha).astype(np.uint8)
        ys, xs = np.where(alpha > 0)
        pad = 2
        hb = [int(xs.min()) - pad, int(ys.min()) - pad, int(xs.max()) + 1 + pad, int(ys.max()) + 1 + pad]
        img = np.dstack([rgb, alpha])[hb[1]:hb[3], hb[0]:hb[2]]
        Image.fromarray(img).save(OUT / f"hand-{side}.png")
        boxes[f"hand-{side}"] = hb
        info[side] = {"box": hb, "mask_px": int(mask.sum()), "stub_px": int(stub.sum())}
    # ---- sleeve crops: wrist-skin sliver at the bottom edge belongs to the hand layer now
    for side in ("l", "r"):
        mask = hm[side]["mask"]
        for nm in ("sleeve-%s-lower", "sleeve-%s-lower-dark", "sleeve-%s-lower-orange", "sleeve-%s-full",
                   "sleeve-%s-full-dark", "sleeve-%s-bent"):
            nm = nm % side
            if nm not in boxes:
                continue
            png = git_png(PIN_R8, nm + ".png")
            bx = boxes[nm]
            c = paste_box(png, bx, (M.h, M.w))
            yy = np.arange(M.h)[:, None] * np.ones((1, M.w), int)
            rm = ((M.skin | dil(mask, 3)) & (yy >= 735))
            c[:, :, 3] = np.where(rm, 0, c[:, :, 3])
            Image.fromarray(c[bx[1]:bx[3], bx[0]:bx[2]]).save(OUT / f"{nm}.png")

    # ---- hem ribbons: drop hand-skin fringe + straighten the edge that faced the fingertips
    for side in ("l", "r"):
        nm = f"hem-ribbon-{side}"
        png = git_png(PIN_R8, nm + ".png")
        bx = boxes[nm]
        arr = np.array(png)
        a = arr[:, :, 3].copy()
        hh, ww = a.shape
        sub = M.skin[bx[1]:bx[3], bx[0]:bx[0] + arr.shape[1]]
        # only the hand-facing strip of the ribbon, only the hand rows (the white X on the tail is skin-coloured too)
        zone = np.zeros((hh, ww), bool)
        y_lo, y_hi = 722 - bx[1], 840 - bx[1]
        hand_x = (0, 40) if side == "l" else (ww - 40, ww)
        zone[y_lo:y_hi, hand_x[0]:hand_x[1]] = True
        a[sub & (a < 255) & zone] = 0
        a[dil(sub, 3) & ~M.orange[bx[1]:bx[3], bx[0]:bx[0] + arr.shape[1]] & (a < 200) & zone] = 0
        edge = np.full(hh, -1)
        for y in range(hh):
            xs = np.where(a[y] > 40)[0]
            if len(xs):
                edge[y] = xs.min() if side == "l" else xs.max()
        valid = edge >= 0
        sm = edge.astype(float).copy()
        k = 9
        for y in range(hh):
            lo, hi = max(0, y - k), min(hh, y + k + 1)
            v = edge[lo:hi][valid[lo:hi]]
            if len(v):
                sm[y] = np.median(v)
        for y in range(hh):
            if not valid[y] or not (y_lo - 6 <= y <= y_hi + 6):
                continue
            if side == "l":
                a[y, : int(sm[y]) - 1] = 0
            else:
                a[y, int(sm[y]) + 2:] = 0
        # drop specks (<40px) that float next to the ribbon
        n_cc, lab_cc, st_cc, _ = cv2.connectedComponentsWithStats((a > 40).astype(np.uint8), connectivity=8)
        for i in range(1, n_cc):
            if st_cc[i, cv2.CC_STAT_AREA] < 40:
                a[lab_cc == i] = 0
        arr[:, :, 3] = a
        Image.fromarray(arr).save(OUT / f"{nm}.png")

    # ---- base underlay: remove the skin+orange arm sliver left near the right forearm
    base = Image.open(OUT / "fullbody-base-no-head-arms.png").convert("RGBA")
    bar = np.array(base)
    n_cc, lab_cc, st_cc, _ = cv2.connectedComponentsWithStats((bar[:, :, 3] > 0).astype(np.uint8), connectivity=8)
    for i in range(1, n_cc):
        x, y, w_, h_, area = st_cc[i]
        if 590 <= x <= 610 and 625 <= y <= 650 and area < 500:
            bar[:, :, 3][lab_cc == i] = 0
    Image.fromarray(bar).save(OUT / "fullbody-base-no-head-arms.png")

    # drop the old per-part crops (palm / 5 fingers each)
    for side in ("l", "r"):
        for part in ("palm", "thumb", "index", "middle", "ring", "little"):
            (OUT / f"hand-{side}-{part}.png").unlink(missing_ok=True)
            boxes.pop(f"hand-{side}-{part}", None)
    META.write_text(json.dumps(meta, indent=2) + "\n")
    return info


if __name__ == "__main__":
    print(build())
