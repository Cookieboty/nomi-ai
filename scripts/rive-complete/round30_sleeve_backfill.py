#!/usr/bin/env python3
"""ROUND30 — close the sleeve holes exposed when coat-front hangs away (wave/cheer/…).

Root cause: R27a only backfilled an eroded opaque core (ds>2, feathered alpha) under the
coat panel. At rest the coat covers the gaps; R27d gravity drape swings the panel off the
sleeve and the unfilled / weak-alpha texels read as a missing chunk (user: 招手缺了一整块).
Measured on tip: ~975 (r) / ~841 (l) coat-footprint pixels with sleeve alpha<8.

Fix (deterministic, no AI): under the FULL panel footprint (Mf, still excluding hem-tail
rows), Telea-inpaint from remaining solid sleeve pixels into every texel whose sleeve alpha
is below 250; write solid alpha 255 (no feather). Seam-adjacent band keeps unshaded fabric;
deeper core keeps the R27 ×0.66 shade. Idempotent via coat-*-front.json round30 mark +
alpha audit. Also hardens round27_coat_split backfill for clean rebuilds (see that file).
"""
from __future__ import annotations
import hashlib, json, sys
import numpy as np, cv2
from PIL import Image
import round10_layers as L10
import round27_coat_split as R27

PROJECT = L10.PROJECT
SVG = PROJECT / "reference/svg-rig"
MARK_KEY = "round30_backfill"
ALPHA_MIN = 250
BAND = 10.0
SHADE = 0.66


def strengthen(side: str) -> dict:
    fs, fd, fp = SVG / f"sleeve-{side}-full.png", SVG / f"sleeve-{side}-full-dark.png", SVG / f"coat-{side}-front.png"
    fj = SVG / f"coat-{side}-front.json"
    S = np.array(Image.open(fs).convert("RGBA"))
    D = np.array(Image.open(fd).convert("RGBA"))
    P = np.array(Image.open(fp).convert("RGBA"))
    Mc = R27.mask(side)
    Mf = Mc >= 1.0
    # Coat alpha footprint (dilated 1 px for bilinear fringe), intersected with geometric panel body.
    # Do NOT fill empty canvas inside Mf — that would grow the sleeve past the original silhouette.
    body = Mf.copy()
    body[R27.HEM[side][0]:] = False
    coat_a = P[..., 3] > 0
    dil = cv2.dilate(coat_a.astype(np.uint8), np.ones((3, 3), np.uint8), 1).astype(bool)
    body = body & dil
    before_miss = int((body & (S[..., 3] < 8)).sum())
    before_weak = int((body & (S[..., 3] < ALPHA_MIN)).sum())
    st = json.loads(fj.read_text()) if fj.exists() else {}
    if st.get(MARK_KEY) and before_weak == 0:
        return dict(side=side, skipped=True, before_miss=before_miss, before_weak=before_weak, **{k: st.get(k) for k in ("filled_px", "band_px", "under_px")})

    # solid sleeve source for Telea (outside panel full-coverage)
    src = (~Mf) & (S[..., 3] >= 250)
    # also allow already-good backfill inside body as source so re-runs refine edges
    src = src | (body & (S[..., 3] >= ALPHA_MIN) & (S[..., 3] > 0))
    need = body & (S[..., 3] < ALPHA_MIN)
    if not need.any():
        st[MARK_KEY] = dict(filled_px=0, before_miss=before_miss, before_weak=before_weak)
        fj.write_text(json.dumps(st, indent=1) + "\n")
        return dict(side=side, skipped=True, before_miss=0, before_weak=0, filled_px=0)

    hole = (~src).astype(np.uint8) * 255
    # seed RGB: keep existing sleeve RGB where present so Telea has colour hints inside the hole
    seed = S[..., :3].copy()
    fill_bgr = cv2.inpaint(np.ascontiguousarray(seed[..., ::-1]), hole, 8, cv2.INPAINT_TELEA)[..., ::-1].astype(float)
    dist = cv2.distanceTransform((~((~Mf) & (S[..., 3] >= 250))).astype(np.uint8), cv2.DIST_L2, 5)
    # distance from true non-panel sleeve fabric
    dist_out = cv2.distanceTransform((~((~Mf) & (S[..., 3] >= 250))).astype(np.uint8), cv2.DIST_L2, 5)
    band = need & (dist_out <= BAND)
    under = need & ~band
    sh = np.clip((dist_out - BAND) / 6.0, 0, 1)[..., None]
    shaded = fill_bgr * (1 - (1 - SHADE) * sh)
    S2 = S.copy()
    S2[need, :3] = np.round(shaded[need]).astype(np.uint8)
    S2[need, 3] = 255  # solid — coat covers at rest; when coat leaves, no alpha hole
    # Preserve RGB in still-transparent texels outside body for filter fringe (unchanged)
    Image.fromarray(S2).save(fs, optimize=True)

    # dark layer: only fill where dark had content moved (optional soft fill); keep idempotent no-op if empty
    # We do not invent dark content under the panel — R27 left dark cleared there.

    after_miss = int((body & (S2[..., 3] < 8)).sum())
    after_weak = int((body & (S2[..., 3] < ALPHA_MIN)).sum())
    filled = int(need.sum())
    info = dict(filled_px=filled, band_px=int(band.sum()), under_px=int(under.sum()),
                before_miss=before_miss, before_weak=before_weak,
                after_miss=after_miss, after_weak=after_weak,
                sleeve_sha=hashlib.sha256(fs.read_bytes()).hexdigest())
    st[MARK_KEY] = info
    # update split_sha so round27 won't think sleeve is stale in a weird way — keep original split_sha
    fj.write_text(json.dumps(st, indent=1) + "\n")
    return dict(side=side, skipped=False, **info)


def license_update():
    p = PROJECT / "parts/DETAIL_LICENSE.json"
    L = json.loads(p.read_text())
    files = [f"reference/svg-rig/sleeve-{s}-full.png" for s in "lr"]
    for f in files:
        b = (PROJECT / f).read_bytes()
        e = L["assets"].setdefault(f, {"ai_generated": False, "in_scene": True})
        e.update(sha256=hashlib.sha256(b).hexdigest(), bytes=len(b), ai_generated=False, in_scene=True)
        e["method"] = (e.get("method", "") + " ROUND30: sleeve under coat-front body footprint backfilled solid (Telea, no feather) so panel hang does not open alpha holes.").strip()
    if "ROUND30" not in L.get("note", ""):
        L["note"] = L.get("note", "") + (
            " ROUND30: strengthen sleeve-{l,r}-full.png backfill under the full coat panel body "
            "(no 2px erosion / alpha feather) so R27d gravity hang no longer reveals background holes."
        )
    p.write_text(json.dumps(L, indent=2, ensure_ascii=False) + "\n")


def main():
    stats = {s: strengthen(s) for s in "lr"}
    license_update()
    # ensure pipeline invokes us after coat split
    bt_path = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = bt_path.read_text()
    if "round30_sleeve_backfill" not in bt:
        # insert after round27_coat_split
        if "python3 round27_coat_split.py\n" in bt:
            bt = bt.replace("python3 round27_coat_split.py\n",
                            "python3 round27_coat_split.py\npython3 round30_sleeve_backfill.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round30_sleeve_backfill.py\n"
        bt_path.write_text(bt)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
