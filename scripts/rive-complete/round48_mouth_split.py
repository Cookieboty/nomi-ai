#!/usr/bin/env python3
"""ROUND48 — split mouth: upper/lower lips cut from original + cavity in the gap.

Rest/M keep original mouthline (pixel-identical). Open visemes hide mouthline and
bone-deform upper/lower while revealing a small cavity between them.
Idempotent (MARK full.mouth.split). Leaves R45–47 overlay Images at opacity 0.
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
# lip separation (artboard px); positive lower goes down
OPEN = {
    # (upper_dy, lower_dy, cavity_opacity, scaleX_extra)
    "a": (-2.2, 3.6, 1.0, 0.0),
    "i": (-1.0, 1.8, 0.85, 0.12),
    "u": (-1.6, 2.4, 0.9, -0.08),
    "e": (-1.2, 2.2, 0.9, 0.08),
    "o": (-2.0, 3.2, 1.0, -0.04),
    "m": (0.0, 0.0, 0.0, 0.0),
}
JAW = {"a": 3.8, "i": 2.2, "u": 3.0, "e": 2.5, "o": 4.2, "m": 0.0}


def next_ids(s, n):
    m = R41.max_id(s)
    return [f"0:{m + 1 + i}" for i in range(n)]


def ids_by_name(s):
    out = {}
    for m in re.finditer(r'<(?:RootBone|Image|Bone|Node) name="([^"]+)"[^>]*\bid="(0:\d+)"', s):
        out[m.group(1)] = m.group(2)
    return out


def main():
    s = SCENE.read_text(encoding="utf-8")
    if MARK in s and "full.mouth.upper.image" in s:
        print("ROUND48 mouth split already wired"); return

    (kx, ky, bx, by), _ = R41.head_tex_frame(s)
    x0, y0, _, _ = META["upper"]["bbox"]
    ix, iy = bx + kx * x0, by + ky * y0
    ids = next_ids(s, 40)
    take = lambda: ids.pop(0)

    asset_u, asset_l, asset_c = take(), take(), take()
    bone_split, bone_u, bone_l = take(), take(), take()
    img_u, img_l, img_c = take(), take(), take()

    # assets after head-mouth
    at = re.search(r'<ImageAsset name="fullbody-head-mouth"[^>]*>', s)
    add_assets = (
        f'\n    <ImageAsset name="fullbody-mouth-split-upper" file="reference/svg-rig/mouth-split-upper.png" id="{asset_u}"/>'
        f'\n    <ImageAsset name="fullbody-mouth-split-lower" file="reference/svg-rig/mouth-split-lower.png" id="{asset_l}"/>'
        f'\n    <ImageAsset name="fullbody-mouth-split-cavity" file="reference/svg-rig/mouth-split-cavity.png" id="{asset_c}"/>'
    )
    s = s[:at.end()] + add_assets + s[at.end():]

    # draw order: first = on top. Want upper/lower above cavity, covering face.
    # Place after mouthline (mouthline on top when visible; when hidden, lips show over face).
    block = (
        f'<RootBone name="{MARK}" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_split}">'
        f'<RootBone name="full.mouth.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_u}">'
        f'<Image name="full.mouth.upper.image" assetId="{asset_u}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_u}"/>'
        f'</RootBone>'
        f'<RootBone name="full.mouth.lower" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_l}">'
        f'<Image name="full.mouth.lower.image" assetId="{asset_l}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_l}"/>'
        f'</RootBone>'
        f'<Image name="full.mouth.cavity.image" assetId="{asset_c}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{img_c}"/>'
        f'</RootBone>'
    )
    a, b = R8.find_elem(s, "Image", "full.head.mouthline.image")
    s = s[:b] + block + s[b:]

    idsmap = ids_by_name(s)
    mouthline_id = idsmap["full.head.mouthline.image"]
    g_id = idsmap["full.head.g.mouth"]
    mb_id = idsmap["full.mouth"]
    # old overlays
    old_vis = {v: idsmap.get(f"full.mouth.viseme.{v}.image") for v in VISEMES}

    g_y0 = float(re.search(r'<RootBone name="full\.head\.g\.mouth"[^>]*\by="([-\d.]+)"', s).group(1))
    mb_y0 = float(re.search(r'<RootBone name="full\.mouth"[^>]*\by="([-\d.]+)"', s).group(1))

    MARK_KF = "<!--r48mouth-->"

    def strip_mouth_keys(body):
        for mk in ("<!--r48mouth-->", "<!--r47mouth-->", "<!--r46mouth-->", "<!--r45mouth-->"):
            body = re.sub(
                rf'\s*<KeyedObject objectId="0:\d+">\s*{re.escape(mk)}.*?</KeyedObject>',
                "", body, flags=re.S)
        return body

    def kf_opacity(oid, frames):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK_KF}<KeyedProperty property="opacity">'
        body += "".join(f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="hold"/>'
                        for f, v in frames)
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
            f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.4" y1="0" x2="0.6" y2="1"/></KeyFrameDouble>'
            for f, v in frames)
        return body + "</KeyedProperty></KeyedObject>"

    def rebuild(s, name, builder):
        m = re.search(rf'(<LinearAnimation name="{re.escape(name)}"[^>]*>)(.*?)(\s*</LinearAnimation>)',
                      s, re.S)
        body = strip_mouth_keys(m.group(2))
        return s[:m.start(2)] + body + builder() + s[m.end(2):]

    def build_rest():
        add = kf_opacity(mouthline_id, [(0, 1.0)])
        add += kf_opacity(img_u, [(0, 0.0)])
        add += kf_opacity(img_l, [(0, 0.0)])
        add += kf_opacity(img_c, [(0, 0.0)])
        for v in VISEMES:
            if old_vis[v]:
                add += kf_opacity(old_vis[v], [(0, 0.0)])
        add += kf_y(bone_u, [(0, 0.0)])
        add += kf_y(bone_l, [(0, 0.0)])
        add += kf_sx(bone_u, [(0, 1.0)])
        add += kf_sx(bone_l, [(0, 1.0)])
        add += kf_y(g_id, [(0, g_y0)])
        add += kf_y(mb_id, [(0, mb_y0)])
        return add

    s = rebuild(s, "full.mouth_rest", build_rest)

    for v in VISEMES:
        udy, ldy, cop, sx = OPEN[v]
        jaw = JAW[v]

        def build(v=v, udy=udy, ldy=ldy, cop=cop, sx=sx, jaw=jaw):
            add = ""
            if v == "m":
                add += kf_opacity(mouthline_id, [(0, 1.0)])
                add += kf_opacity(img_u, [(0, 0.0)])
                add += kf_opacity(img_l, [(0, 0.0)])
                add += kf_opacity(img_c, [(0, 0.0)])
                add += kf_y(bone_u, [(0, 0.0)])
                add += kf_y(bone_l, [(0, 0.0)])
                add += kf_sx(bone_u, [(0, 1.0)])
                add += kf_sx(bone_l, [(0, 1.0)])
            else:
                add += kf_opacity(mouthline_id, [(0, 0.0)])
                add += kf_opacity(img_u, [(0, 1.0)])
                add += kf_opacity(img_l, [(0, 1.0)])
                add += kf_opacity(img_c, [(0, cop)])
                add += kf_y(bone_u, [(0, udy)])
                add += kf_y(bone_l, [(0, ldy)])
                add += kf_sx(bone_u, [(0, 1.0 + sx)])
                add += kf_sx(bone_l, [(0, 1.0 + sx)])
            for w in VISEMES:
                if old_vis[w]:
                    add += kf_opacity(old_vis[w], [(0, 0.0)])
            add += kf_y(g_id, [(0, g_y0 + jaw)])
            add += kf_y(mb_id, [(0, mb_y0 + jaw * 0.65)])
            return add

        s = rebuild(s, f"full.viseme_{v}", build)

    order = ["rest", *VISEMES, "rest"]

    def build_talk():
        add = ""
        # mouthline
        add += kf_opacity(mouthline_id, [
            (i * 10, 1.0 if name in ("rest", "m") else 0.0) for i, name in enumerate(order)])
        add += kf_opacity(img_u, [
            (i * 10, 0.0 if name in ("rest", "m") else 1.0) for i, name in enumerate(order)])
        add += kf_opacity(img_l, [
            (i * 10, 0.0 if name in ("rest", "m") else 1.0) for i, name in enumerate(order)])
        add += kf_opacity(img_c, [
            (i * 10, 0.0 if name in ("rest", "m") else OPEN[name][2]) for i, name in enumerate(order)])
        for w in VISEMES:
            if old_vis[w]:
                add += kf_opacity(old_vis[w], [(i * 10, 0.0) for i in range(len(order))])
        add += kf_y(bone_u, [
            (i * 10, 0.0 if name in ("rest", "m") else OPEN[name][0]) for i, name in enumerate(order)])
        add += kf_y(bone_l, [
            (i * 10, 0.0 if name in ("rest", "m") else OPEN[name][1]) for i, name in enumerate(order)])
        add += kf_sx(bone_u, [
            (i * 10, 1.0 if name in ("rest", "m") else 1.0 + OPEN[name][3]) for i, name in enumerate(order)])
        add += kf_sx(bone_l, [
            (i * 10, 1.0 if name in ("rest", "m") else 1.0 + OPEN[name][3]) for i, name in enumerate(order)])
        add += kf_y(g_id, [
            (i * 10, g_y0 + (0.0 if name in ("rest", "m") else JAW[name])) for i, name in enumerate(order)])
        add += kf_y(mb_id, [
            (i * 10, mb_y0 + (0.0 if name in ("rest", "m") else JAW[name] * 0.65))
            for i, name in enumerate(order)])
        return add

    s = rebuild(s, "full.talk", build_talk)
    SCENE.write_text(s, encoding="utf-8")

    # yaw: follow g.mouth
    M43.EXTRA = dict(M43.EXTRA)
    mouth_x = M43.EXTRA.get("full.head.g.mouth", 3.0)
    for n in (MARK, "full.mouth.upper", "full.mouth.lower",
              "full.mouth.upper.image", "full.mouth.lower.image", "full.mouth.cavity.image"):
        M43.EXTRA[n] = mouth_x
    # rest_xy must accept Image
    _orig = M43.rest_xy

    def rest_xy_any(s, n):
        t = re.search(rf'<(?:RootBone|Image) name="{re.escape(n)}"[^>]*>', s)
        if t is None:
            raise KeyError(n)
        tag = t.group(0)
        return (float(re.search(r'\bx="([-\d.]+)"', tag).group(1)),
                float(re.search(r'\by="([-\d.]+)"', tag).group(1)))

    M43.rest_xy = rest_xy_any
    M43.main()

    # license
    d = json.loads(R41.LIC.read_text())
    for name, method in [
        ("upper", "ROUND48: upper lip cut from head-mouth + face-smile composite (original pixels)"),
        ("lower", "ROUND48: lower lip cut from head-mouth + face-smile composite (original pixels)"),
        ("cavity", "ROUND48: NEW small oral cavity for the gap between deformed lips (palette from face-smile); not in source"),
    ]:
        rel = f"reference/svg-rig/mouth-split-{name}.png"
        f = R41.RIG / f"mouth-split-{name}.png"
        bb = f.read_bytes()
        d["assets"][rel] = {
            "sha256": hashlib.sha256(bb).hexdigest(),
            "bytes": len(bb),
            "ai_generated": False,
            "in_scene": True,
            "method": method,
        }
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND48 mouth split", {"ix": round(ix, 3), "iy": round(iy, 3), "open": OPEN})


if __name__ == "__main__":
    main()
