#!/usr/bin/env python3
"""ROUND41a — pseudo-3D head yaw rig: cheek strips from original head.png + yaw control bone.

Rest / idle / walk / run stay on the original full.head.image (opacity 1).  Cheek L/C/R pieces (mother
pixels, vertical bands with underlap) sit at opacity 0 and are swapped in only by round41_head_yaw_motion
inside nod / shake / look_lr / look_around.

No ears in the source art (side cut-outs on head.png, no ear assets) — not invented.
Idempotent."""
from __future__ import annotations
import base64, hashlib, json, math, re
from pathlib import Path
import numpy as np
from PIL import Image
import round13_anim as A
import round10_layers as L10
import round8_scene as R8

SCENE = L10.PROJECT / "scene.rml"
RIG = L10.PROJECT / "reference/svg-rig"
LIC = L10.PROJECT / "parts/DETAIL_LICENSE.json"
OL = 12          # underlap px at band seams
TAGS = ("l", "c", "r")


def leb(n):
    o = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        o.append(b | (0x80 if n else 0))
        if not n:
            return bytes(o)


def max_id(s):
    return max(int(x) for x in re.findall(r'id="0:(\d+)"', s))


def head_tex_frame(s):
    a, b = R8.find_elem(s, "Image", "full.head.image")
    t = s[a:b]
    V = [(float(x), float(y), float(u), float(v))
         for x, y, u, v in re.findall(r'MeshVertex x="([-\d.]+)" y="([-\d.]+)" u="([-\d.]+)" v="([-\d.]+)"', t)]
    (x0, y0, u0, v0) = min(V, key=lambda q: q[2] + q[3])
    (x1, y1, u1, v1) = max(V, key=lambda q: q[2] + q[3])
    W, H = Image.open(RIG / "head.png").size
    kx = (x1 - x0) / ((u1 - u0) * W)
    ky = (y1 - y0) / ((v1 - v0) * H)
    bx, by = x0 - kx * u0 * W, y0 - ky * v0 * H
    # head bone bind = identity at (0,0) in head local (image parent is full.head)
    return (kx, ky, bx, by), (W, H)


def split_cheeks(im: np.ndarray):
    """Vertical L/C/R bands of the opaque head silhouette; OL px underlap; original pixels only."""
    al = im[..., 3]
    m = al > 32
    ys, xs = np.where(m)
    x0, x1 = int(xs.min()), int(xs.max())
    w = x1 - x0 + 1
    c1, c2 = x0 + w // 3, x0 + 2 * w // 3
    bands = {
        "l": (x0, c1 + OL),
        "c": (c1 - OL, c2 + OL),
        "r": (c2 - OL, x1),
    }
    out = {}
    H, W = im.shape[:2]
    for tag, (lo, hi) in bands.items():
        rgba = im.copy()
        rgba[:, : max(0, lo), 3] = 0
        rgba[:, min(W, hi + 1):, 3] = 0
        # bone pivot = opaque centroid of OWN band (without underlap preference: center of band)
        mid = (lo + hi) * 0.5
        own = m & (np.arange(W)[None, :] >= lo) & (np.arange(W)[None, :] <= hi)
        yy, xx = np.where(own)
        cx = float(xx.mean()) + 0.5 if len(xx) else mid
        cy = float(yy.mean()) + 0.5 if len(yy) else H * 0.45
        out[tag] = dict(rgba=rgba.astype(np.uint8), px=int((rgba[..., 3] > 32).sum()),
                        lo=lo, hi=hi, cx=cx, cy=cy)
    return out, (x0, x1)


def main():
    s = SCENE.read_text(encoding="utf-8")
    # strip previous R41 rig
    s = re.sub(r'<RootBone name="full\.head\.yaw"[^>]*/>', "", s)
    s = re.sub(r'<RootBone name="full\.head\.cheek\.[lcr]"[^>]*/>', "", s)
    s = re.sub(r'<Image name="full\.head\.cheek\.[lcr]\.image".*?</Image>\n\s*', "", s, flags=re.S)
    s = re.sub(r'<ImageAsset name="fullbody-head-cheek-[lcr]"[^>]*/>\n\s*', "", s)
    ids = A.ids_by_name(s)
    nid = max_id(s) + 1
    (kx, ky, bx, by), (W, H) = head_tex_frame(s)
    im = np.asarray(Image.open(RIG / "head.png").convert("RGBA"))
    cheeks, xr = split_cheeks(im)
    lic = json.loads(LIC.read_text())
    report = {"ears": "absent — head.png side cut-outs, no ear asset; not invented",
              "nose": "baked into head.png (tiny dot), rides cheek/center strips",
              "bands": {}}

    # yaw control bone (x keyed in degrees by the motion bake; unused as a deformer)
    yaw_id = f"0:{nid}"; nid += 1
    hm = re.search(r'<RootBone name="full\.head"[^>]*>', s)
    bones_xml = f'<RootBone name="full.head.yaw" x="0" y="0" rotation="0" length="1" scaleX="1" id="{yaw_id}"/>'
    cheek_bones = {}
    for tag in TAGS:
        ch = cheeks[tag]
        # head-local = texel -> (bx+kx*tx, by+ky*ty); bone under head so local = that (head origin 0)
        lx = bx + kx * ch["cx"]
        ly = by + ky * ch["cy"]
        bid = f"0:{nid}"; nid += 1
        cheek_bones[tag] = (bid, lx, ly)
        bones_xml += (f'<RootBone name="full.head.cheek.{tag}" x="{lx:.4f}" y="{ly:.4f}" rotation="0" '
                      f'length="1" scaleX="1" id="{bid}"/>')
        report["bands"][tag] = dict(lo=ch["lo"], hi=ch["hi"], px=ch["px"],
                                    cx=round(ch["cx"], 1), cy=round(ch["cy"], 1),
                                    local=[round(lx, 2), round(ly, 2)])
    s = s[: hm.end()] + bones_xml + s[hm.end():]
    ids = A.ids_by_name(s)

    # images + assets (opacity 0)
    ins = ""; assets = ""
    for tag in TAGS:
        fn = f"head-cheek-{tag}.png"
        Image.fromarray(cheeks[tag]["rgba"], "RGBA").save(RIG / fn, format="PNG", optimize=False, compress_level=9)
        aid, iid, mid, kid = (f"0:{nid + i}" for i in range(4)); nid += 4
        bid, lx, ly = cheek_bones[tag]
        vx = "".join(
            f'<MeshVertex x="{bx + kx * u * W:.4f}" y="{by + ky * v * H:.4f}" u="{u:.6f}" v="{v:.6f}" '
            f'name="head-cheek-{tag}.v{i}"><Weight values="255" indices="1"/></MeshVertex>'
            for i, (u, v) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))))
        tri = base64.b64encode(b"".join(leb(i) for i in (0, 1, 2, 1, 3, 2))).decode()
        ins += (
            f'<Image name="full.head.cheek.{tag}.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" '
            f'scaleX="1" scaleY="1" opacity="0" id="{iid}">'
            f'<Mesh triangleIndexBytes="{tri}" id="{mid}">{vx}'
            f'<Skin name="head-cheek-{tag}.skin" id="{kid}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">'
            f'<Tendon boneId="{bid}" xx="1" xy="0" yx="0" yy="1" tx="{lx:.4f}" ty="{ly:.4f}" '
            f'name="head-cheek-{tag}.t0"/></Skin></Mesh></Image>\n                    ')
        assets += f'<ImageAsset name="fullbody-head-cheek-{tag}" file="reference/svg-rig/{fn}" id="{aid}"/>\n    '
        p = RIG / fn
        lic["assets"][f"reference/svg-rig/{fn}"] = dict(
            sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size,
            ai_generated=False, in_scene=True,
            method="ROUND41: vertical cheek/face band of head.png (original mother pixels; 12 px underlap at seams)")
    ha, _ = R8.find_elem(s, "Image", "full.head.image")
    s = s[:ha] + ins + s[ha:]
    a = s.find('<ImageAsset name="fullbody-head"')
    s = s[:a] + assets + s[a:]

    SCENE.write_text(s, encoding="utf-8")
    LIC.write_text(json.dumps(lic, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (L10.ROOT / "scripts/rive-complete/round41-head-yaw-rig.json").write_text(
        json.dumps(report, indent=2) + "\n")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round41_head_yaw_rig" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(
            bt.rstrip("\n") + "\npython3 round41_head_yaw_rig.py\n")
    print("ROUND41 yaw rig:", report)


if __name__ == "__main__":
    main()
