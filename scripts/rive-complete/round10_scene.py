#!/usr/bin/env python3
"""ROUND10 scene patch: hem-ribbon crops grew upward (round10_layers.py) -> move their Images up by rows*S (artboard px).

Idempotent: reads the pinned ROUND9 hem-ribbon box (PIN_HEM) and the current rig-meta box."""
import json, re
import round10_layers as L

S = L.S
SCENE = L.PROJECT / "scene.rml"
ROOT_Y0 = {"l": -159.0885, "r": -159.0885}   # ROUND9 y of full.hem.ribbon.<side>.image


def main() -> None:
    boxes = json.loads(L.META.read_text())["boxes"]
    s = SCENE.read_text(encoding="utf-8")
    for side in "lr":
        rows = L.PIN_HEM[side][1] - boxes[f"hem-ribbon-{side}"][1]
        y = ROOT_Y0[side] - rows * S
        s, n = re.subn(rf'(<Image name="full\.hem\.ribbon\.{side}\.image" assetId="[^"]*" x="[^"]*" )y="[^"]*"',
                       lambda m: f'{m.group(1)}y="{y:.4f}"', s)
        assert n == 1, (side, n)
        print(side, "rows", rows, "y", round(y, 4))
    if "ROUND10" not in s:
        s = s.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND10: cuff band drawn once, ribbon shards moved to the hem-ribbon layer -->\n", 1)
    SCENE.write_text(s, encoding="utf-8")


if __name__ == "__main__":
    main()
