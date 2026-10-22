#!/usr/bin/env python3
"""ROUND23 - remove dead textures (never drawn in any clip) from the scene, the .riv, the repo and DETAIL_LICENSE.

Dead = provably invisible, checked by rendering every clip before/after (see REPORT-ROUND23):
  * full.cheer / full.wave: legacy whole-body pose images, opacity 0 and only ever keyed to 0;
  * full.sleeve-l/r.bent.image (+ their full.arm-X.sleeveBent Solo branch): the Solo is keyed to sleeveHang in every
    clip, the bent sleeve was never active (R20 showed it tears);
  * ImageAssets with no Image using them (sleeve-X-upper/lower[-dark|-orange], coat-X-shoulder-orange).
Kept on purpose: full.eye.l/r.image (the R22 inventory called it a superseded eye layer, but removing it opens two
see-through holes on the cheeks under the eyes in every frame - it is live face fill), full.neutral (fullbody-base-no-head-arms.png is the hole-filling backdrop, keyed opacity 1 in
full.idle/rest), source-nomi-master.png (the user's mother image, licence anchor).
Usage: round23_cleanup.py [PROJECT_DIR]   (idempotent; deletes the dead PNGs from PROJECT_DIR/reference/svg-rig)"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PROJECT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "rive/nomi-complete"
DEAD_IMAGES = ["full.cheer", "full.wave", "full.sleeve-l.bent.image", "full.sleeve-r.bent.image"]
DEAD_NODES = [("Node", "full.arm-l.sleeveBent"), ("Node", "full.arm-r.sleeveBent")]


def elem(s, tag, name):
    m = re.search(rf'<{tag}\b[^>]*\bname="{re.escape(name)}"[^>]*>', s)
    if not m:
        return None
    if m.group(0).endswith("/>"):
        return m.start(), m.end()
    depth, pos = 1, m.end()
    pat = re.compile(rf"<{tag}\b[^>]*>|</{tag}>")
    while depth:
        n = pat.search(s, pos)
        t = n.group(0)
        depth += -1 if t.startswith("</") else (0 if t.endswith("/>") else 1)
        pos = n.end()
    return m.start(), pos


def cut(s, a, b):
    # also swallow the indentation/newline before the element
    while a > 0 and s[a - 1] in " \t":
        a -= 1
    if a > 0 and s[a - 1] == "\n":
        a -= 1
    return s[:a] + s[b:]


def main():
    sp = PROJECT / "scene.rml"
    s = sp.read_text(encoding="utf-8")
    removed_ids, report = [], []
    for nm in DEAD_IMAGES:
        r = elem(s, "Image", nm)
        if not r:
            continue
        tag = s[r[0]:s.index(">", r[0]) + 1]
        removed_ids.append(re.search(r' id="([^"]+)"', tag).group(1))
        s = cut(s, *r); report.append(f"Image {nm}")
    for tag, nm in DEAD_NODES:
        r = elem(s, tag, nm)
        if not r:
            continue
        body = s[r[0]:r[1]]
        inner = re.sub(rf'^<{tag}\b[^>]*>|</{tag}>$', "", body).strip()
        assert inner == "", f"{nm} not empty after image removal: {inner[:80]}"
        removed_ids.append(re.search(r' id="([^"]+)"', body).group(1))
        s = cut(s, *r); report.append(f"{tag} {nm}")
    for i in removed_ids:   # their animation keys (only opacity=0 keys exist, verified)
        n0 = len(s)
        s = re.sub(rf'\n?[ \t]*<KeyedObject objectId="{re.escape(i)}">.*?</KeyedObject>', "", s, flags=re.S)
        if len(s) != n0:
            report.append(f"keys of {i}")
        assert f'"{i}"' not in s, f"dangling reference to {i}"
    used = set(re.findall(r'assetId="([^"]+)"', s))
    dead_files = []
    for m in list(re.finditer(r'[ \t]*<ImageAsset name="([^"]+)" file="([^"]+)" id="([^"]+)"/>\n', s)):
        name, f, i = m.groups()
        if i in used or f == "source-nomi-master.png":
            continue
        s = s.replace(m.group(0), "", 1); dead_files.append(f); report.append(f"ImageAsset {name}")
    sp.write_text(s, encoding="utf-8")
    lic_p = PROJECT / "parts/DETAIL_LICENSE.json"
    lic = json.loads(lic_p.read_text())
    still = set(re.findall(r'file="([^"]+)"', s))
    for f in dead_files:
        if f in still:
            continue
        (PROJECT / f).unlink(missing_ok=True)
        lic["assets"].pop(f, None)
    if dead_files and "ROUND23" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND23: removed never-drawn assets " + ", ".join(Path(f).name for f in dead_files) + ".").strip()
    lic_p.write_text(json.dumps(lic, indent=2) + "\n")
    # rig-meta.json (generated layer boxes / material notes): drop the deleted layers so nothing names them
    mp = PROJECT / "reference/svg-rig/rig-meta.json"
    if mp.exists() and dead_files:
        meta = json.loads(mp.read_text())
        stems = {Path(f).stem for f in dead_files}
        for k in list(meta.get("boxes", {})):
            if k in stems:
                meta["boxes"].pop(k)
        def scrub(o):
            if isinstance(o, dict):
                return {k: scrub(v) for k, v in o.items()}
            if isinstance(o, list):
                return [scrub(v) for v in o]
            if isinstance(o, str) and any(st + ".png" in o for st in stems):
                return ",".join(p for p in o.split(",") if Path(p).stem not in stems)
            return o
        meta = scrub(meta)
        mp.write_text(json.dumps(meta, indent=2) + "\n")
    for r in report:
        print(r)
    print("deleted files:", *dead_files, sep="\n  ")


if __name__ == "__main__":
    main()
