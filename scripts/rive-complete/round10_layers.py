#!/usr/bin/env python3
"""ROUND10 — cuff / sleeve de-duplication + ribbon-shard removal.

Root causes (see REPORT-ROUND10.md):
  * ``sleeve-*-full`` (+ ``-full-dark`` shading) had the whole cuff band baked in, and ``arm-*-cuff`` draws the same band
    again on top (5364 / 6459 px drawn twice per side). They are skinned differently, so in wave the two copies slide.
  * ``arm-*-cuff`` (and, on the left, ``sleeve-l-full``) carried a chunk of the orange hem ribbon (270 / 385+72 px)
    that rides on the forearm in wave -> the orange shard beside the wrist. The ribbon is its own layer already.

Fix: the cuff image owns the band; sleeve crops lose every pixel the cuff covers (6px seam overlap kept along the cuff's
top cut), and ribbon-coloured shards are removed from the cuff/sleeve crops and handed to the (body-locked) hem-ribbon
layer, whose crop grows upward, so the ribbon still reaches up behind the cuff in idle but never rides the arm.
Idempotent: always starts from the pinned ROUND9 (754f4a0) pixels.
"""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

S = 0.8463541666666666   # mother px -> artboard px (same as round8_scene.S)
ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "rive" / "nomi-complete"
OUT = PROJECT / "reference" / "svg-rig"
META = OUT / "rig-meta.json"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
PIN_R9 = "754f4a0"
REL = "rive/nomi-complete/reference/svg-rig/"
H, W = 1536, 1024
PIN_HEM = {"l": (315, 710, 415, 1010), "r": (610, 710, 710, 1010)}   # ROUND9 hem-ribbon boxes
SEAM = 6                  # rows of the cuff top cut that stay drawn by both layers (no hairline between sleeve and cuff)
RIBBON_ZONE_Y = {"l": 655, "r": 700}   # ribbon shards sit below this row (mother px)
RIBBON_ZONE_X = {"l": (336, 400), "r": (630, 668)}


def git_png(name: str) -> Image.Image:
    data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{PIN_R9}:{REL}{name}"])
    return Image.open(io.BytesIO(data)).convert("RGBA")


def to_canvas(png: Image.Image, box) -> np.ndarray:
    a = np.array(png)
    full = np.zeros((H, W, 4), np.uint8)
    full[box[1]:box[1] + a.shape[0], box[0]:box[0] + a.shape[1]] = a
    return full


def crop(full: np.ndarray, box, size) -> np.ndarray:
    return full[box[1]:box[1] + size[1], box[0]:box[0] + size[0]]


def dil(x, k):
    return cv2.dilate(x.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def ero(x, k):
    return cv2.erode(x.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def ribbon_pixels(c: np.ndarray, side: str, y_min: int | None = None) -> np.ndarray:
    """orange ribbon shard pixels (opaque or AA fringe) inside the ribbon zone of a full-size RGBA canvas"""
    r, g, b, a = [c[..., i].astype(int) for i in range(4)]
    org = (a > 20) & (r >= 170) & ((g - b) >= 45) & (b * 100 < g * 60)
    zone = np.zeros((H, W), bool)
    y0 = RIBBON_ZONE_Y[side] if y_min is None else y_min
    zone[y0:760, RIBBON_ZONE_X[side][0]:RIBBON_ZONE_X[side][1]] = True
    org &= zone
    n, lab, st, _ = cv2.connectedComponentsWithStats(org.astype(np.uint8), connectivity=8)
    big = np.zeros_like(org)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 40:      # keep the tiny gold buckle studs
            big |= lab == i
    fringe = dil(big, 3) & (a > 0) & ((r - b) >= 30) & (r >= g - 10) & zone
    return big | fringe


def build() -> dict:
    meta = json.loads(META.read_text())
    boxes = meta["boxes"]
    info = {}
    for side in ("l", "r"):
        cname = f"arm-{side}-cuff"
        cbox = boxes[cname]
        cpng = git_png(cname + ".png")
        csize = cpng.size
        cuff = to_canvas(cpng, cbox)
        # 1) ribbon shard out of the cuff crop
        rib = ribbon_pixels(cuff, side)
        moved = np.where(rib[..., None], cuff, 0).astype(np.uint8)
        cuff[..., 3] = np.where(rib, 0, cuff[..., 3])
        n, lab, st, _ = cv2.connectedComponentsWithStats((cuff[..., 3] > 0).astype(np.uint8), connectivity=8)
        keep = lab == (1 + int(np.argmax(st[1:, 4])))
        cuff[..., 3] = np.where(keep, cuff[..., 3], 0)           # drop floating specks the cut left behind
        # 1px-wide AA strands that hugged the ribbon edge (orange/brown hairs down the cuff's outer side)
        solid = cv2.morphologyEx((cuff[..., 3] > 20).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        solid = dil(solid, 3)
        cuff[..., 3] = np.where(solid, cuff[..., 3], 0)
        Image.fromarray(crop(cuff, cbox, csize)).save(OUT / f"{cname}.png")
        ca = cuff[..., 3]
        cuff_top = int(np.where(ca > 0)[0].min())
        own = ero(ca >= 200, 3)
        own[: cuff_top + SEAM] = False
        info[side] = {"cuff_ribbon_px": int(rib.sum()), "cuff_top": cuff_top, "owned_px": int(own.sum())}
        # 2) sleeve crops: lose the cuff band (+ the ribbon strip, which has its own layer)
        for nm in (f"sleeve-{side}-full", f"sleeve-{side}-full-dark"):
            bx = boxes[nm]
            png = git_png(nm + ".png")
            c = to_canvas(png, bx)
            rib_s = ribbon_pixels(c, side)
            if nm.endswith("-full"):
                take = rib_s[..., None] & (c[..., 3:4] > moved[..., 3:4])
                moved = np.where(take, c, moved).astype(np.uint8)
            rm = own | rib_s
            before = int((c[..., 3] > 0).sum())
            c[..., 3] = np.where(rm, 0, c[..., 3])
            n, lab, st, _ = cv2.connectedComponentsWithStats((c[..., 3] > 0).astype(np.uint8), connectivity=8)
            if n > 2:                                              # drop specks < 30px left by the cut
                for i in range(1, n):
                    if st[i, cv2.CC_STAT_AREA] < 30:
                        c[..., 3][lab == i] = 0
            Image.fromarray(crop(c, bx, png.size)).save(OUT / f"{nm}.png")
            info[side][nm] = before - int((c[..., 3] > 0).sum())
        info[side]["hem"] = extend_hem(boxes, meta, side, moved)
    write_meta(boxes)
    return info


def write_meta(boxes) -> None:
    """patch only the hem-ribbon boxes in place (keeps the file's formatting)"""
    import re
    txt = META.read_text()
    for k in ("hem-ribbon-l", "hem-ribbon-r"):
        txt, n = re.subn(rf'("{k}": )\[[^\]]*\]', lambda m: m.group(1) + str(list(boxes[k])), txt)
        assert n == 1
    META.write_text(txt)


def extend_hem(boxes, meta, side: str, moved: np.ndarray) -> dict:
    """grow hem-ribbon-<side> upward to carry the ribbon pixels taken off the cuff / sleeve crops"""
    nm = f"hem-ribbon-{side}"
    hbox = list(PIN_HEM[side])
    png = git_png(nm + ".png")
    ys, xs = np.where(moved[..., 3] > 0)
    top = min(hbox[1], int(ys.min()))
    assert xs.min() >= hbox[0] and xs.max() < hbox[2], (xs.min(), xs.max(), hbox)
    canvas = np.zeros((hbox[3] - top, hbox[2] - hbox[0], 4), np.uint8)
    canvas[hbox[1] - top:] = np.array(png)
    mv = moved[top:hbox[3], hbox[0]:hbox[2]]
    take = mv[..., 3] > canvas[..., 3]
    canvas[take] = mv[take]
    Image.fromarray(canvas).save(OUT / f"{nm}.png")
    boxes[nm] = [hbox[0], top, hbox[2], hbox[3]]
    return {"top": top, "rows_added": hbox[1] - top, "px": int(take.sum())}


def update_license() -> None:
    data = json.loads(LICENSE.read_text())
    assets = data["assets"]
    for side in "lr":
        for stem in (f"arm-{side}-cuff", f"sleeve-{side}-full", f"sleeve-{side}-full-dark", f"hem-ribbon-{side}"):
            rel = f"reference/svg-rig/{stem}.png"
            p = PROJECT / rel
            assets[rel] = {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size, "ai_generated": False,
                           "in_scene": True, "method": "deterministic source-pixel rig layer derived from user supplied full-body mother"}
    note = data.get("note", "")
    if "ROUND10" not in note:
        note = (note + " ROUND10: cuff band drawn once (sleeve crops lose the baked-in band), orange ribbon shards removed "
                "from cuff/sleeve crops.").strip()
    data["note"] = note
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    print(build())
    update_license()
