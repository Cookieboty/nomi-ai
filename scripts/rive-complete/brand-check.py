"""Verify the production Rive scene only contains the full-body source rig."""

import hashlib
import json
import re
import sys
from pathlib import Path

R = Path(__file__).resolve().parents[2] / "rive/nomi-complete"
scene = (R / "scene.rml").read_text(encoding="utf-8")
files = re.findall(r'file="([^"]+)"', scene)
license_data = json.loads((R / "parts/DETAIL_LICENSE.json").read_text(encoding="utf-8"))["assets"]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


missing = [f for f in files if not (R / f).exists()]
stale = [f for f in files if f.startswith(("official/", "parts/", "reference/rig/", "reference/approved"))]
print(f"[1] scene files: {len(files)}, stale old refs: {len(stale)} {stale}, missing: {len(missing)} {missing}")
ok = not stale and not missing

problems = 0
for file in files:
    entry = license_data.get(file)
    if not entry or entry.get("ai_generated") is not False or entry.get("sha256") != sha(R / file):
        problems += 1
        print("LICENSE/SHA problem", file)
print(f"[2] licensed full-body assets: {len(license_data)}, problems: {problems}, LICENSE file: {(R / 'LICENSE').exists()}")
ok &= problems == 0 and (R / "LICENSE").exists()

required = ("source-nomi-master.png", "reference/svg-rig/nomi-fullbody-mother.svg")
for file in required:
    if file not in files:
        print("missing required full-body source", file)
        ok = False

print("FULLBODY RIVE LOCK", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
