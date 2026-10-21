#!/usr/bin/env python3
"""ROUND38 - hybrid fist: bones curl the original hand pieces to ~60 %, then the dedicated closed-fist art
(hand-{l,r}-fist.png, round38_fist_art.py) cross-fades in at full grip and the finger pieces fade out.

* Art: deterministic procedural textures in the hand-crop frame (same texel size 0.8464, same palette / 1 px outline).
* full.hand-{l,r}.fist.image: quad Mesh skinned 100 % to full.arm-{s}.hand with the palm's own hand tendon (same bind
  matrix as hand-{s}-palm), declared directly BEFORE full.hand-{s}.palm.image (first declared draws on top), i.e. under
  the cuff and above every hand piece -> R37b pouch DrawRules (pouch after hand-r.thumb) still puts the pouch under it.
  Default opacity 0 -> idle / walk / every other clip draw exactly as before.
* full.fist + full.run: finger rotation keys follow the original curl up to 60 % of the grip and hold there (value x min(1, 0.6/c)); curl fraction c(f) (run: run envelope,
  fist: index.1 track / its grip value); fist opacity = smoothstep((c-0.6)/0.3), hand pieces = 1 - smoothstep((c-0.85)/0.15).
  Both clips end at c=0 -> fist 0 / pieces 1 on the last frame.
Idempotent: strips its own assets / images / opacity keys; the finger rescale is applied once (skipped when the fist images already exist)."""
from __future__ import annotations
import re
import round13_anim as A
import round10_layers as L10
import round8_scene as R8
import round26_gait as G
import round38_fist_art as ART

SCENE = L10.PROJECT / "scene.rml"
RIG = L10.PROJECT / "reference/svg-rig"
FING = ("thumb", "index", "middle", "ring", "little")
SEGS = ("", ".1", ".2")
PIECES = ("palm", "web", "little", "ring", "middle", "index", "thumb")
CURL = 0.6


def ss(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)


def max_id(s):
    return max(int(x) for x in re.findall(r'id="0:(\d+)"', s))


def leb(n):
    o = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        o.append(b | (0x80 if n else 0))
        if not n:
            return bytes(o)


def update_license():
    import hashlib, json
    lp = L10.PROJECT / "parts/DETAIL_LICENSE.json"
    lic = json.load(open(lp))
    for sd in "lr":
        p = RIG / f"hand-{sd}-fist.png"
        lic["assets"][f"reference/svg-rig/hand-{sd}-fist.png"] = dict(
            sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size, ai_generated=False, in_scene=True,
            method="ROUND38: deterministic procedural closed-fist drawing (scripts/rive-complete/round38_fist_art.py, no RNG, "
                   "no external or AI imagery); palette and 1 px outline sampled from hand-l-palm.png; "
                   + ("screen-left hand" if sd == "l" else "exact horizontal mirror for the screen-right hand"))
    tag = "ROUND38 fist:"
    if tag not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND38 fist: hand-{l,r}-fist.png are procedurally drawn closed-fist textures "
                       "(not cut from the mother), cross-faded in by full.fist / full.run at full grip.").strip()
    lp.write_text(json.dumps(lic, indent=2) + "\n")


def main():
    import base64
    ART.build(RIG)
    update_license()
    s = SCENE.read_text(encoding="utf-8")
    scaled = 'name="full.hand-l.fist.image"' in s     # already processed -> finger tracks already x0.6
    # ---- strip own state
    old_fist = set(re.findall(r'<Image name="full\.hand-[lr]\.fist\.image"[^>]*\bid="(0:\d+)"', s))
    s = re.sub(r'<ImageAsset name="fullbody-hand-[lr]-fist"[^>]*/>\n    ', "", s)
    s = re.sub(r'<Image name="full\.hand-[lr]\.fist\.image".*?</Image>\n {20}', "", s, flags=re.S)
    ids = A.ids_by_name(s)
    op_ids = {ids[f"full.hand-{sd}.{p}.image"] for sd in "lr" for p in PIECES} | old_fist
    s = re.sub(r'\s*<KeyedObject objectId="(0:\d+)"><KeyedProperty property="opacity">(?:<KeyFrameDouble [^>]*/>)*</KeyedProperty></KeyedObject>',
               lambda k: "" if k.group(1) in op_ids else k.group(0), s)
    nid = max_id(s) + 1
    fist_id = {}
    for sd in "lr":
        W, H = (59, 93) if sd == "l" else (59, 90)
        pa, pb = R8.find_elem(s, "Image", f"full.hand-{sd}.palm.image")
        palm = s[pa:pb]
        V = [(float(x), float(y), float(u), float(v)) for x, y, u, v in
             re.findall(r'MeshVertex x="([-\d.]+)" y="([-\d.]+)" u="([-\d.]+)" v="([-\d.]+)"', palm)]
        # affine texel->rig from the palm rest mesh (exact: scale 0.8464, no rotation)
        (x0, y0, u0, v0), (x1, y1, u1, v1) = min(V, key=lambda t: t[2] + t[3]), max(V, key=lambda t: t[2] + t[3])
        kx = (x1 - x0) / (u1 - u0); ky = (y1 - y0) / (v1 - v0)
        bx = x0 - kx * u0; by = y0 - ky * v0
        ten = re.search(r'<Tendon boneId="(0:\d+)"[^>]*name="full\.hand-' + sd + r'\.palm\.t0"/>', palm).group(0)
        ten = ten.replace(f'name="full.hand-{sd}.palm.t0"', f'name="full.hand-{sd}.fist.t0"')
        aid, iid, mid, kid = (f"0:{nid + i}" for i in range(4)); nid += 4
        fist_id[sd] = iid
        vx = "".join(f'<MeshVertex x="{bx + kx * u:.4f}" y="{by + ky * v:.4f}" u="{u:.6f}" v="{v:.6f}" name="hand-{sd}-fist.v{i}">'
                     '<Weight values="255" indices="1"/></MeshVertex>' for i, (u, v) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))))
        tri = base64.b64encode(b"".join(leb(i) for i in (0, 1, 2, 1, 3, 2))).decode()
        img = (f'<Image name="full.hand-{sd}.fist.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" opacity="0" id="{iid}">'
               f'<Mesh triangleIndexBytes="{tri}" id="{mid}">{vx}<Skin name="hand-{sd}-fist.skin" id="{kid}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">{ten}</Skin></Mesh></Image>\n                    ')
        s = s[:pa] + img + s[pa:]
        a = s.find('<ImageAsset name="fullbody-hand-l-palm"')
        s = s[:a] + f'<ImageAsset name="fullbody-hand-{sd}-fist" file="reference/svg-rig/hand-{sd}-fist.png" id="{aid}"/>\n    ' + s[a:]
    ids = A.ids_by_name(s)
    an = A.animations(s)
    fing_ids = {ids[f"full.arm-{sd}.{fg}{sg}"] for sd in "lr" for fg in FING for sg in SEGS}
    for clip in ("full.fist", "full.run"):
        m = re.search(r'(<LinearAnimation name="' + re.escape(clip) + r'"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
        dur = int(m.group(2)); body = m.group(3)
        if clip == "full.fist":
            ref = an[clip][1][ids["full.arm-l.index.1"]]["rotation"]
            grip = A.eval_track(ref, 16)
            c = lambda f: min(1.0, max(0.0, A.eval_track(ref, f) / grip))
        else:
            c = lambda f: G.run_frame(f)["env"]
        if not scaled:
            def sc(k):
                if k.group(1) not in fing_ids:
                    return k.group(0)
                # bones follow the original curl while c <= CURL, then hold at CURL x full grip (the art takes over)
                def one(kf):
                    v, f = float(kf.group(1)), float(kf.group(2)); cf = c(f)
                    return kf.group(0).replace(kf.group(1), f"{v * min(1.0, CURL / cf) if cf > 1e-9 else v:.6f}", 1)
                return re.sub(r'<KeyFrameDouble value="([-\d.eE+]+)" frame="([\d.]+)"', one, k.group(0))
            body = re.sub(r'<KeyedObject objectId="(0:\d+)"><KeyedProperty property="rotation">.*?</KeyedProperty></KeyedObject>', sc, body, flags=re.S)
        frames = sorted(set(range(0, dur + 1, 2)) | {dur})
        kf = lambda fn: "".join(f'<KeyFrameDouble value="{fn(f):.6f}" frame="{f}" interpolationType="linear"/>' for f in frames)
        add = []
        for sd in "lr":
            add.append(f'\n            <KeyedObject objectId="{fist_id[sd]}"><KeyedProperty property="opacity">{kf(lambda f: ss((c(f) - 0.6) / 0.3))}</KeyedProperty></KeyedObject>')
            for p in PIECES:
                add.append(f'\n            <KeyedObject objectId="{ids[f"full.hand-{sd}.{p}.image"]}"><KeyedProperty property="opacity">{kf(lambda f: 1 - ss((c(f) - 0.85) / 0.15))}</KeyedProperty></KeyedObject>')
        s = s[:m.start(3)] + body + "".join(add) + s[m.end(3):]
        an = A.animations(s)
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round38_fist_swap" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip("\n") + "\npython3 round38_fist_swap.py\n")
    print(f"ROUND38 fist swap: fist images {fist_id}, curl x{CURL} ({'already scaled' if scaled else 'scaled'})")


if __name__ == "__main__":
    main()
