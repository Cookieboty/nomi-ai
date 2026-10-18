#!/usr/bin/env python3
"""Wrap hang continuous sleeves and bent art in a Solo per arm; key clap/wave.

Run after add-arm-meshes.py. Structure under arm.rig (ROUND4):

  upper, fore,
  skin,
  Solo(hang: full+dark | bent: bent),
  coat-shoulder,   # on top of soft sleeve underlap
  cuff,
  hand...

Default active = hang. animate-fullbody keys Solo activeComponentId on clap/wave.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive" / "nomi-complete" / "scene.rml"

SOLO = {
    "l": {
        "solo_id": "0:9820",
        "hang_id": "0:9822",
        "bent_id": "0:9824",
        "full": "full.sleeve-l.full.image",
        "dark": "full.sleeve-l.full.dark.image",
        "bent": "full.sleeve-l.bent.image",
        "solo_name": "full.arm-l.sleeveSolo",
    },
    "r": {
        "solo_id": "0:9821",
        "hang_id": "0:9823",
        "bent_id": "0:9825",
        "full": "full.sleeve-r.full.image",
        "dark": "full.sleeve-r.full.dark.image",
        "bent": "full.sleeve-r.bent.image",
        "solo_name": "full.arm-r.sleeveSolo",
    },
}


def extract_image_block(scene: str, name: str) -> tuple[str, str, str]:
    """Return (before, block, after) for an Image element by name."""
    pat = re.compile(
        rf'(<Image\b[^>]*\bname="{re.escape(name)}"[^>]*?)(?:/>|>.*?</Image>)',
        re.DOTALL,
    )
    m = pat.search(scene)
    if not m:
        raise SystemExit(f"missing image {name}")
    return scene[: m.start()], m.group(0), scene[m.end() :]


def unwrap_side(scene: str, side: str) -> str:
    """Flatten an existing sleeve Solo back to sibling Images (idempotent rebuild)."""
    cfg = SOLO[side]
    if f'name="{cfg["solo_name"]}"' not in scene:
        return scene
    start = scene.find(f'<Solo name="{cfg["solo_name"]}"')
    if start < 0:
        return scene
    end = scene.find("</Solo>", start)
    if end < 0:
        raise SystemExit(f"unclosed Solo {cfg['solo_name']}")
    end += len("</Solo>")
    solo_xml = scene[start:end]
    blocks = []
    for key in ("full", "dark", "bent"):
        m = re.search(
            rf'(<Image\b[^>]*\bname="{re.escape(cfg[key])}"[^>]*?)(?:/>|>.*?</Image>)',
            solo_xml,
            re.DOTALL,
        )
        if not m:
            raise SystemExit(f"missing {cfg[key]} inside Solo")
        blocks.append(m.group(0))
    scene = scene[:start] + "\n".join(blocks) + scene[end:]
    print(f"unwrapped solo {side}")
    return scene


def wrap_side(scene: str, side: str) -> str:
    cfg = SOLO[side]
    if f'name="{cfg["solo_name"]}"' in scene:
        print(f"solo already present for {side}")
        return scene

    # Extract the three sleeve images (order may vary); remove them then reinsert wrapped.
    blocks = {}
    for key in ("full", "dark", "bent"):
        before, block, after = extract_image_block(scene, cfg[key])
        blocks[key] = block
        scene = before + after

    solo = (
        f'<Solo name="{cfg["solo_name"]}" activeComponentId="{cfg["hang_id"]}" '
        f'id="{cfg["solo_id"]}">\n'
        f'<Node name="full.arm-{side}.sleeveHang" x="0" y="0" id="{cfg["hang_id"]}">\n'
        f'{blocks["full"]}\n{blocks["dark"]}\n'
        f"</Node>\n"
        f'<Node name="full.arm-{side}.sleeveBent" x="0" y="0" id="{cfg["bent_id"]}">\n'
        f'{blocks["bent"]}\n'
        f"</Node>\n"
        f"</Solo>"
    )

    # ROUND4: insert Solo before coat-shoulder so orange collar draws above sleeve.
    # Fall back to cuff if coat is missing (older scenes).
    anchor = f"full.arm-{side}.coat-shoulder.image"
    idx = scene.find(f'name="{anchor}"')
    if idx < 0:
        anchor = f"full.arm-{side}.cuff.image"
        idx = scene.find(f'name="{anchor}"')
    if idx < 0:
        raise SystemExit(f"coat/cuff anchor missing for arm-{side}")
    start = scene.rfind("<Image", 0, idx)
    scene = scene[:start] + solo + "\n" + scene[start:]
    return scene


def main() -> None:
    scene = SCENE.read_text(encoding="utf-8")
    # Always unwrap→wrap so ROUND4 coat-after-sleeve order is respected after remesh.
    scene = unwrap_side(scene, "l")
    scene = unwrap_side(scene, "r")
    scene = wrap_side(scene, "l")
    scene = wrap_side(scene, "r")
    SCENE.write_text(scene, encoding="utf-8")
    print("wrapped bent Solos", SOLO["l"]["solo_id"], SOLO["r"]["solo_id"])


if __name__ == "__main__":
    main()
