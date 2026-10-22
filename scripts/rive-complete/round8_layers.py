#!/usr/bin/env python3
"""ROUND8 stage 1 — pixel layers: tank / belt-band / shorts / ID / pouch / leg skins / shoes / fingers.

Everything is cut from ``source-nomi-master.png`` (and the pre-ROUND7 body underlay pinned in git).
Idempotent: always starts from pinned git revisions, never from its own output.
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

PIN_PRE_R7 = "a7fc545"   # base underlay before ROUND7 punches
PIN_R7 = "5d7f38c"       # ROUND7 (starting point of ROUND8)
REL = "rive/nomi-complete/reference/svg-rig/"


def git_png(rev: str, name: str) -> Image.Image:
    data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{rev}:{REL}{name}"])
    return Image.open(io.BytesIO(data)).convert("RGBA")


def erode(mask: np.ndarray, k: int) -> np.ndarray:
    return cv2.erode(mask.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def dilate(mask: np.ndarray, k: int) -> np.ndarray:
    return cv2.dilate(mask.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def box_of(mask: np.ndarray, pad: int = 3) -> list[int]:
    ys, xs = np.where(mask)
    h, w = mask.shape
    return [int(max(0, xs.min() - pad)), int(max(0, ys.min() - pad)), int(min(w, xs.max() + 1 + pad)), int(min(h, ys.max() + 1 + pad))]


def paste_alpha(png: Image.Image, box: list[int], shape) -> np.ndarray:
    a = np.array(png)[:, :, 3] >= 128
    full = np.zeros(shape, bool)
    x0, y0 = box[0], box[1]
    hh = min(a.shape[0], shape[0] - y0)
    ww = min(a.shape[1], shape[1] - x0)
    full[y0:y0 + hh, x0:x0 + ww] = a[:hh, :ww]
    return full


def build() -> dict:
    mother = Image.open(SOURCE).convert("RGBA")
    m = np.array(mother)
    H, W = m.shape[:2]
    malpha = m[:, :, 3]
    fg = malpha >= 128
    r, g, b = [m[:, :, i].astype(int) for i in range(3)]
    mx = np.maximum(np.maximum(r, g), b)
    skin = (r >= 150) & (g >= 100) & (b >= 80) & (r - g >= 12) & (g - b >= 6) & (r - b >= 20) & (b * 100 >= g * 78)

    base_pre = git_png(PIN_PRE_R7, "fullbody-base-no-head-arms.png")
    ba = np.array(base_pre)[:, :, 3] >= 128  # mother minus head/arm claims

    meta_boxes = json.loads(META.read_text())["boxes"]
    boxes: dict[str, list[int]] = {}
    masks: dict[str, np.ndarray] = {}
    rows = lambda a, b_: (lambda z: (z.__setitem__(slice(a, b_), True), z)[1])(np.zeros((H, W), bool))  # noqa: E731

    # ---------- torso tank (black vest incl. N logo), straight from the mother ----------
    dark = (mx <= 105) & fg
    n, lab = cv2.connectedComponents((dark & rows(300, 482)).astype(np.uint8))
    tank = lab == lab[420, 500]
    tank = cv2.morphologyEx(tank.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8)) > 0
    tank &= fg & rows(335, 490)   # 8px overlap under the belt band (no seam line)
    masks["torso-tank"] = tank

    # ---------- belt + shorts connected component (non-skin, not claimed by arm layers) ----------
    cand = ba & rows(466, 760) & ~skin
    n, lab = cv2.connectedComponents(cand.astype(np.uint8))
    comp = lab == lab[600, 500]
    xr = np.zeros((H, W), bool)
    xr[:, 412:604] = True
    belt = comp & rows(476, 522) & xr   # overlaps tank bottom / shorts top by ~6px
    masks["belt-band"] = belt
    shorts_all = comp & rows(510, 752)
    # ID card + pouch overlays (swing layers); shorts layer is inpainted under them
    idr = np.zeros((H, W), bool); idr[512:668, 438:486] = True
    pouchr = np.zeros((H, W), bool); pouchr[508:612, 556:640] = True
    def solid(mask: np.ndarray) -> np.ndarray:
        """close + fill interior holes (card/pouch interiors read as skin-ish and fall out of ``comp``)"""
        c = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        cnts, _ = cv2.findContours(c, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = np.zeros_like(c)
        cv2.drawContours(out, cnts, -1, 1, thickness=-1)
        return out > 0

    id_card = solid(shorts_all & idr) & ba
    pouch = solid(shorts_all & pouchr & ~idr) & ba & ~id_card
    shorts_all = shorts_all | id_card | pouch
    masks["belt-id"] = id_card
    masks["belt-pouch"] = pouch
    masks["shorts"] = shorts_all

    # ---------- legs ----------
    zones = {"l": (372, 500, (900, 460)), "r": (505, 636, (900, 560))}
    for side, (x0, x1, seed) in zones.items():
        zone = np.zeros((H, W), bool); zone[700:1272, x0:x1] = True
        c = ba & zone & ~shorts_all
        n, lab = cv2.connectedComponents(c.astype(np.uint8), connectivity=4)
        masks[f"leg-{side}-skin"] = lab == lab[seed]
        zs = np.zeros((H, W), bool); zs[1262:1512, x0 - 20:x1 + 40] = True
        zs[:, : (360 if side == "l" else 508)] = False
        zs[:, (508 if side == "l" else 700):] = False
        sc = ba & zs
        n, lab = cv2.connectedComponents(sc.astype(np.uint8), connectivity=4)
        masks[f"shoe-{side}"] = lab == lab[1450, 460 if side == "l" else 575]

    # ---------- render crops ----------
    def rgba_from(mask: np.ndarray, pix: np.ndarray | None = None, grow: int = 0) -> np.ndarray:
        src = m if pix is None else pix
        out = src.copy()
        keep = dilate(mask, 3) & (malpha > 0) & ~((~mask) & dilate(mask, 3) & fg)  # 1px AA fringe only
        if grow:  # keep true mother pixels 1px beyond the cut so hard-cut edges stay anti-aliased like the mother
            keep = keep | (dilate(mask, grow) & (malpha > 0))
        out[:, :, 3] = np.where(mask, malpha, np.where(keep, malpha, 0)).astype(np.uint8)
        return out

    def save(name: str, rgba: np.ndarray, mask: np.ndarray, pad: int = 3) -> None:
        bx = box_of(mask, pad)
        crop = rgba[bx[1]:bx[3], bx[0]:bx[2]].copy()
        # mother body alpha is 249-253 inside the figure: snap to opaque so the dark stage never bleeds through
        crop[:, :, 3] = np.where(crop[:, :, 3] >= 200, 255, crop[:, :, 3])
        Image.fromarray(crop).save(OUT / f"{name}.png")
        boxes[name] = bx

    for name in ("torso-tank", "belt-band", "belt-id", "belt-pouch"):
        save(name, rgba_from(masks[name], grow=3 if name in ("torso-tank", "belt-band") else 0), masks[name])

    # shorts: fill under ID/pouch with the local dark fabric colour (so a swinging overlay never exposes a hole)
    pix = m.copy()
    darkfab = (mx <= 110) & shorts_all
    for ov in (id_card, pouch):
        under = dilate(ov, 5) & shorts_all
        ringm = dilate(ov, 41) & ~dilate(ov, 9) & darkfab
        col = np.median(m[:, :, :3][ringm], axis=0) if ringm.sum() else np.array([40, 36, 34])
        fill = np.zeros_like(m[:, :, :3]); fill[:] = col.astype(np.uint8)
        pix[:, :, :3] = np.where(under[:, :, None], fill, pix[:, :, :3])
    # light blur only inside filled zones to keep a fabric feel
    blur = cv2.GaussianBlur(pix[:, :, :3], (0, 0), 3)
    uz = dilate(id_card | pouch, 5) & shorts_all
    pix[:, :, :3] = np.where(uz[:, :, None], blur, pix[:, :, :3])
    save("shorts", rgba_from(shorts_all, pix, grow=3), shorts_all)

    # legs: fill outer-hand holes + extend the thigh top under the shorts hem
    for side in ("l", "r"):
        lm = masks[f"leg-{side}-skin"].copy()
        zx0, zx1 = zones[side][0], zones[side][1]
        zone = np.zeros((H, W), bool); zone[:, zx0:zx1] = True
        hull = cv2.morphologyEx(lm.astype(np.uint8), cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))) > 0
        hull &= zone
        # per-row span (top 60 rows: use the skin-only edges below to avoid hand notches)
        hole = hull & ~lm
        ext = np.zeros_like(lm)
        for x in range(zx0, zx1):
            col = np.where(lm[:, x])[0]
            if len(col):
                yf = col.min()
                if yf > 690:
                    ext[max(670, yf - 45):yf, x] = True
        filled = lm | hole | ext
        # color: inpaint hole from neighbours; extension replicates the first rows downward
        pix_leg = m.copy()
        need = (hole | ext)
        # unknown = everything that is not real leg skin inside this leg's window (black bleed fix)
        win = np.zeros((H, W), bool); win[640:1290, zx0 - 10:zx1 + 10] = True
        unknown = (need | (~lm & win)).astype(np.uint8) * 255
        known = np.where(lm[:, :, None], m[:, :, :3], 0).astype(np.uint8)
        bgr_l = cv2.inpaint(cv2.cvtColor(known, cv2.COLOR_RGB2BGR), unknown, 7, cv2.INPAINT_TELEA)
        rgb_l = cv2.cvtColor(bgr_l, cv2.COLOR_BGR2RGB)
        pix_leg[:, :, :3] = np.where(need[:, :, None], rgb_l, m[:, :, :3])
        a = np.where(need, 255, malpha)
        pix_leg[:, :, 3] = a.astype(np.uint8)
        masks[f"leg-{side}-skin"] = filled
        rg = pix_leg.copy()
        keep = dilate(filled, 3) & (malpha > 0) & zone
        rg[:, :, 3] = np.where(filled, pix_leg[:, :, 3], np.where(keep, malpha, 0)).astype(np.uint8)
        save(f"leg-{side}-skin", rg, filled, 4)

    for side in ("l", "r"):
        save(f"shoe-{side}", rgba_from(masks[f"shoe-{side}"]), masks[f"shoe-{side}"], 3)

    hands_u = np.zeros((H, W), bool)
    for side, (hx, hy) in (("l", (265, 740)), ("r", (659, 740))):
        for part in ("palm", "thumb", "index", "middle", "ring", "little"):
            hp = git_png(PIN_R7, f"hand-{side}-{part}.png")
            hands_u |= paste_alpha(hp, [hx, hy], (H, W))
    hands_u = dilate(hands_u, 5) & skin  # only skin-toned fringe: orange tail pixels under the fingertips stay
    # ---------- new body underlay ("base"): full removal for moving limbs, ring for vest/shorts ----------
    base_arr = np.array(base_pre)
    alpha = base_arr[:, :, 3].copy()
    # ROUND7 hem-ribbon punches (kept)
    for hn in ("hem-ribbon-l", "hem-ribbon-r"):
        hm = paste_alpha(git_png(PIN_R7, f"{hn}.png"), meta_boxes[hn], (H, W))
        alpha[erode(hm, 5)] = 0
    ring = 7
    for key in ("torso-tank", "belt-band"):
        alpha[erode(masks[key], ring)] = 0
    alpha[erode(masks["shorts"] | masks["belt-id"] | masks["belt-pouch"], ring)] = 0
    for key in ("leg-l-skin", "leg-r-skin", "shoe-l", "shoe-r"):
        alpha[dilate(masks[key], 3)] = 0
    alpha[hands_u] = 0  # hand-fringe leftovers stayed behind as ghost slivers when the hand moved
    alpha = np.where(alpha >= 200, 255, alpha).astype(np.uint8)
    base_arr[:, :, 3] = alpha
    Image.fromarray(base_arr).save(OUT / "fullbody-base-no-head-arms.png")

    # coat tails / ribbons carried leg pixels (static ghosts when the knee bends): remove them
    legs_u = dilate(masks["leg-l-skin"] | masks["leg-r-skin"] | masks["shoe-l"] | masks["shoe-r"], 3) | hands_u
    for tn in ("coat-l-tail", "coat-r-tail", "hem-ribbon-l", "hem-ribbon-r"):
        src_png = git_png(PIN_R7, f"{tn}.png")
        arr = np.array(src_png)
        x0, y0 = meta_boxes[tn][0], meta_boxes[tn][1]
        hh, ww = arr.shape[:2]
        sub = legs_u[y0:y0 + hh, x0:x0 + ww]
        sub = sub[:hh, :ww]
        a2 = arr[:, :, 3]
        a2[:sub.shape[0], :sub.shape[1]][sub] = 0
        # drop detached specks (hand-fringe leftovers that stay behind as ghost slivers when a hand moves)
        near = cv2.morphologyEx((a2 > 40).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n_cc, lab_cc, st_cc, _ = cv2.connectedComponentsWithStats(near, connectivity=4)
        if n_cc > 2:
            big = 1 + int(np.argmax(st_cc[1:, cv2.CC_STAT_AREA]))
            a2 = np.where(dilate(lab_cc == big, 5), a2, 0).astype(np.uint8)
        arr[:, :, 3] = a2
        Image.fromarray(arr).save(OUT / f"{tn}.png")

    meta = json.loads(META.read_text())
    meta["boxes"].update(boxes)
    META.write_text(json.dumps(meta, indent=2) + "\n")
    return {"boxes": boxes, "masks": masks}


if __name__ == "__main__":
    res = build()
    for k, v in res["boxes"].items():
        print(k, v)
