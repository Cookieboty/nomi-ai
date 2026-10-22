#!/usr/bin/env python3
"""ROUND31a: clothing-swap readiness audit (read-only on scene textures).

Classifies every Image as body / garment / accessory / fused-base, measures
per-texture skin/orange/dark shares, and writes:
  docs/mascot/CLOTHING-SWAP-AUDIT.md
  docs/mascot/clothing-swap-inventory.json

Optional: if OUT env is set, also mirrors there (scratch). Does not mutate scene.
"""
from __future__ import annotations
import json, os, xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive/nomi-complete/scene.rml"
RIG = ROOT / "rive/nomi-complete/reference/svg-rig"
DOC = ROOT / "docs/mascot"
DOC.mkdir(parents=True, exist_ok=True)

CLASS = {
    "body-skin": [
        "arm-l-shoulder-skin", "arm-r-shoulder-skin", "arm-l-upper-skin", "arm-r-upper-skin",
        "leg-l-skin", "leg-r-skin",
        "hand-l-palm", "hand-l-web", "hand-l-thumb", "hand-l-index", "hand-l-middle", "hand-l-ring", "hand-l-little",
        "hand-r-palm", "hand-r-web", "hand-r-thumb", "hand-r-index", "hand-r-middle", "hand-r-ring", "hand-r-little",
        "head", "mouth", "eye-l-skin", "eye-r-skin", "eye-l-lid", "eye-r-lid", "eye-l-lash", "eye-r-lash",
        "eye-l-sclera", "eye-r-sclera", "eye-l-iris", "eye-r-iris", "eye-l-hl", "eye-r-hl", "eye-l", "eye-r",
        "brow-l", "brow-r", "face-smile",
    ],
    "body-hair": [
        "hair-l", "hair-r", "hair-lock-l", "hair-lock-r", "hair-back-l", "hair-back-r", "hair-tip-l",
        "bangs-a", "bangs-b", "bangs-c",
    ],
    "garment-tank": ["torso-tank"],
    "garment-coat": [
        "sleeve-l-full", "sleeve-r-full", "sleeve-l-full-dark", "sleeve-r-full-dark",
        "sleeve-l-stump", "sleeve-r-stump",
        "coat-l-front", "coat-r-front",
        "coat-l-shoulder", "coat-r-shoulder", "coat-l-shoulder-dark", "coat-r-shoulder-dark",
        "coat-l-shoulder-lining", "coat-r-shoulder-lining",
        "hem-ribbon-l", "hem-ribbon-r", "arm-l-cuff", "arm-r-cuff",
    ],
    "garment-shorts": ["shorts"],
    "garment-belt": ["belt-band", "belt-id", "belt-pouch"],
    "garment-shoes": ["shoe-l", "shoe-r"],
    "accessory": ["choker", "hair-bow", "hair-clip"],
    "fused-base": ["body-backfill", "fullbody-base-no-head-arms"],
}
BY = {f: c for c, fs in CLASS.items() for f in fs}


def tex_stats(path: Path):
    arr = np.array(Image.open(path).convert("RGBA"))
    m = arr[:, :, 3] >= 8
    opa = int(m.sum())
    if not opa:
        return dict(opaque_px=0, skin_px=0, orange_px=0, dark_px=0, white_px=0, mean_rgb=None)
    r, g, b = arr[:, :, 0].astype(np.float32), arr[:, :, 1].astype(np.float32), arr[:, :, 2].astype(np.float32)
    skin = int((m & (r > 140) & (g > 90) & (b > 50) & (r > g) & ((r - b) > 15)).sum())
    orange = int((m & (r > 180) & (g > 80) & (g < 180) & (b < 100) & ((r - g) > 40)).sum())
    dark = int((m & (r < 90) & (g < 90) & (b < 90)).sum())
    white = int((m & (r > 200) & (g > 200) & (b > 200)).sum())
    mean = [round(float(x), 1) for x in arr[:, :, :3][m].mean(0)]
    return dict(opaque_px=opa, skin_px=skin, orange_px=orange, dark_px=dark, white_px=white, mean_rgb=mean)


def fused_notes(base, st, cat):
    notes = []
    if cat == "fused-base":
        notes.append("base layer contains mother garment pixels, not bare skin")
    if base == "body-backfill" and st["skin_px"] < 100:
        notes.append(f"only {st['skin_px']} skin-like px — NOT a bare-body base")
    if cat.startswith("body") and st["orange_px"] > 100:
        notes.append(f"orange baked into body layer ({st['orange_px']}px)")
    if base in ("leg-l-skin", "leg-r-skin") and st["white_px"] > 5000:
        notes.append("socks appear baked into leg skin")
    if base in ("arm-l-shoulder-skin", "arm-r-shoulder-skin") and st["orange_px"] > 200:
        notes.append("coat orange rim fused into shoulder skin")
    if base == "shorts" and st["orange_px"] > 500:
        notes.append("orange side fragments fused into shorts texture")
    if base == "torso-tank" and st["orange_px"] > 200:
        notes.append("orange fringe on tank edges")
    if base == "hair-bow" and st["opaque_px"] < 20:
        notes.append("essentially empty (bow pixels live elsewhere)")
    return notes


def walk_images():
    root = ET.parse(SCENE).getroot()
    assets = {e.get("id"): e.get("file") for e in root.iter("ImageAsset")}
    names = {}
    ab = next(root.iter("Artboard"))
    for e in ab.iter():
        if e.get("id"):
            names[e.get("id")] = e.get("name")
    out = []
    BONE = ("RootBone", "Bone")

    def rec(e, parent_bone, parent_node):
        for c in e:
            if c.tag in BONE or c.tag == "Node":
                if c.tag in BONE:
                    rec(c, c.get("name"), c.get("name"))
                else:
                    rec(c, parent_bone, c.get("name"))
            elif c.tag == "Image":
                tend = [names.get(t.get("boneId")) for t in c.iter("Tendon")]
                f = assets.get(c.get("assetId"), "")
                base = Path(f).stem if f else ""
                cat = BY.get(base, "UNCLASSIFIED")
                st = tex_stats(ROOT / "rive/nomi-complete" / f) if f else dict(opaque_px=0, skin_px=0, orange_px=0, dark_px=0, white_px=0, mean_rgb=None)
                out.append(dict(
                    image=c.get("name"), file=base, category=cat,
                    kind="skin" if tend else "rigid-on-bone",
                    drivers=tend or ([parent_bone] if parent_bone else []),
                    parent=parent_node, opacity=float(c.get("opacity", 1)),
                    **st, fused_notes=fused_notes(base, st, cat),
                ))
            elif c.tag not in ("LinearAnimation", "StateMachine"):
                rec(c, parent_bone, parent_node)
    rec(ab, None, None)
    return out


def main():
    rows = walk_images()
    bf = next(r for r in rows if r["file"] == "body-backfill")
    blockers = [
        "body-backfill.png is dark garment torso, not bare skin" if bf["skin_px"] < 1000 else None,
        "no continuous arm skin under sleeves (hide-coat severs arms)",
        "hip/crotch gap when shorts hidden (legs start mid-thigh)",
        "orange coat rim fused into arm-*-shoulder-skin",
        "orange side fragments fused into shorts.png",
        "socks baked into leg-*-skin; no sock layer",
        "hair-bow.png nearly empty (6 px)",
        "tank hide is a no-op visually because backfill duplicates tank",
        "draw-order not grouped as body→underwear→tops→outerwear→accessories",
    ]
    blockers = [b for b in blockers if b]
    # Re-evaluate first blocker after future R31b
    if bf["skin_px"] >= 1000 and bf["dark_px"] < bf["opaque_px"] * 0.2:
        blockers = [b for b in blockers if "body-backfill" not in b and "tank hide" not in b]
        blockers.insert(0, "body-backfill converted toward skin — re-check hole-scan")
    inv = dict(
        categories=CLASS, images=rows, swap_ready=False, blockers=blockers,
        body_backfill=dict(opaque=bf["opaque_px"], skin=bf["skin_px"], dark=bf["dark_px"], mean_rgb=bf["mean_rgb"]),
    )
    json.dump(inv, open(DOC / "clothing-swap-inventory.json", "w"), indent=2, ensure_ascii=False)
    md = ["# CLOTHING-SWAP-AUDIT", "",
          f"Images: {len(rows)}. body-backfill skin={bf['skin_px']} dark={bf['dark_px']} opaque={bf['opaque_px']}.",
          f"swap_ready: false. blockers: {len(blockers)}.", "",
          "| image | file | category | opaque | skin | orange | notes |",
          "|---|---|---|---:|---:|---:|---|"]
    for r in rows:
        note = "; ".join(r["fused_notes"]) if r["fused_notes"] else "—"
        md.append(f"| `{r['image']}` | `{r['file']}` | {r['category']} | {r['opaque_px']} | {r['skin_px']} | {r['orange_px']} | {note} |")
    md += ["", "## Blockers", ""] + [f"- {b}" for b in blockers] + [""]
    (DOC / "CLOTHING-SWAP-AUDIT.md").write_text("\n".join(md), encoding="utf-8")
    mirror = os.environ.get("OUT")
    if mirror:
        Path(mirror).mkdir(parents=True, exist_ok=True)
        (Path(mirror) / "CLOTHING-SWAP-AUDIT.md").write_text("\n".join(md), encoding="utf-8")
        json.dump(inv, open(Path(mirror) / "clothing-swap-inventory.json", "w"), indent=2, ensure_ascii=False)
    print(f"audit: {len(rows)} images; backfill skin={bf['skin_px']} dark={bf['dark_px']}; blockers={len(blockers)}")


if __name__ == "__main__":
    main()
