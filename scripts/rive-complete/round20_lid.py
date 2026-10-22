#!/usr/bin/env python3
"""ROUND20 Task C — closed-eye lid re-shade + soft edge (handoff §6 item 1).

Re-shade eye-{l,r}-skin toward calibrated socket-neighbour colours (sampled from
closed blink frames: ~234,181,162) with mild crease + feathered alpha. Soften
head.png 1 px dark eye-hole rim (open-eye subpixel possible; quantified in report).
Idempotent. DETAIL_LICENSE updated.
"""
from __future__ import annotations
import hashlib, json
import cv2, numpy as np
from PIL import Image
import round10_layers as L10

PROJECT, OUT = L10.PROJECT, L10.OUT
LICENSE, META = PROJECT / "parts" / "DETAIL_LICENSE.json", OUT / "rig-meta.json"
H, W = 1536, 1024
# Calibrated from closed blink neighbour skin (not pale membrane)
TARGET = {"l": np.array([232.6, 179.6, 160.1]), "r": np.array([236.5, 183.3, 156.4])}
FEATHER, CREASE = 2.8, 0.055
EYE_ELLIPSE = {"l": ((465.0, 161.0), (22.0, 14.0)), "r": ((545.0, 157.0), (24.0, 14.0))}

def refresh(lic, rel, method):
    p = PROJECT / rel
    e = lic["assets"].get(rel) or {}
    e.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size,
             ai_generated=False, in_scene=True, method=method)
    lic["assets"][rel] = e

def main():
    boxes = json.loads(META.read_text())["boxes"]
    lic = json.loads(LICENSE.read_text())
    report = {"eyes": {}, "head_rim": {}}
    for side in "lr":
        bname = f"eye-{side}-skin"
        cur = np.array(Image.open(OUT / f"{bname}.png").convert("RGBA"))
        m = cur[..., 3] > 0
        target = TARGET[side]
        h, w = m.shape
        fill = np.zeros((h, w, 3), np.float64); fill[:] = target
        ys, xs = np.where(m.any(1))[0], np.where(m.any(0))[0]
        if len(ys) and len(xs):
            y_bot, y_top = float(ys.max()), float(ys.min())
            yc = y_bot - 0.38 * (y_bot - y_top)
            yy = np.arange(h, dtype=np.float64)
            for x in xs:
                t = (x - xs.min()) / max(1, xs.max() - xs.min())
                taper = float(np.clip(np.sin(np.pi * t) * 1.3, 0, 1))
                cr = 1.0 - CREASE * taper * np.exp(-0.5 * ((yy - yc) / 1.2) ** 2)
                fill[:, x, :] *= cr[:, None]
            span = max(1.0, y_bot - y_top)
            top_w = np.clip((y_bot - yy) / span, 0, 1)
            fill *= (0.96 + 0.04 * (1.0 - 0.5 * top_w))[:, None, None]
        rgb = cv2.GaussianBlur(np.clip(fill + 0.5, 0, 255).astype(np.uint8), (3, 3), 0)
        dist_in = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 3)
        alpha = np.where(m, np.clip(dist_in / FEATHER, 0, 1) * 255.0, 0.0)
        out = np.dstack([rgb, np.clip(alpha + 0.5, 0, 255).astype(np.uint8)])
        out[~m, 3] = 0
        Image.fromarray(out).save(OUT / f"{bname}.png")
        report["eyes"][side] = {"target": [round(float(x), 1) for x in target],
                                "mean": [round(float(x), 1) for x in out[out[..., 3] > 100, :3].mean(0)]}
        refresh(lic, f"reference/svg-rig/{bname}.png",
                "ROUND20 lid: closed-eye underlayer matched to socket neighbours + feathered alpha")

    # soften head eye-hole dark rim
    him = np.array(Image.open(OUT / "head.png").convert("RGBA"))
    hb = boxes["head"]
    full = np.zeros((H, W, 4), np.uint8)
    full[hb[1]:hb[1] + him.shape[0], hb[0]:hb[0] + him.shape[1]] = him
    before = full.copy()
    for side, ((cx, cy), (rx, ry)) in EYE_ELLIPSE.items():
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
        ell = ((xx - cx) / (rx + 3)) ** 2 + ((yy - cy) / (ry + 3)) ** 2 <= 1
        hole = ell & (full[..., 3] < 40)
        dil = cv2.dilate(hole.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
        rim = dil & ~hole & (full[..., 3] > 180)
        lum = 0.3 * full[..., 0] + 0.59 * full[..., 1] + 0.11 * full[..., 2]
        dark = rim & (lum < 210)
        if not dark.any():
            report["head_rim"][side] = {"px": 0}; continue
        filled = cv2.inpaint(full[..., :3].copy(), dark.astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
        full[dark, :3] = (0.55 * filled[dark] + 0.45 * full[dark, :3]).astype(np.uint8)
        report["head_rim"][side] = {"px": int(dark.sum())}
    Image.fromarray(full[hb[1]:hb[1] + him.shape[0], hb[0]:hb[0] + him.shape[1]]).save(OUT / "head.png")
    report["head_rim"]["full_changed_px"] = int((np.abs(before.astype(int) - full.astype(int)).max(-1) > 0).sum())
    refresh(lic, "reference/svg-rig/head.png",
            (lic["assets"].get("reference/svg-rig/head.png", {}).get("method", "") +
             " ROUND20 lid: softened dark eye-hole rim").strip())
    note = lic.get("note", "")
    if "ROUND20 lid" not in note:
        lic["note"] = (note + " ROUND20 lid: closed-eye skin re-shade + feather; head eye-hole rim soften.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round20_lid" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round20_lid.py\n")
    (L10.ROOT / "scripts/rive-complete/round13/lid-r20.json").write_text(json.dumps(report, indent=1) + "\n")
    print("ROUND20 lid", json.dumps(report))

if __name__ == "__main__":
    main()
