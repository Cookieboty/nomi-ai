#!/usr/bin/env python3
"""EXPERIMENTAL — do not apply by default.

Identity-tendon strip meshes on the current length=1 fullbody bones shatter
during elbow bends (double-transform when parented, or bind-space mismatch
when root-level). The working pattern is the r3 length-encoded bone + Tendon
rotation matrix approach on feat/mascot-rive-complete-parts. This script is
kept as a starting point for that follow-up.

Inject Image Mesh+Skin+Tendon strips onto continuous arm/sleeve layers.

Weights blend along upper→fore (upper sleeve/coat/skin) and fore→hand
(lower sleeve/cuff) so elbow and wrist rotations deform instead of shearing.
Safe to re-run: replaces any existing Mesh under the target Images.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive" / "nomi-complete" / "scene.rml"
SCALE = 0.8463541666666666
TRI = "AAECAQMCAgMEAwUEBAUGBQcG"
ROW_W = [(255, 0), (192, 63), (64, 191), (0, 255)]


def pack_blend(a: int, b: int) -> tuple[int, int]:
    return a | (b << 8), 1 | (2 << 8)


def bone_in_image(bx: float, by: float, ix: float, iy: float) -> tuple[float, float]:
    return (bx - ix) / SCALE, (by - iy) / SCALE


def strip_mesh(
    name: str,
    width: int,
    height: int,
    bone_a: str,
    bone_b: str,
    ta: tuple[float, float],
    tb: tuple[float, float],
    mesh_id: str,
    skin_id: str,
) -> str:
    rows = 4
    parts = [f'<Mesh triangleIndexBytes="{TRI}" name="{name}.mesh" id="{mesh_id}">']
    for i in range(rows):
        v = i / (rows - 1)
        y = height * v
        w0, w1 = ROW_W[i]
        if w1 == 0:
            vals, inds = 255, 1
        elif w0 == 0:
            vals, inds = 255, 2
        else:
            vals, inds = pack_blend(w0, w1)
        for side, x, u in (("l", 0, 0), ("r", width, 1)):
            parts.append(
                f'<ContourMeshVertex x="{x}" y="{y:.4f}" u="{u}" v="{v:.6f}" '
                f'name="{name}.{side}{i}"><Weight values="{vals}" indices="{inds}"/>'
                f"</ContourMeshVertex>"
            )
    parts.append(f'<Skin name="{name}.skin" id="{skin_id}">')
    parts.append(
        f'<Tendon boneId="{bone_a}" tx="{ta[0]:.4f}" ty="{ta[1]:.4f}" name="{name}.a"/>'
    )
    parts.append(
        f'<Tendon boneId="{bone_b}" tx="{tb[0]:.4f}" ty="{tb[1]:.4f}" name="{name}.b"/>'
    )
    parts.append("</Skin></Mesh>")
    return "".join(parts)


SPECS = [
    ("full.sleeve-l.upper.image", 190, 245, -76.2, 38.2, (0, 0), (-25.4, 215.5), "0:9213", "0:9215", "0:9700", "0:9701"),
    ("full.sleeve-l.upper.dark.image", 190, 245, -76.2, 38.2, (0, 0), (-25.4, 215.5), "0:9213", "0:9215", "0:9702", "0:9703"),
    ("full.sleeve-l.upper.orange.image", 190, 245, -76.2, 38.2, (0, 0), (-25.4, 215.5), "0:9213", "0:9215", "0:9704", "0:9705"),
    ("full.sleeve-l.lower.image", 210, 275, -71.9, -75.8, (0, 0), (-17, 174.3), "0:9215", "0:9217", "0:9706", "0:9707"),
    ("full.sleeve-l.lower.dark.image", 210, 275, -71.9, -75.8, (0, 0), (-17, 174.3), "0:9215", "0:9217", "0:9708", "0:9709"),
    ("full.sleeve-l.lower.orange.image", 210, 275, -71.9, -75.8, (0, 0), (-17, 174.3), "0:9215", "0:9217", "0:9710", "0:9711"),
    ("full.arm-l.cuff.image", 175, 150, -63.5, 76.2, (0, 0), (-17, 174.3), "0:9215", "0:9217", "0:9712", "0:9713"),
    ("full.arm-l.coat-shoulder.image", 165, 195, -29.7, -16.9, (0, 0), (-25.4, 215.5), "0:9213", "0:9215", "0:9714", "0:9715"),
    ("full.arm-l.upper-skin.image", 140, 190, 8.4, -59.2, (0, 0), (-25.4, 215.5), "0:9213", "0:9215", "0:9716", "0:9717"),
    ("full.sleeve-r.upper.image", 190, 245, -85.9, 38.2, (0, 0), (25.4, 215.5), "0:9219", "0:9221", "0:9720", "0:9721"),
    ("full.sleeve-r.upper.dark.image", 190, 245, -85.9, 38.2, (0, 0), (25.4, 215.5), "0:9219", "0:9221", "0:9722", "0:9723"),
    ("full.sleeve-r.upper.orange.image", 190, 245, -85.9, 38.2, (0, 0), (25.4, 215.5), "0:9219", "0:9221", "0:9724", "0:9725"),
    ("full.sleeve-r.lower.image", 210, 275, -105.8, -75.8, (0, 0), (17, 174.3), "0:9221", "0:9223", "0:9726", "0:9727"),
    ("full.sleeve-r.lower.dark.image", 210, 275, -105.8, -75.8, (0, 0), (17, 174.3), "0:9221", "0:9223", "0:9728", "0:9729"),
    ("full.sleeve-r.lower.orange.image", 210, 275, -105.8, -75.8, (0, 0), (17, 174.3), "0:9221", "0:9223", "0:9730", "0:9731"),
    ("full.arm-r.cuff.image", 175, 150, -84.6, 76.2, (0, 0), (17, 174.3), "0:9221", "0:9223", "0:9732", "0:9733"),
    ("full.arm-r.coat-shoulder.image", 165, 195, -110.0, -16.9, (0, 0), (25.4, 215.5), "0:9219", "0:9221", "0:9734", "0:9735"),
    ("full.arm-r.upper-skin.image", 140, 190, -127, -59.2, (0, 0), (25.4, 215.5), "0:9219", "0:9221", "0:9736", "0:9737"),
]


def inject(scene: str, img_name: str, mesh_xml: str) -> str:
    pat = re.compile(
        rf'(<Image name="{re.escape(img_name)}"[^>]*?)(?:/>|>.*?</Image>)',
        re.DOTALL,
    )
    m = pat.search(scene)
    if not m:
        raise SystemExit(f"image not found: {img_name}")
    open_tag = m.group(1)
    if open_tag.endswith("/"):
        open_tag = open_tag[:-1]
    replacement = f"{open_tag}>{mesh_xml}</Image>"
    return scene[: m.start()] + replacement + scene[m.end() :]


def main() -> None:
    scene = SCENE.read_text(encoding="utf-8")
    for img_name, w, h, ix, iy, ba, bb, bid_a, bid_b, mid, sid in SPECS:
        mesh_name = img_name.replace("full.", "").replace(".image", "").replace(".", "-")
        ta = bone_in_image(ba[0], ba[1], ix, iy)
        tb = bone_in_image(bb[0], bb[1], ix, iy)
        mesh = strip_mesh(mesh_name, w, h, bid_a, bid_b, ta, tb, mid, sid)
        scene = inject(scene, img_name, mesh)
    SCENE.write_text(scene, encoding="utf-8")
    print(f"meshes={scene.count('<Mesh ')}")


if __name__ == "__main__":
    main()
