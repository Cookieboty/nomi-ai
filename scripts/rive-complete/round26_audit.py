#!/usr/bin/env python3
"""ROUND26 item 1 - full-bone audit (read-only).
Walks scene.rml, lists every Image with the bone(s) that drive it (skin tendons or rigid parent bone), computes the
rest world position of every bone, and writes:
  OUT/AUDIT-R26.md (table), OUT/audit-r26.json, OUT/BEST-skeleton-overlay.png (bones over a rest render).
usage: round26_audit.py OUTDIR [REST_PNG]"""
from __future__ import annotations
import json, math, sys, xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

SCENE = Path(__file__).resolve().parents[2] / "rive/nomi-complete/scene.rml"
BONE = ("RootBone", "Bone")


def M(x, y, r, sx=1.0, sy=1.0):
    c, s = math.cos(r), math.sin(r)
    return np.array([[c * sx, -s * sy, x], [s * sx, c * sy, y], [0, 0, 1.0]])


def walk(scene=SCENE):
    root = ET.parse(scene).getroot()
    ab = next(root.iter("Artboard"))
    bones, images, names = {}, [], {}
    for e in ab.iter():
        if e.get("id"):
            names[e.get("id")] = e.get("name")

    def rec(e, W, parent_bone, parent_node):
        for c in e:
            if c.tag in BONE or c.tag == "Node":
                Wc = W @ M(float(c.get("x", 0)), float(c.get("y", 0)), float(c.get("rotation", 0)),
                           float(c.get("scaleX", 1)), float(c.get("scaleY", 1)))
                if c.tag in BONE:
                    bones[c.get("name")] = dict(id=c.get("id"), parent=parent_bone, W=Wc)
                    rec(c, Wc, c.get("name"), c.get("name"))
                else:
                    rec(c, Wc, parent_bone, c.get("name"))
            elif c.tag == "Image":
                tend = [names.get(t.get("boneId")) for t in c.iter("Tendon")]
                images.append(dict(name=c.get("name"), parent=parent_node, parent_bone=parent_bone,
                                   skin=tend, opacity=float(c.get("opacity", 1))))
            elif c.tag not in ("LinearAnimation", "StateMachine"):
                rec(c, W, parent_bone, parent_node)
    rec(ab, np.eye(3), None, None)
    return bones, images


GROUPS = [("arm-", "#ff4040"), ("thumb", "#ffd000"), ("index", "#ffd000"), ("middle", "#ffd000"), ("ring", "#ffd000"),
          ("little", "#ffd000"), ("leg-", "#30a0ff"), ("hair", "#40ff80"), ("bangs", "#40ff80"), ("hem", "#ff60ff"),
          ("belt", "#ff60ff"), ("eye", "#00ffff"), ("brow", "#00ffff")]


def colour(n):
    for k, c in GROUPS:
        if k in n:
            return c
    return "#ffffff"


def overlay(bones, rest_png, out):
    im = Image.open(rest_png).convert("RGBA")
    im = Image.blend(im, Image.new("RGBA", im.size, (0, 0, 0, 255)), 0.45)
    d = ImageDraw.Draw(im)
    for n, b in bones.items():
        p = b["W"][:2, 2]
        if b["parent"] and b["parent"] in bones and b["parent"] != "full.root":
            q = bones[b["parent"]]["W"][:2, 2]
            if b["parent"] in ("full.head", "full.torso", "full.pelvis") and np.hypot(*(p - q)) > 60 and "neck" not in n:
                continue  # attachment offsets (hair roots, belt items) are not limbs: drawn as joints only
            d.line([tuple(q), tuple(p)], fill=colour(n), width=3 if "arm" in n or "leg" in n else 2)
    for n, b in bones.items():
        x, y = b["W"][:2, 2]
        r = 3 if any(k in n for k in ("thumb", "index", "middle", "ring", "little", "eye", "brow")) else 5
        d.ellipse([x - r, y - r, x + r, y + r], outline=colour(n), width=2)
    big = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    big.save(out)


def main():
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    bones, images = walk()
    rows = []
    for i in images:
        drv = i["skin"] or ([i["parent_bone"]] if i["parent_bone"] else [])
        kind = "skin" if i["skin"] else ("rigid-on-bone" if i["parent_bone"] else "NODE-ONLY (no bone)")
        rows.append(dict(image=i["name"], kind=kind, drivers=drv, parent=i["parent"], opacity=i["opacity"]))
    json.dump(dict(bones={k: dict(id=v["id"], parent=v["parent"], world=[round(float(x), 2) for x in v["W"][:2, 2]])
                          for k, v in bones.items()}, images=rows), open(out / "audit-r26.json", "w"), indent=1,
              ensure_ascii=False)
    n_skin = sum(r["kind"] == "skin" for r in rows); n_rig = sum(r["kind"] == "rigid-on-bone" for r in rows)
    n_none = [r["image"] for r in rows if r["kind"].startswith("NODE")]
    md = [f"images {len(rows)}: skin {n_skin}, rigid-on-bone {n_rig}, node-only {len(n_none)} {n_none}",
          f"bones {len(bones)}", "", "| image | kind | driving bones | parent | opacity |", "|---|---|---|---|---|"]
    md += [f"| `{r['image']}` | {r['kind']} | {', '.join(x.replace('full.', '') for x in r['drivers'])} | {r['parent']} | {r['opacity']:g} |" for r in rows]
    (out / "AUDIT-R26.md").write_text("\n".join(md) + "\n")
    print(md[0]); print(md[1])
    if len(sys.argv) > 2:
        overlay(bones, sys.argv[2], out / "BEST-skeleton-overlay.png")


if __name__ == "__main__":
    main()
