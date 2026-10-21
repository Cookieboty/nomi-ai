#!/usr/bin/env python3
"""ROUND48 — split mouth: upper/lower from original smile + cavity in the gap.

Images are FLAT siblings under full.head (nested Image-under-bone does not draw).
Rest/M use original mouthline. Open: hide mouthline, show lips + cavity, key Image y.
Idempotent (MARK full.mouth.split).
"""
from __future__ import annotations
import re, json, hashlib
from pathlib import Path
import round10_layers as L10
import round8_scene as R8
import round41_head_yaw_rig as R41
import round43_face_yaw_motion as M43
import round44_eye_yaw_motion as M44  # noqa: F401

SCENE = L10.PROJECT / "scene.rml"
MARK = "full.mouth.split"
META = json.loads(Path(__file__).with_name("mouth-split-r48.json").read_text())
VISEMES = ("a", "i", "u", "e", "o", "m")
OPEN = {
    # upper_dy, lower_dy, cavity_opacity, scaleX_delta, cavity_scaleY
    # lip gap sized to cavity; cavity_sy stretches interior to seal between lips
    "a": (-3.4, 5.4, 1.0, 0.02, 1.12),
    "i": (-1.6, 2.8, 0.98, 0.12, 1.02),
    "u": (-2.8, 4.2, 1.0, -0.12, 1.08),
    "e": (-2.2, 3.4, 0.98, 0.08, 1.04),
    "o": (-3.6, 5.2, 1.0, -0.08, 1.12),
    "m": (0.0, 0.0, 0.0, 0.0, 1.0),
}
JAW = {"a": 4.2, "i": 2.4, "u": 3.2, "e": 2.8, "o": 4.5, "m": 0.0}
MARK_KF = "<!--r48mouth-->"


def next_ids(s, n):
    m = R41.max_id(s)
    return [f"0:{m + 1 + i}" for i in range(n)]


def ids_by_name(s):
    out = {}
    for m in re.finditer(r'<(?:RootBone|Image|Bone|Node) name="([^"]+)"[^>]*\bid="(0:\d+)"', s):
        out[m.group(1)] = m.group(2)
    return out


def strip_mouth_keys(body):
    for mk in (MARK_KF, "<!--r47mouth-->", "<!--r46mouth-->", "<!--r45mouth-->"):
        body = re.sub(
            rf'\s*<KeyedObject objectId="0:\d+">\s*{re.escape(mk)}.*?</KeyedObject>',
            "", body, flags=re.S)
    return body


def main():
    s = SCENE.read_text(encoding="utf-8")
    if MARK in s and "full.mouth.upper.image" in s:
        print("ROUND48 already wired — re-run keys only via rebuild path")
        # still allow re-entry by stripping mark bone and redoing — for simplicity require clean R47
        raise SystemExit("scene already has R48; reset to R47 scene first")

    (kx, ky, bx, by), _ = R41.head_tex_frame(s)
    x0, y0, _, _ = META["upper"]["bbox"]
    ix, iy = bx + kx * x0, by + ky * y0
    ids = next_ids(s, 30)
    take = lambda: ids.pop(0)
    asset_u, asset_l, asset_c = take(), take(), take()
    bone_split, bone_u, bone_l = take(), take(), take()
    img_u, img_l, img_c = take(), take(), take()

    at = re.search(r'<ImageAsset name="fullbody-head-mouth"[^>]*>', s)
    s = s[:at.end()] + (
        f'\n    <ImageAsset name="fullbody-mouth-split-upper" file="reference/svg-rig/mouth-split-upper.png" id="{asset_u}"/>'
        f'\n    <ImageAsset name="fullbody-mouth-split-lower" file="reference/svg-rig/mouth-split-lower.png" id="{asset_l}"/>'
        f'\n    <ImageAsset name="fullbody-mouth-split-cavity" file="reference/svg-rig/mouth-split-cavity.png" id="{asset_c}"/>'
    ) + s[at.end():]

    block = (
        f'<RootBone name="{MARK}" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_split}"/>'
        f'<RootBone name="full.mouth.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_u}"/>'
        f'<RootBone name="full.mouth.lower" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_l}"/>'
        f'<Image name="full.mouth.upper.image" assetId="{asset_u}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_u}"/>'
        f'<Image name="full.mouth.lower.image" assetId="{asset_l}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_l}"/>'
        f'<Image name="full.mouth.cavity.image" assetId="{asset_c}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_c}"/>'
    )
    _, b = R8.find_elem(s, "Image", "full.head.mouthline.image")
    s = s[:b] + block + s[b:]

    idsmap = ids_by_name(s)
    mouthline_id = idsmap["full.head.mouthline.image"]
    g_id = idsmap["full.head.g.mouth"]
    mb_id = idsmap["full.mouth"]
    old_vis = {v: idsmap.get(f"full.mouth.viseme.{v}.image") for v in VISEMES}
    g_y0 = float(re.search(r'<RootBone name="full\.head\.g\.mouth"[^>]*\by="([-\d.]+)"', s).group(1))
    mb_y0 = float(re.search(r'<RootBone name="full\.mouth"[^>]*\by="([-\d.]+)"', s).group(1))

    def kf_op(oid, frames):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK_KF}<KeyedProperty property="opacity">'
        body += "".join(f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="hold"/>' for f, v in frames)
        return body + "</KeyedProperty></KeyedObject>"

    def kf_y(oid, frames):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK_KF}<KeyedProperty property="y">'
        body += "".join(
            f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.4" y1="0" x2="0.6" y2="1"/></KeyFrameDouble>'
            for f, v in frames)
        return body + "</KeyedProperty></KeyedObject>"

    def kf_sx(oid, frames):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK_KF}<KeyedProperty property="scaleX">'
        body += "".join(
            f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.4" y1="0" x2="0.6" y2="1"/></KeyFrameDouble>'
            for f, v in frames)
        return body + "</KeyedProperty></KeyedObject>"

    def kf_sy(oid, frames):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK_KF}<KeyedProperty property="scaleY">'
        body += "".join(
            f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.4" y1="0" x2="0.6" y2="1"/></KeyFrameDouble>'
            for f, v in frames)
        return body + "</KeyedProperty></KeyedObject>"

    def rebuild(s, name, builder):
        m = re.search(rf'(<LinearAnimation name="{re.escape(name)}"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
        return s[:m.start(2)] + strip_mouth_keys(m.group(2)) + builder() + s[m.end(2):]

    def build_rest():
        add = kf_op(mouthline_id, [(0, 1.0)])
        add += kf_op(img_u, [(0, 0.0)]) + kf_op(img_l, [(0, 0.0)]) + kf_op(img_c, [(0, 0.0)])
        for v in VISEMES:
            if old_vis[v]:
                add += kf_op(old_vis[v], [(0, 0.0)])
        add += kf_y(img_u, [(0, iy)]) + kf_y(img_l, [(0, iy)]) + kf_y(img_c, [(0, iy)])
        add += kf_sx(img_u, [(0, kx)]) + kf_sx(img_l, [(0, kx)])
        add += kf_sy(img_c, [(0, ky)])
        add += kf_y(g_id, [(0, g_y0)]) + kf_y(mb_id, [(0, mb_y0)])
        return add

    s = rebuild(s, "full.mouth_rest", build_rest)

    for v in VISEMES:
        udy, ldy, cop, sxd, csy = OPEN[v]
        jaw = JAW[v]

        def build(v=v, udy=udy, ldy=ldy, cop=cop, sxd=sxd, csy=csy, jaw=jaw):
            add = ""
            if v == "m":
                add += kf_op(mouthline_id, [(0, 1.0)])
                add += kf_op(img_u, [(0, 0.0)]) + kf_op(img_l, [(0, 0.0)]) + kf_op(img_c, [(0, 0.0)])
                add += kf_y(img_u, [(0, iy)]) + kf_y(img_l, [(0, iy)]) + kf_y(img_c, [(0, iy)])
                add += kf_sx(img_u, [(0, kx)]) + kf_sx(img_l, [(0, kx)])
                add += kf_sy(img_c, [(0, ky)])
            else:
                add += kf_op(mouthline_id, [(0, 0.0)])
                add += kf_op(img_u, [(0, 1.0)]) + kf_op(img_l, [(0, 1.0)]) + kf_op(img_c, [(0, cop)])
                add += kf_y(img_u, [(0, iy + udy)]) + kf_y(img_l, [(0, iy + ldy)]) + kf_y(img_c, [(0, iy)])
                add += kf_sx(img_u, [(0, kx * (1.0 + sxd))]) + kf_sx(img_l, [(0, kx * (1.0 + sxd))])
                add += kf_sy(img_c, [(0, ky * csy)])
            for w in VISEMES:
                if old_vis[w]:
                    add += kf_op(old_vis[w], [(0, 0.0)])
            add += kf_y(g_id, [(0, g_y0 + jaw)]) + kf_y(mb_id, [(0, mb_y0 + jaw * 0.65)])
            return add

        s = rebuild(s, f"full.viseme_{v}", build)

    order = ["rest", *VISEMES, "rest"]

    def build_talk():
        add = kf_op(mouthline_id, [(i * 10, 1.0 if n in ("rest", "m") else 0.0) for i, n in enumerate(order)])
        add += kf_op(img_u, [(i * 10, 0.0 if n in ("rest", "m") else 1.0) for i, n in enumerate(order)])
        add += kf_op(img_l, [(i * 10, 0.0 if n in ("rest", "m") else 1.0) for i, n in enumerate(order)])
        add += kf_op(img_c, [(i * 10, 0.0 if n in ("rest", "m") else OPEN[n][2]) for i, n in enumerate(order)])
        for w in VISEMES:
            if old_vis[w]:
                add += kf_op(old_vis[w], [(i * 10, 0.0) for i in range(len(order))])
        add += kf_y(img_u, [(i * 10, iy if n in ("rest", "m") else iy + OPEN[n][0]) for i, n in enumerate(order)])
        add += kf_y(img_l, [(i * 10, iy if n in ("rest", "m") else iy + OPEN[n][1]) for i, n in enumerate(order)])
        add += kf_y(img_c, [(i * 10, iy) for i, n in enumerate(order)])
        add += kf_sx(img_u, [(i * 10, kx if n in ("rest", "m") else kx * (1.0 + OPEN[n][3])) for i, n in enumerate(order)])
        add += kf_sx(img_l, [(i * 10, kx if n in ("rest", "m") else kx * (1.0 + OPEN[n][3])) for i, n in enumerate(order)])
        add += kf_sy(img_c, [(i * 10, ky if n in ("rest", "m") else ky * OPEN[n][4]) for i, n in enumerate(order)])
        add += kf_y(g_id, [(i * 10, g_y0 + (0 if n in ("rest", "m") else JAW[n])) for i, n in enumerate(order)])
        add += kf_y(mb_id, [(i * 10, mb_y0 + (0 if n in ("rest", "m") else JAW[n] * 0.65)) for i, n in enumerate(order)])
        return add

    s = rebuild(s, "full.talk", build_talk)
    SCENE.write_text(s, encoding="utf-8")

    M43.EXTRA = dict(M43.EXTRA)
    mouth_x = M43.EXTRA.get("full.head.g.mouth", 3.0)
    for n in (MARK, "full.mouth.upper", "full.mouth.lower",
              "full.mouth.upper.image", "full.mouth.lower.image", "full.mouth.cavity.image"):
        M43.EXTRA[n] = mouth_x

    def rest_xy_any(ss, n):
        t = re.search(rf'<(?:RootBone|Image) name="{re.escape(n)}"[^>]*>', ss)
        if t is None:
            raise KeyError(n)
        tag = t.group(0)
        return (float(re.search(r'\bx="([-\d.]+)"', tag).group(1)),
                float(re.search(r'\by="([-\d.]+)"', tag).group(1)))

    M43.rest_xy = rest_xy_any
    M43.main()

    d = json.loads(R41.LIC.read_text())
    for name, method in [
        ("upper", "ROUND48: upper lip cut from head-mouth + face-smile (original pixels)"),
        ("lower", "ROUND48: lower lip cut from head-mouth + face-smile (original pixels)"),
        ("cavity", "ROUND48: NEW small cavity in the gap between deformed lips (face-smile palette)"),
    ]:
        rel = f"reference/svg-rig/mouth-split-{name}.png"
        f = R41.RIG / f"mouth-split-{name}.png"
        bb = f.read_bytes()
        d["assets"][rel] = {
            "sha256": hashlib.sha256(bb).hexdigest(), "bytes": len(bb),
            "ai_generated": False, "in_scene": True, "method": method,
        }
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND48 flat split", {"ix": round(ix, 3), "iy": round(iy, 3)})


if __name__ == "__main__":
    main()
