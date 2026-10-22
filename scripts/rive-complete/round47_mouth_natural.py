#!/usr/bin/env python3
"""ROUND47 — feather open-mouth covers (no square halo) + slightly stronger jaw.

Repositions Images for new bboxes, rewrites r46mouth keys with stronger JAW,
refreshes LICENSE. Idempotent (MARK r47mouth; also strips r46mouth).
"""
from __future__ import annotations
import re, json, hashlib
from pathlib import Path
import round10_layers as L10
import round41_head_yaw_rig as R41

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!--r47mouth-->"
OLD = ("<!--r46mouth-->", "<!--r45mouth-->")
META = json.loads(Path(__file__).with_name("mouth-visemes-r47.json").read_text())
VISEMES = ("a", "i", "u", "e", "o", "m")
# ~1.35× R46, still small
JAW = {"a": 3.8, "i": 2.2, "u": 3.0, "e": 2.5, "o": 4.2, "m": 0.0}
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

    for v in VISEMES:
        x0, y0, _, _ = META[v]["bbox"]
        ix, iy = bx + kx * x0, by + ky * y0
        name = f"full.mouth.viseme.{v}.image"
        s = re.sub(rf'(<Image name="{re.escape(name)}"[^>]*?\bx=")[^"]+(")', rf'\g<1>{ix:.4f}\2', s, count=1)
        s = re.sub(rf'(<Image name="{re.escape(name)}"[^>]*?\by=")[^"]+(")', rf'\g<1>{iy:.4f}\2', s, count=1)

    mouthline_id = ids["full.head.mouthline.image"]
    g_id = ids[G_MOUTH]
    mb_id = ids[MOUTH_BONE]
    vis_ids = {v: ids[f"full.mouth.viseme.{v}.image"] for v in VISEMES}
    g_y0 = float(re.search(rf'<RootBone name="{re.escape(G_MOUTH)}"[^>]*\by="([-\d.]+)"', s).group(1))
    mb_y0 = float(re.search(rf'<RootBone name="{re.escape(MOUTH_BONE)}"[^>]*\by="([-\d.]+)"', s).group(1))
    vis_y0 = {
        v: float(re.search(rf'<Image name="full\.mouth\.viseme\.{v}\.image"[^>]*\by="([-\d.]+)"', s).group(1))
        for v in VISEMES
    }

    def strip_old(body):
        for mk in (*OLD, MARK):
            body = re.sub(rf'\s*<KeyedObject objectId="0:\d+">\s*{re.escape(mk)}.*?</KeyedObject>',
                          '', body, flags=re.S)
        return body

    def opacity_keys(oid, frames_vals):
        body = f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="opacity">'
        body += "".join(f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="hold"/>'
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
        m = re.search(rf'(<LinearAnimation name="{re.escape(anim_name)}"[^>]*>)(.*?)(\s*</LinearAnimation>)',
                      s, re.S)
        body = strip_old(m.group(2))
        return s[:m.start(2)] + body + builder() + s[m.end(2):]

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
            add += y_keys(mb_id, [(0, mb_y0 + jaw * 0.65)])
            for w in VISEMES:
                dy = jaw if w == v else 0.0
                add += y_keys(vis_ids[w], [(0, vis_y0[w] + dy)])
            return add

        s = rebuild_anim(s, f"full.viseme_{v}", build)

    order = ["rest", *VISEMES, "rest"]

    def build_talk():
        add = ""
        add += opacity_keys(mouthline_id, [(i * 10, 1.0 if name in ("rest", "m") else 0.0)
                                           for i, name in enumerate(order)])
        for v in VISEMES:
            add += opacity_keys(vis_ids[v], [
                (i * 10, 1.0 if (name == v and v != "m") else 0.0) for i, name in enumerate(order)])
        kfs_g, kfs_m = [], []
        kfs_vis = {v: [] for v in VISEMES}
        for i, name in enumerate(order):
            j = 0.0 if name in ("rest", "m") else JAW.get(name, 0.0)
            kfs_g.append((i * 10, g_y0 + j))
            kfs_m.append((i * 10, mb_y0 + j * 0.65))
            for v in VISEMES:
                kfs_vis[v].append((i * 10, vis_y0[v] + (j if v == name else 0.0)))
        add += y_keys(g_id, kfs_g)
        add += y_keys(mb_id, kfs_m)
        for v in VISEMES:
            add += y_keys(vis_ids[v], kfs_vis[v])
        return add

    s = rebuild_anim(s, "full.talk", build_talk)
    SCENE.write_text(s, encoding="utf-8")

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
                "ROUND47: feathered elliptical skin fringe (no rectangular cover); "
                "soft lips + cavity/teeth still NEW art from face-smile/head-mouth/face palette. "
                "Rest/M = original mouthline."
                if v not in ("rest", "m") else
                "ROUND47: crop of original head-mouth.png (draw uses mouthline for rest/M)"
            ),
        }
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND47", {v: META[v]["size"] for v in VISEMES}, "jaw", JAW)


if __name__ == "__main__":
    main()
