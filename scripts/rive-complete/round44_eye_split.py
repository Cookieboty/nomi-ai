#!/usr/bin/env python3
"""ROUND44a — free the eyes from the face skin.

eye-l.png / eye-r.png (full.eye.l/r, drawn BELOW the head stack) are not eyes: they are a large baked
cheek-skin + strand patch that shows through a cheek-shaped hole in head.png.  R44a:
  1. merges every eye-l/r texel that no layer between head.face and eye.l/r covers (sidebits, neck,
     eye2.* parts, mouth) into head-face (original pixels, composited under the face texel exactly
     as at rest) -> eye-l/r-r44.png keep only the covered remainder;
  2. cuts an eye-zone patch (original face pixels within EYE_M texels of the eye2 parts, feathered
     over the outer 3 texels) into head-eyezone.png, drawn just above head-face on bone
     full.head.g.eyes, so eyelid contour + surrounding skin travel with the eyes;
  3. clears head-face only in the inner ring (<= CLEAR texels from the eye parts), which the eye
     zone always covers for |offset| <= EYE_M-3-CLEAR px; outside it head-face keeps original skin,
     so any skin revealed behind a moving eye zone is the master's own pixels (no synthetic fill).
Idempotent (MARK).  Runs after round42_head_rig."""
from __future__ import annotations
import re, json, hashlib
import xml.etree.ElementTree as ET
import numpy as np, cv2
from PIL import Image
import round10_layers as L10
import round8_scene as R8
import round41_head_yaw_rig as R41

SCENE = L10.PROJECT / "scene.rml"
RIG = R41.RIG
MARK = "full.head.g.eyes"
EYE_M, CLEAR = 10, 5   # zone covers the clear ring for |eye offset| <= EYE_M - CLEAR - 1 px
SMOOTH = 60   # max 3x3 channel range of eye-l px allowed to merge (edges stay in eye-l: sub-texel AA)
EYE_PARTS = ("lash", "lid", "hl", "iris", "sclera")


def placements(s):
    root = ET.fromstring(s)
    par = {c: p for p in root.iter() for c in p}
    out = {}
    for e in root.iter("Image"):
        n = e.get("name", "")
        if not (n.startswith("full.eye")):
            continue
        x, y = float(e.get("x", 0)), float(e.get("y", 0)); p = par[e]
        while p.get("name") != "full.head":
            x += float(p.get("x", 0)); y += float(p.get("y", 0)); p = par[p]
        out[n] = (x, y, float(e.get("scaleX", 1)), e.get("assetId"))
    return out


def asset_file(s, aid):
    return re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{aid}"/>', s).group(1)


def paste(canvas_hw, img, x, y, k, frame):
    (kx, ky, bx, by) = frame
    u, v = (x - bx) / kx, (y - by) / ky
    assert abs(k - kx) < 1e-4 and abs(u - round(u)) < 0.02 and abs(v - round(v)) < 0.02, (u, v, k)
    u, v = int(round(u)), int(round(v))
    H, W = canvas_hw
    out = np.zeros((H, W, 4), np.uint8)
    h, w = img.shape[:2]
    out[v:v + h, u:u + w] = img[:max(0, min(h, H - v)), :max(0, min(w, W - u))]
    return out, (u, v)


def over(top, bot):
    ta, ba = top[..., 3:4] / 255.0, bot[..., 3:4] / 255.0
    oa = ta + ba * (1 - ta)
    oc = (top[..., :3] * ta + bot[..., :3] * ba * (1 - ta)) / np.maximum(oa, 1e-6)
    return np.concatenate([oc, oa * 255], -1).round().clip(0, 255).astype(np.uint8)


def build(s):
    frame, (W, H) = R41.head_tex_frame(s)
    P = placements(s)
    load = lambda f: np.array(Image.open(L10.PROJECT / f).convert("RGBA"))
    face = np.array(Image.open(RIG / "head-face.png").convert("RGBA"))
    cover = np.zeros((H, W), bool)
    for f in ("head-sidebits.png", "head-neck.png"):
        cover |= np.array(Image.open(RIG / f).convert("RGBA"))[..., 3] > 0
    parts = {}
    for sd in "lr":
        core = np.zeros((H, W), bool)
        for pt in EYE_PARTS + ("skin",):
            x, y, k, aid = P[f"full.eye2.{sd}.{pt}.image"]
            lay, _ = paste((H, W), load(asset_file(s, aid)), x, y, k, frame)
            cover |= lay[..., 3] > 0
            if pt != "skin":
                core |= lay[..., 3] > 0
        parts[sd] = core
    # mouth.png (mesh under full.mouth): conservative bbox exclusion
    mt = s[s.find('name="full.mouth.image"'):]
    mt = mt[:mt.find("</Image>")]
    V = np.array([(float(a), float(b)) for a, b in re.findall(r'MeshVertex x="([-\d.]+)" y="([-\d.]+)"', mt)])
    my = float(re.search(r'<RootBone name="full\.mouth"[^>]*\by="([-\d.]+)"', s).group(1))
    (kx, ky, bx, by) = frame
    u0, u1 = int((V[:, 0].min() - bx) / kx) - 2, int((V[:, 0].max() - bx) / kx) + 2
    v0, v1 = int((V[:, 1].min() + my - by) / ky) - 2, int((V[:, 1].max() + my - by) / ky) + 2
    cover[max(v0, 0):v1, max(u0, 0):u1] = True
    rem, merged, lays = {}, 0, {}
    for sd in "lr":
        x, y, k, aid = P[f"full.eye.{sd}.image"]
        src = load(asset_file(s, aid))
        lay, (u, v) = paste((H, W), src, x, y, k, frame)
        k5 = np.ones((5, 5), np.uint8)
        fa = face[..., 3]
        clean = (fa == 0) | (fa >= 250)
        # merge only interior texels (opaque eye px, uncovered, face fully clear or fully opaque in the
        # 5x5 bilinear footprint) so filtering at the merge border stays identical to rest
        g = lay[..., :3].astype(np.int16)
        k3 = np.ones((3, 3), np.uint8)
        rng = (cv2.dilate(g.max(2).astype(np.uint8), k3).astype(np.int16) - cv2.erode(g.min(2).astype(np.uint8), k3))
        smooth = rng <= SMOOTH  # image vs mesh sampling differ by a sub-texel phase: merge only flat skin
        mv = smooth & (cv2.erode(((lay[..., 3] >= 250) & ~cover).astype(np.uint8), k5) > 0) & (cv2.erode(clean.astype(np.uint8), k5) > 0)
        bleed = (face[..., 3] == 0) & (lay[..., 3] > 0)  # transparent face texels carry eye rgb (no dark fringe)
        face[bleed, :3] = lay[bleed, :3]
        face[mv] = over(face[mv][None], lay[mv][None])[0]
        merged += int(mv.sum())
        lays[sd] = (lay, u, v, src.shape)
        keep = lay.copy(); keep[cv2.erode(mv.astype(np.uint8), k5) > 0, 3] = 0  # 2-texel duplicate ring stays; rgb kept (alpha 0)
        rem[sd] = keep[v:v + src.shape[0], u:u + src.shape[1]]
    # eye zone: hard-edged patch of original face px within EYE_M of the eye window; opaque skin is
    # forced to alpha 255 so the face copy kept underneath (the reveal backfill = master's own skin)
    # never shows at rest; semi-transparent texels live only in the zone (no double composite).
    core = parts["l"] | parts["r"]
    bb = cv2.dilate(core.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    # window = eye2 parts footprint + the face's own AA rim around it (not the empty strand gaps near the
    # face outline, which must stay with the face)
    win = core | (bb & (face[..., 3] > 0) & (face[..., 3] < 250))
    D = cv2.distanceTransform((~win).astype(np.uint8), cv2.DIST_L2, 5)
    inz = (D <= EYE_M) & (face[..., 3] > 0)
    # semi-transparent face texels away from the window (outline AA, strand gaps) stay ONLY in the face
    # (zone leaves them out) so a moving zone never leaves an un-backed hole there
    inz &= (face[..., 3] >= 250) | (D <= CLEAR)
    zone = np.zeros_like(face)
    zone[inz] = face[inz]
    op = inz & (cv2.erode((face[..., 3] >= 250).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)  # not at a layer border
    zone[op, 3] = 255
    # eye-l/r texels seen through the window (lower-lash marks etc. baked in the cheek patch) must ride
    # with the eyes: duplicated (opaque only) into head-eyeback.png, drawn just under the eye2 parts
    eyeback = np.zeros_like(face)
    for sd in "lr":
        lay = lays[sd][0]
        sel = (D <= CLEAR) & (cv2.erode((lay[..., 3] >= 250).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        eyeback[sel] = lay[sel]
    moved = int((eyeback[..., 3] > 0).sum())
    face2 = face.copy()
    face2[inz & ~op] = 0
    face2[D <= CLEAR] = 0
    return face2, zone, eyeback, rem, dict(eyeback_px=moved, merged_cheek_px=merged, zone_px=int((zone[..., 3] > 0).sum()),
                                  cleared_px=int(((D <= CLEAR) & (face[..., 3] > 0)).sum()))


def main():
    s = SCENE.read_text(encoding="utf-8")
    face2, zone, eyeback, rem, meta = build(s)
    outs = {"head-face-r44.png": face2, "head-eyezone.png": zone, "head-eyeback.png": eyeback,
            "eye-l-r44.png": rem["l"], "eye-r-r44.png": rem["r"]}
    for f, a in outs.items():
        Image.fromarray(a, "RGBA").save(RIG / f)
    if MARK not in s:
        nid = [R41.max_id(s)]
        def new():
            nid[0] += 1; return f"0:{nid[0]}"
        gid, zaid, zimg = new(), new(), None
        m = re.search(r'<RootBone name="full\.head\.g\.face"[^>]*/>', s)
        s = s[:m.end()] + f'<RootBone name="full.head.g.eyes" x="0.0000" y="0" rotation="0" length="1" scaleX="1" id="{gid}"/>' + s[m.end():]
        at = re.search(r'<ImageAsset name="fullbody-head-face" file="reference/svg-rig/head-face.png" id="(0:\d+)"/>', s)
        s = s[:at.start()] + at.group(0).replace("head-face.png", "head-face-r44.png") + \
            f'\n    <ImageAsset name="fullbody-head-eyezone" file="reference/svg-rig/head-eyezone.png" id="{zaid}"/>' + s[at.end():]
        for sd in "lr":
            s = re.sub(rf'(<ImageAsset [^>]*file="reference/svg-rig/)eye-{sd}\.png(")', rf'\1eye-{sd}-r44.png\2', s, count=1)
        a, b = R8.find_elem(s, "Image", "full.head.face.image")
        base = s[a:b]
        hid_face = re.search(r'<RootBone name="full\.head\.g\.face"[^>]*id="(0:\d+)"', s).group(1)
        t = base.replace("full.head.face.image", "full.head.eyezone.image")
        t = re.sub(r'assetId="[^"]+"', f'assetId="{zaid}"', t, count=1)
        t = re.sub(r'\bid="0:\d+"', lambda _: f'id="{new()}"', t)
        t, n = re.subn(rf'<Tendon boneId="{hid_face}"([^>]*?)tx="[^"]+"',
                       lambda mm: f'<Tendon boneId="{gid}"{mm.group(1)}tx="0.0000"', t, count=1)
        assert n == 1
        s = s[:a] + t + s[a:]
        bid = new()
        at = re.search(r'<ImageAsset name="fullbody-head-eyezone"[^>]*/>', s)
        s = s[:at.end()] + f'\n    <ImageAsset name="fullbody-head-eyeback" file="reference/svg-rig/head-eyeback.png" id="{bid}"/>' + s[at.end():]
        t2 = t.replace("full.head.eyezone.image", "full.head.eyeback.image")
        t2 = re.sub(r'assetId="[^"]+"', f'assetId="{bid}"', t2, count=1)
        t2 = re.sub(r'\bid="0:\d+"', lambda _: f'id="{new()}"', t2)
        a2, b2 = R8.find_elem(s, "Image", "full.eye2.r.skin.image")
        s = s[:b2] + t2 + s[b2:]
        SCENE.write_text(s, encoding="utf-8")
    d = json.loads(R41.LIC.read_text())
    for f in outs:
        bb = (RIG / f).read_bytes()
        d["assets"][f"reference/svg-rig/{f}"] = {
            "sha256": hashlib.sha256(bb).hexdigest(), "bytes": len(bb), "ai_generated": False, "in_scene": True,
            "method": "ROUND44a: eye-l/r cheek patch merged into head-face (original px, rest composite); "
                      "eye-zone patch of original face px around eye2 parts (feathered) rides g.eyes"}
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND44a eye split", meta)


if __name__ == "__main__":
    main()
