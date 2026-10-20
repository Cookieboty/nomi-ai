#!/usr/bin/env python3
"""ROUND27 item 1 - split the coat FRONT PANELS (+ their lower hem tails) out of the sleeve textures.

Root cause (R26 audit): the button placket, the orange lining strip and the dark leather trim of each coat front, plus
the hem tail lines hanging below the cuff, were baked into sleeve-{l,r}-full(.dark).png and skinned to
upper/fore/hand, so the coat front could only ever follow the arm; full.coat-{l,r}.front were empty bones.

Split (deterministic, source pixels moved - not copied - no AI):
  M = inner-side region (anti-aliased: the seam pixel gets its fractional coverage, the sleeve keeps it underneath) of the sleeve canvas behind a hand-placed boundary polyline (placket's outer seam, then the
      trim's outer edge), from below the collar (L y>=90 / R y>=95 texel) to the cuff line, plus the hem-tail lines
      below the cuff (texel y>=356) on the inner side.
  coat-{l,r}-front.png = sleeve over sleeve-dark composite inside M (same 225x440 canvas => same uv mesh, rest-exact).
  sleeve-{l,r}-full.png / -dark.png lose every M pixel (recorded as deleted regions).
  Backfill inside the sleeve under the panel's OPAQUE core only (panel alpha >= 253 = the source opaque level, eroded 2 px so texture filtering never
  samples the fill; none under the hem-tail lines), so rest frames are unchanged:
    band  : <= 10 px from the cut seam -> sleeve fabric continued by cv2 Telea inpaint from non-M sleeve pixels
            (the panel's cut edge never opens a gap when it swings off the sleeve);
    under : rest of the core -> same inpaint shaded x0.66 (the coat's inside / the sleeve in the panel's shadow);
    the fill's outer contour is Gaussian-smoothed (sigma 2.5) and gets a ~2 px alpha ramp.
  The panel image gets a copy of the sleeve mesh (same vertices, uv, weights) and is drawn right above the sleeve.
Idempotent (MARK); if the sleeve canvas is already split, the committed panel png is reused."""
from __future__ import annotations
import hashlib, json, re, sys
import numpy as np, cv2
from PIL import Image
import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
SVG = PROJECT / "reference/svg-rig"
MARK = "<!-- ROUND27 coat-split -->"
# boundary polylines (texel y, texel x of the seam); panel side: L x >= seam, R x <= seam
SEAM = {"l": [(90, 150), (130, 165), (170, 180), (210, 190), (230, 188), (260, 178), (300, 166), (340, 152), (352, 148)],
        "r": [(95, 58), (130, 42), (160, 30), (190, 22), (215, 17), (222, 40), (288, 42), (300, 46), (340, 52), (352, 54)]}
TOP = {"l": 90, "r": 95}
HEM = {"l": (356, 120, 225), "r": (356, 0, 106)}      # y>=, x range of the hem tails that belong to the panel
BAND = 10.0
SHADE = 0.66


def mask(side, h=440, w=225):
    """float coverage of the panel: 1 inside, the exact fractional area of the seam pixel on the polyline, 0 outside
    (an anti-aliased cut, so the panel's seam edge is not a pixel staircase when it swings off the sleeve)."""
    pts = SEAM[side]; ys = [p[0] for p in pts]; xs = [p[1] for p in pts]
    M = np.zeros((h, w), float)
    xx = np.arange(w)
    for y in range(TOP[side], 356):
        sx = float(np.interp(y + 0.5, ys, xs))
        M[y] = np.clip(xx + 1 - sx, 0, 1) if side == "l" else np.clip(sx - xx, 0, 1)
    y0, x0, x1 = HEM[side]
    M[y0:, x0:x1] = 1.0
    return M


def over(a, b):
    """a over b, straight alpha uint8 RGBA"""
    a = a.astype(float) / 255; b = b.astype(float) / 255
    ao = a[..., 3:] + b[..., 3:] * (1 - a[..., 3:])
    co = np.where(ao > 0, (a[..., :3] * a[..., 3:] + b[..., :3] * b[..., 3:] * (1 - a[..., 3:])) / np.maximum(ao, 1e-9), 0)
    return np.round(np.concatenate([co, ao], -1) * 255).astype(np.uint8)


def split(side, stats):
    fs, fd, fp = SVG / f"sleeve-{side}-full.png", SVG / f"sleeve-{side}-full-dark.png", SVG / f"coat-{side}-front.png"
    S = np.array(Image.open(fs).convert("RGBA")); D = np.array(Image.open(fd).convert("RGBA"))
    fj = SVG / f"coat-{side}-front.json"
    if fp.exists() and fj.exists() and json.loads(fj.read_text())["split_sha"] == hashlib.sha256(fs.read_bytes()).hexdigest():
        stats[side] = json.loads(fj.read_text()); return
    Mc = mask(side); M = Mc > 0; Mf = Mc >= 1.0
    C = over(S, D)
    C[..., :3] = np.where(C[..., 3:] > 0, C[..., :3], S[..., :3])          # keep the source RGB in transparent texels (filter fringe)
    P = C.copy(); P[..., 3] = np.round(C[..., 3] * Mc).astype(np.uint8)   # RGB kept everywhere, alpha = coverage inside M
    moved_s = int((S[..., 3][Mf] > 0).sum()); moved_d = int((D[..., 3][Mf] > 0).sum())
    seam_px = int(((Mc > 0) & (Mc < 1) & (S[..., 3] > 0)).sum())
    S2 = S.copy(); S2[Mf, 3] = 0; D2 = D.copy(); D2[Mf, 3] = 0     # alpha cleared, RGB kept; seam pixels stay in the sleeve
    part = (Mc > 0) & (Mc < 1)                                    # seam pixels: sleeve alpha s' with a*c + s'(1 - a*c) = a (exact)
    for X, X2 in ((S, S2), (D, D2)):
        a_ = X[..., 3].astype(float) / 255; pc = P[..., 3].astype(float) / 255
        s_ = np.where(pc < 1, np.clip((a_ - pc) / np.maximum(1 - pc, 1e-6), 0, 1), 0)
        X2[part, 3] = np.round(255 * s_[part]).astype(np.uint8)
    solid = (Mf & (P[..., 3] >= 253)) | (~Mf & (S[..., 3] >= 250))                   # the cut seam is not an edge
    ds = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    core = Mf & (ds > 2.0)                                                            # 2 px inside the panel's own silhouette
    core[HEM[side][0]:] = False                                                       # hem-tail lines: no fill under them
    sm = cv2.GaussianBlur(core.astype(np.float32), (0, 0), 2.5)                       # smooth the fill's outer contour
    core = core & (sm > 0.5)
    dc = cv2.distanceTransform(core.astype(np.uint8), cv2.DIST_L2, 5)
    feather = np.clip(dc / 2.0, 0, 1) * np.clip((sm - 0.5) / 0.25, 0, 1)              # ~2 px alpha ramp, no staircase
    near_seam = cv2.distanceTransform((~((~Mf) & (S[..., 3] >= 250))).astype(np.uint8), cv2.DIST_L2, 5) <= 3.0
    feather = np.where(near_seam, 1.0, feather)                                       # never feather at the seam
    src = (~Mf) & (S[..., 3] >= 250)
    dist = cv2.distanceTransform((~src).astype(np.uint8), cv2.DIST_L2, 5)
    band = core & (dist <= BAND); under = core & ~band
    hole = (~src).astype(np.uint8) * 255
    fill = cv2.inpaint(np.ascontiguousarray(S[..., :3][..., ::-1]), hole, 6, cv2.INPAINT_TELEA)[..., ::-1].astype(float)
    sh = np.clip((dist - BAND) / 6.0, 0, 1)[..., None]           # soft shadow ramp from band into the core
    fill = fill * (1 - (1 - SHADE) * sh)
    S2[core, :3] = np.round(fill[core]).astype(np.uint8); S2[core, 3] = np.round(255 * feather[core]).astype(np.uint8)
    Image.fromarray(S2).save(fs, optimize=True); Image.fromarray(D2).save(fd, optimize=True); Image.fromarray(P).save(fp, optimize=True)
    ys, xs = np.nonzero(P[..., 3] > 0)
    st = dict(panel_px=int((P[..., 3] > 0).sum()), panel_bbox=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
              deleted_sleeve_px=moved_s, deleted_dark_px=moved_d, band_px=int(band.sum()), under_px=int(under.sum()), seam_aa_px=seam_px,
              hem_tail_px=int((P[HEM[side][0]:, :, 3] > 0).sum()), split_sha=hashlib.sha256(fs.read_bytes()).hexdigest())
    (SVG / f"coat-{side}-front.json").write_text(json.dumps(st, indent=1))
    stats[side] = st


def license_update(names):
    p = PROJECT / "parts/DETAIL_LICENSE.json"; L = json.loads(p.read_text())
    for f in names:
        b = (PROJECT / f).read_bytes()
        e = L["assets"].setdefault(f, {"ai_generated": False, "in_scene": True})
        e.update(sha256=hashlib.sha256(b).hexdigest(), bytes=len(b), ai_generated=False, in_scene=True)
        if "coat-" in f:
            e["method"] = ("deterministic: coat front panel + hem-tail source pixels moved (not copied) out of "
                           "sleeve-*-full(.dark).png (ROUND27), same canvas as the sleeve")
    if "ROUND27" not in L["note"]:
        L["note"] += (" ROUND27: coat front panels (placket, lining strip, leather trim, hem-tail lines) moved (not copied) from "
                      "sleeve-{l,r}-full(.dark).png into coat-{l,r}-front.png; sleeve under the panel's opaque core backfilled by "
                      "deterministic cv2 Telea inpaint from neighbouring sleeve pixels (10 px seam band + shaded underside).")
    p.write_text(json.dumps(L, indent=2, ensure_ascii=False) + "\n")


def main():
    stats = {}
    for s in "lr":
        split(s, stats)
    scene = SCENE.read_text(encoding="utf-8")
    files = [f"reference/svg-rig/{n}.png" for s in "lr" for n in (f"sleeve-{s}-full", f"sleeve-{s}-full-dark", f"coat-{s}-front")]
    if MARK not in scene:
        nxt = A.Ids(scene, 3000)
        for s in "lr":
            aid = nxt()
            scene = scene.replace(f'<ImageAsset name="fullbody-sleeve-{s}-full-dark"',
                                  f'<ImageAsset name="fullbody-coat-{s}-front" file="reference/svg-rig/coat-{s}-front.png" id="{aid}"/>\n    '
                                  f'<ImageAsset name="fullbody-sleeve-{s}-full-dark"', 1)
            a, b = R8.find_elem(scene, "Image", f"full.sleeve-{s}.full.image")
            tag = scene[a:b]
            tag = re.sub(r'name="sleeve-%s\.' % s, f'name="coat-{s}.front.', tag)
            tag = re.sub(r' id="0:\d+"', lambda m: f' id="{nxt()}"', tag)
            tag = tag.replace(f'name="full.sleeve-{s}.full.image"', f'name="full.coat-{s}.front.image"')
            tag = re.sub(r'assetId="[^"]+"', f'assetId="{aid}"', tag, count=1)
            a2, _ = R8.find_elem(scene, "Solo", f"full.arm-{s}.sleeveSolo")
            scene = scene[:a2] + tag + "\n          " + scene[a2:]
        m = re.search(r'<!-- ROUND26 secondary-skin -->', scene)
        scene = scene[:m.end()] + "\n    " + MARK + scene[m.end():]
        SCENE.write_text(scene, encoding="utf-8")
    license_update(files)
    print(json.dumps(stats))
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round27_coat_split" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round27_coat_split.py\n")


if __name__ == "__main__":
    main()
