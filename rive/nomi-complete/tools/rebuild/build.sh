#!/usr/bin/env bash
# Rebuild the Nomi rig: segmentation -> painted layers -> scene.rml (bones, meshes, skins) -> animations.
# Needs uv (Python with numpy + opencv) and the Rive CLI. Run from anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
proj="$(cd "$here/../.." && pwd)"
py() { uv run -q --with numpy --with opencv-python-headless python "$@"; }
mkdir -p "$proj/rig"
py "$here/segment.py" "$here/owner.npz" "$proj/reference/svg-layered/mother-v2.png" "$proj/rig/seg.npz" "$(mktemp -d)/seg-preview.png"
py "$here/paint.py" "$proj/rig/seg.npz" "$proj/reference/svg-layered/mother-v2.png" "$proj/reference/svg-layered" "$proj/rig"
py "$here/split_sleeves.py" "$proj/rig"
py "$here/hand_rig.py" "$proj/rig" "$proj/reference/svg-layered/mother-v2.png"
py "$here/eyes.py" "$proj/rig" "$proj/reference/sheets/nomi-sheet-parts.png"
rm -f "$proj/rig/animations.xml"
py "$here/gen.py" "$proj/rig" "$here/contract.xml" "$proj/scene.rml" >/dev/null
py "$here/anim2.py" "$proj/rig"
py "$here/gen.py" "$proj/rig" "$here/contract.xml" "$proj/scene.rml"
(cd "$proj" && rive . --verify)
# rest pose must match mother-v2 pixel for pixel at 1:1 (scale 1 artboard, no animation)
vdir="$(mktemp -d)"
trap 'rm -rf "$vdir"' EXIT
echo "name: nomi-rest-check" > "$vdir/rive.yaml"
cp -R "$proj/rig/layers" "$proj/rig/parts.json" "$vdir/"
py "$here/gen.py" "$vdir" "$here/contract.xml" "$vdir/scene.rml" --verify >/dev/null
(cd "$vdir" && rive . --screenshot=rest.png --viewport=1024x1536 >/dev/null)
py "$here/check_rest.py" "$vdir/rest.png" "$proj/reference/svg-layered/mother-v2.png"
python3 -I "$here/svg.py" "$proj/rig" "$proj/reference/svg-layered/nomi-fullbody-layered.svg"
