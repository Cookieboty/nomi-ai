#!/usr/bin/env python3
"""ROUND46 — smaller delicate open mouths + slight jaw drop; keep rest/M original.

Updates Image placements for new bbox, rewrites opacity+jaw keys on mouth anims,
shortens SM blend, refreshes LICENSE hashes. Idempotent (MARK r46mouth).
"""
from __future__ import annotations
import re, json, hashlib
from pathlib import Path
import round10_layers as L10
import round41_head_yaw_rig as R41

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!--r46mouth-->"
META = json.loads(Path(__file__).with_name("mouth-visemes-r46.json").read_text())
VISEMES = ("a", "i", "u", "e", "o", "m")
# subtle chin/jaw drop in artboard px (y+ is down)
JAW = {"a": 2.8, "i": 1.6, "u": 2.2, "e": 1.8, "o": 3.0, "m": 0.0}
G_MOUTH = "full.head.g.mouth"
MOUTH_BONE = "full.mouth"


def ids_by_name(s):
    out = {}
    for m in re.finditer(r'<(?:RootBone|Image|Bone|Node) name="([^"]+)"[^>]*\bid="(0:\d+)"', s):
        out[m.group(1)] = m.group(2)
    return out


def main():
    s = SCENE.read_text(encoding="utf-8")
    (kx, ky, bx, by), _ = R41.head_tex_frame(s)
    ids = ids_by_name(s)

    # reposition each open viseme Image to its crop origin
    for v in VISEMES:
        x0, y0, _, _ = META[v]["bbox"]
        ix, iy = bx + kx * x0, by + ky * y0
        name = f"full.mouth.viseme.{v}.image"
        s = re.sub(
            rf'(<Image name="{re.escape(name)}"[^>]*?\bx=")[^"]+(")',
            rf'\g<1>{ix:.4f}\2', s, count=1)
        s = re.sub(
            rf'(<Image name="{re.escape(name)}"[^>]*?\by=")[^"]+(")',
            rf'\g<1>{iy:.4f}\2', s, count=1)

    mouthline_id = ids["full.head.mouthline.image"]
    g_id = ids[G_MOUTH]
    mb_id = ids[MOUTH_BONE]
    vis_ids = {v: ids[f"full.mouth.viseme.{v}.image"] for v in VISEMES}
    # rest positions
    g_y0 = float(re.search(rf'<RootBone name="{re.escape(G_MOUTH)}"[^>]*\by="([-\d.]+)"', s).group(1))
    mb_y0 = float(re.search(rf'<RootBone name="{re.escape(MOUTH_BONE)}"[^>]*\by="([-\d.]+)"', s).group(1))
    vis_y0 = {}
    for v in VISEMES:
        vis_y0[v] = float(re.search(
            rf'<Image name="full\.mouth\.viseme\.{v}\.image"[^>]*\by="([-\d.]+)"', s).group(1))

    def strip_r46(body):
        return re.sub(rf'\s*<KeyedObject objectId="0:\d+">\s*{re.escape(MARK)}.*?</KeyedObject>',
                      '', body, flags=re.S)

    def opacity_keys(oid, frames_vals):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="opacity">'
        body += "".join(
            f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="hold"/>'
            for f, v in frames_vals)
        return body + "</KeyedProperty></KeyedObject>"

    def y_keys(oid, frames_vals):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="y">'
        body += "".join(
            f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="0.4" y1="0" x2="0.6" y2="1"/></KeyFrameDouble>'
            for f, v in frames_vals)
        return body + "</KeyedProperty></KeyedObject>"

    def rebuild_anim(s, anim_name, builder):
        m = re.search(
            rf'(<LinearAnimation name="{re.escape(anim_name)}"[^>]*>)(.*?)(\s*</LinearAnimation>)',
            s, re.S)
        body = strip_r46(m.group(2))
        # also strip old r45mouth opacity keys so we fully own mouth anims
        body = re.sub(
            r'\s*<KeyedObject objectId="0:\d+"><!--r45mouth-->.*?</KeyedObject>',
            '', body, flags=re.S)
        add = builder()
        return s[:m.start(2)] + body + add + s[m.end(2):]

    # rest
    def build_rest():
        add = opacity_keys(mouthline_id, [(0, 1.0)])
        for v in VISEMES:
            add += opacity_keys(vis_ids[v], [(0, 0.0)])
        add += y_keys(g_id, [(0, g_y0)])
        add += y_keys(mb_id, [(0, mb_y0)])
        for v in VISEMES:
            add += y_keys(vis_ids[v], [(0, vis_y0[v])])
        return add

    s = rebuild_anim(s, "full.mouth_rest", build_rest)

    for v in VISEMES:
        jaw = JAW[v]
        def build(v=v, jaw=jaw):
            add = ""
            if v == "m":
                add += opacity_keys(mouthline_id, [(0, 1.0)])
                for w in VISEMES:
                    add += opacity_keys(vis_ids[w], [(0, 0.0)])
            else:
                add += opacity_keys(mouthline_id, [(0, 0.0)])
                for w in VISEMES:
                    add += opacity_keys(vis_ids[w], [(0, 1.0 if w == v else 0.0)])
            add += y_keys(g_id, [(0, g_y0 + jaw)])
            add += y_keys(mb_id, [(0, mb_y0 + jaw * 0.6)])
            for w in VISEMES:
                dy = jaw if w == v else 0.0
                add += y_keys(vis_ids[w], [(0, vis_y0[w] + dy)])
            return add
        s = rebuild_anim(s, f"full.viseme_{v}", build)

    # talk cycle: rest,a,i,u,e,o,m,rest at frames 0,10,...,70
    order = ["rest", *VISEMES, "rest"]
    def build_talk():
        add = ""
        # mouthline
        kfs = []
        for i, name in enumerate(order):
            kfs.append((i * 10, 1.0 if name in ("rest", "m") else 0.0))
        add += opacity_keys(mouthline_id, kfs)
        for v in VISEMES:
            kfs = [(i * 10, 1.0 if (name == v and v != "m") else 0.0) for i, name in enumerate(order)]
            add += opacity_keys(vis_ids[v], kfs)
        # jaw envelope
        kfs_g, kfs_m = [], []
        kfs_vis = {v: [] for v in VISEMES}
        for i, name in enumerate(order):
            j = 0.0 if name in ("rest", "m") else JAW.get(name, 0.0)
            kfs_g.append((i * 10, g_y0 + j))
            kfs_m.append((i * 10, mb_y0 + j * 0.6))
            for v in VISEMES:
                kfs_vis[v].append((i * 10, vis_y0[v] + (j if v == name else 0.0)))
        add += y_keys(g_id, kfs_g)
        add += y_keys(mb_id, kfs_m)
        for v in VISEMES:
            add += y_keys(vis_ids[v], kfs_vis[v])
        return add

    s = rebuild_anim(s, "full.talk", build_talk)

    # soften SM transitions a touch (duration 3) but keep hold keys
    s = re.sub(
        r'(<StateMachineLayer name="full\.mouth"[\s\S]*?</StateMachineLayer>)',
        lambda m: m.group(1).replace('duration="0"', 'duration="3"'),
        s, count=1)

    SCENE.write_text(s, encoding="utf-8")

    # license hashes
    d = json.loads(R41.LIC.read_text())
    for v in list(VISEMES) + ["rest"]:
        rel = f"reference/svg-rig/mouth-viseme-{v}.png"
        f = R41.RIG / f"mouth-viseme-{v}.png"
        bb = f.read_bytes()
        d["assets"][rel] = {
            "sha256": hashlib.sha256(bb).hexdigest(),
            "bytes": len(bb),
            "ai_generated": False,
            "in_scene": v != "rest",
            "method": (
                "ROUND46: redrawn open mouths ~half R45 size; soft gradients + thin lip line "
                "sampled from face-smile/head-mouth. Cavity/teeth still NEW (not in source). "
                "Rest/M use original head-mouthline pixels."
                if v not in ("rest", "m") else
                "ROUND46: crop of original head-mouth.png / unused for draw (rest+M = mouthline)"
            ),
        }
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND46 mouth refine", {v: META[v]["size"] for v in VISEMES}, "jaw", JAW)


if __name__ == "__main__":
    main()
