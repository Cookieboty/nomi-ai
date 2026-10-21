#!/usr/bin/env python3
"""ROUND42b — wire split head layers into scene.rml.

Draw order (top→bottom inside head stack): …bangs…, cap, face, sidebits, head.image(=neck remainder), eyes…,
hair.l/r, scalp.  Every new layer reuses full.head.image's mesh (same verts/uv/weights) so rest rasterises
identically; tendon t0 retargets from full.head to a per-depth group bone at the same rest transform:
  full.head.g.front  bangs a/b/c (head tendon)          full.head.g.cap   cap (+clip bone keyed directly)
  full.head.g.nose / g.mouth  nose + mouth line from head.png
  full.head.g.face   face + eye-socket fill (pivot = face centre, scaleX)  full.head.g.side  sidebits, locks, hair.l/r, ornament, bow
  full.head.g.scalp  scalp backfill (x = face x, no scale)  full.head.g.back  hair.back.l/r
  sidebits (hair strands baked in head.png) ride g.cap so cap/strand borders never tear
Idempotent (MARK)."""
from __future__ import annotations
import re, json
import round10_layers as L10
import round8_scene as R8
import round41_head_yaw_rig as R41
from round42_head_layers import split

SCENE = L10.PROJECT / "scene.rml"
MARK = "full.head.g.front"
FACE_CX_PX = 250.0
GROUPS = ("front", "cap", "nose", "mouth", "face", "side", "scalp", "back")
SIDE_IMGS = ("full.hair.lock.l.image", "full.hair.lock.r.image", "full.hair.l.image", "full.hair.r.image",
             "full.hair.ornament.l.image", "full.hair.bow.image")
BACK_IMGS = ("full.hair.back.l.image", "full.hair.back.r.image")
FRONT_IMGS = ("full.bangs.a.image", "full.bangs.b.image", "full.bangs.c.image")


def main():
    meta = split()
    s = SCENE.read_text(encoding="utf-8")
    (kx, ky, bx, by), _ = R41.head_tex_frame(s)
    face_cx = bx + kx * FACE_CX_PX
    hid = re.search(r'<RootBone name="full\.head"[^>]*id="(0:\d+)"', s).group(1)
    if MARK not in s:
        nid = [R41.max_id(s)]
        def new():
            nid[0] += 1; return f"0:{nid[0]}"
        gid = {g: new() for g in GROUPS}
        bones = "".join(
            f'<RootBone name="full.head.g.{g}" x="{face_cx if g == "face" else 0:.4f}" y="0" rotation="0" length="1" '
            f'scaleX="1" id="{gid[g]}"/>' for g in GROUPS)
        m = re.search(r'<RootBone name="full\.head\.yaw"[^>]*/>', s)
        s = s[:m.end()] + bones + s[m.end():]
        # assets
        aid = {}
        at = re.search(r'<ImageAsset name="fullbody-head" file="reference/svg-rig/head.png" id="0:9207"/>', s)
        add = ""
        for k in ("clipres", "cap", "nose", "mouth", "face", "socket", "sidebits", "neck", "scalp"):
            aid[k] = new()
            add += f'\n    <ImageAsset name="fullbody-head-{k}" file="reference/svg-rig/head-{k}.png" id="{aid[k]}"/>'
        s = s[:at.end()] + add + s[at.end():]
        a, b = R8.find_elem(s, "Image", "full.head.image")
        base = s[a:b]
        def clone(tag, asset, bone, tx):
            t = base.replace("full.head.image", f"full.head.{tag}.image")
            t = re.sub(r'assetId="[^"]+"', f'assetId="{asset}"', t, count=1)
            t = re.sub(r'\bid="0:\d+"', lambda _: f'id="{new()}"', t)
            t = re.sub(rf'<Tendon boneId="{hid}"([^>]*?)tx="[^"]+"', 
                       lambda mm: f'<Tendon boneId="{bone}"{mm.group(1)}tx="{tx:.4f}"', t, count=1)
            return t
        cap = clone("cap", aid["cap"], gid["cap"], 0.0)
        clipres = clone("clipres", aid["clipres"], gid["front"], 0.0)  # white clip backing under the N clip baked in bangs.c
        nose = clone("nose", aid["nose"], gid["nose"], 0.0)
        mouthl = clone("mouthline", aid["mouth"], gid["mouth"], 0.0)
        socket = clone("socket", aid["socket"], gid["face"], face_cx)
        face = clone("face", aid["face"], gid["face"], face_cx)
        side = clone("sidebits", aid["sidebits"], gid["cap"], 0.0)  # hanging strands ride with the cap (no tear)
        scalp = clone("scalp", aid["scalp"], gid["scalp"], 0.0)  # follows face x, never scaled
        neck = re.sub(r'assetId="[^"]+"', f'assetId="{aid["neck"]}"', base, count=1)
        s = s[:a] + clipres + cap + nose + mouthl + face + side + neck + s[b:]
        a, b = R8.find_elem(s, "Image", "full.hair.r.image")
        s = s[:b] + socket + scalp + s[b:]
        for names, g in ((SIDE_IMGS, "side"), (FRONT_IMGS, "front"), (BACK_IMGS, "back")):
            for n in names:
                a, b = R8.find_elem(s, "Image", n)
                t = s[a:b]
                t2 = t.replace(f'<Tendon boneId="{hid}"', f'<Tendon boneId="{gid[g]}"', 1)
                assert t2 != t, n
                s = s[:a] + t2 + s[b:]
        # full.mouth.image (mouth.png, smile line + baked cheek skin) is skinned to full.head, not to its bone:
        # left static it showed as a pale streak beside the moving face.  It rides the mouth group.
        a, b = R8.find_elem(s, "Image", "full.mouth.image")
        t = s[a:b]
        t2 = re.sub(rf'<Tendon boneId="{hid}"([^>]*?)tx="[^"]+"',
                    lambda mm: f'<Tendon boneId="{gid["mouth"]}"{mm.group(1)}tx="0.0000"', t, count=1)
        assert t2 != t
        s = s[:a] + t2 + s[b:]
        SCENE.write_text(s, encoding="utf-8")
    import hashlib
    d = json.loads(R41.LIC.read_text())
    for k in ("clipres", "cap", "nose", "mouth", "face", "socket", "sidebits", "neck", "scalp"):
        f = R41.RIG / f"head-{k}.png"
        bb = f.read_bytes()
        d["assets"][f"reference/svg-rig/head-{k}.png"] = {
            "sha256": hashlib.sha256(bb).hexdigest(), "bytes": len(bb), "ai_generated": False, "in_scene": True,
            "method": "ROUND42: per-pixel layer split of head.png (original mother pixels); backfill only under "
                      "opaque px — forehead Telea from face skin, neck mirror of neck skin, scalp per-column "
                      "reflection of cap hair band"}
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND42b head rig", {"face_cx": round(face_cx, 3), **{k: v["px"] for k, v in meta.items() if isinstance(v, dict) and "px" in v}})


if __name__ == "__main__":
    main()
