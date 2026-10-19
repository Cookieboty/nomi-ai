#!/usr/bin/env python3
"""ROUND3: register continuous/bent sleeve assets and swap scene Images.

Run after build-fullbody-svg-rig.py. Replaces segmented upper/lower(+orange)
Image nodes with sleeve-full / sleeve-full-dark / sleeve-bent placeholders so
add-arm-meshes.py can skin them.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RIVE = ROOT / "rive" / "nomi-complete"
SCENE = RIVE / "scene.rml"
RIG = RIVE / "reference" / "svg-rig"
LICENSE = RIVE / "parts" / "DETAIL_LICENSE.json"

ASSETS = [
    ("0:9800", "0:9810", "sleeve-l-full", "full.sleeve-l.full.image"),
    ("0:9801", "0:9811", "sleeve-l-full-dark", "full.sleeve-l.full.dark.image"),
    ("0:9802", "0:9812", "sleeve-l-bent", "full.sleeve-l.bent.image"),
    ("0:9803", "0:9813", "sleeve-r-full", "full.sleeve-r.full.image"),
    ("0:9804", "0:9814", "sleeve-r-full-dark", "full.sleeve-r.full.dark.image"),
    ("0:9805", "0:9815", "sleeve-r-bent", "full.sleeve-r.bent.image"),
    # ROUND5 torso-locked white stump under collar (placeholders; mounted static later)
    ("0:9806", "0:9816", "sleeve-l-stump", "full.sleeve-l.stump.image"),
    ("0:9807", "0:9817", "sleeve-r-stump", "full.sleeve-r.stump.image"),
]

OLD_IMAGE_NAMES = [
    "full.sleeve-l.upper.image",
    "full.sleeve-l.upper.dark.image",
    "full.sleeve-l.upper.orange.image",
    "full.sleeve-l.lower.image",
    "full.sleeve-l.lower.dark.image",
    "full.sleeve-l.lower.orange.image",
    "full.sleeve-r.upper.image",
    "full.sleeve-r.upper.dark.image",
    "full.sleeve-r.upper.orange.image",
    "full.sleeve-r.lower.image",
    "full.sleeve-r.lower.dark.image",
    "full.sleeve-r.lower.orange.image",
    "full.arm-l.coat-shoulder.orange.image",
    "full.arm-r.coat-shoulder.orange.image",
    "full.arm-l.coat-shoulder.dark.image",
    "full.arm-r.coat-shoulder.dark.image",
]


def strip_image(scene: str, name: str) -> str:
    pat = re.compile(
        rf'\s*<Image\b[^>]*\bname="{re.escape(name)}"[^>]*?(?:/>|>.*?</Image>)',
        re.DOTALL,
    )
    return pat.sub("", scene)


def ensure_asset(scene: str, asset_id: str, name: str, file_rel: str) -> str:
    if f'id="{asset_id}"' in scene:
        scene = re.sub(
            rf'<ImageAsset\b[^>]*\bid="{re.escape(asset_id)}"[^>]*/>',
            f'<ImageAsset name="{name}" file="{file_rel}" id="{asset_id}"/>',
            scene,
            count=1,
        )
        return scene
    if f'file="{file_rel}"' in scene:
        return scene
    last = None
    for m in re.finditer(r"<ImageAsset\b[^>]*/>", scene):
        last = m
    if not last:
        raise SystemExit("no ImageAsset to anchor")
    insert = f'\n    <ImageAsset name="{name}" file="{file_rel}" id="{asset_id}"/>'
    return scene[: last.end()] + insert + scene[last.end() :]


def ensure_placeholder_image(scene: str, image_id: str, name: str, asset_id: str) -> str:
    if f'name="{name}"' in scene:
        return scene
    marker = 'name="full.arm-l.cuff.image"'
    idx = scene.find(marker)
    if idx < 0:
        raise SystemExit("cuff marker missing")
    start = scene.rfind("<Image", 0, idx)
    tag = (
        f'<Image name="{name}" assetId="{asset_id}" '
        f'x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" id="{image_id}"/>\n                '
    )
    return scene[:start] + tag + scene[start:]


def refresh_license() -> None:
    data = json.loads(LICENSE.read_text())
    assets = data.setdefault("assets", {})
    # drop stale entries whose files are gone
    for key in list(assets.keys()):
        if key.startswith("reference/svg-rig/") or key == "source-nomi-master.png":
            if not (RIVE / key).exists():
                del assets[key]
    for path in sorted(RIG.glob("*")):
        if path.suffix.lower() not in {".png", ".svg"}:
            continue
        rel = f"reference/svg-rig/{path.name}"
        assets[rel] = {
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size,
            "ai_generated": False,
            "in_scene": True,
            "method": "deterministic source-pixel rig layer derived from user supplied full-body mother",
        }
    src = RIVE / "source-nomi-master.png"
    assets["source-nomi-master.png"] = {
        "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        "bytes": src.stat().st_size,
        "ai_generated": False,
        "in_scene": True,
        "method": "user supplied full-body mother",
    }
    data["note"] = (
        "Production Rive scene uses the mother image and deterministic source-pixel "
        "rig layers. ROUND3: continuous sleeve-full + mother-warped bent-elbow Solo; "
        "base fabric keeps full matte (no orange/dark punch-holes); hands draw above sleeves."
    )
    LICENSE.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    for _aid, _iid, stem, _name in ASSETS:
        if not (RIG / f"{stem}.png").exists():
            raise SystemExit(f"missing {stem}.png; run build-fullbody-svg-rig.py first")

    scene = SCENE.read_text(encoding="utf-8")
    for asset_id, image_id, stem, img_name in ASSETS:
        file_rel = f"reference/svg-rig/{stem}.png"
        scene = ensure_asset(scene, asset_id, f"fullbody-{stem}", file_rel)
        scene = ensure_placeholder_image(scene, image_id, img_name, asset_id)

    for name in OLD_IMAGE_NAMES:
        scene = strip_image(scene, name)

    SCENE.write_text(scene, encoding="utf-8")
    refresh_license()
    print("injected", len(ASSETS), "continuous/bent sleeve assets; stripped old orange/segment drawables")


if __name__ == "__main__":
    main()
