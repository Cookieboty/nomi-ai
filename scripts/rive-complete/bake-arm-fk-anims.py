#!/usr/bin/env python3
"""Bake relative arm rotation keys into length-bone absolute FK (x/y/rotation).

After add-arm-meshes.py migrates upper/fore/hand to independent RootBones with
rest rotation = limb angle and scaleX = length, legacy clips that keyed only
relative rotation must also key fore/hand translation and absolute rotation.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive" / "nomi-complete" / "scene.rml"
REST = Path("/workspace/scratch/rive-bone-rig/v2/arm-rest.json")

EASE = (
    '                        <CubicEaseInterpolator x1="0.42" y1="0" '
    'x2="0.58" y2="1"/>'
)

ARM_IDS = {
    "l": {"upper": "9213", "fore": "9215", "hand": "9217"},
    "r": {"upper": "9219", "fore": "9221", "hand": "9223"},
}


def parse_keyframes(prop_block: str) -> list[tuple[int, float, str]]:
    """Return [(frame, value, interp_inner_xml_or_empty)]."""
    keys = []
    for m in re.finditer(
        r'<KeyFrameDouble value="([^"]+)" frame="(\d+)" interpolationType="([^"]+)"([^>]*)(?:/>|>(.*?)</KeyFrameDouble>)',
        prop_block,
        re.DOTALL,
    ):
        val = float(m.group(1))
        frame = int(m.group(2))
        itype = m.group(3)
        inner = m.group(5) or ""
        keys.append((frame, val, itype, inner))
    return keys


def emit_keys(keys: list[tuple], prop: str) -> str:
    lines = [f'                <KeyedProperty property="{prop}">']
    for frame, val, itype, inner in keys:
        if itype == "cubic" and inner.strip():
            lines.append(
                f'                    <KeyFrameDouble value="{val}" frame="{frame}" '
                f'interpolationType="cubic">'
            )
            lines.append(inner.strip() if inner.strip().startswith("<") else EASE)
            lines.append("                    </KeyFrameDouble>")
        else:
            lines.append(
                f'                    <KeyFrameDouble value="{val}" frame="{frame}" '
                f'interpolationType="{itype}"/>'
            )
    lines.append("                </KeyedProperty>")
    return "\n".join(lines)


def keyed_object(oid: str, props_xml: list[str]) -> str:
    body = "\n".join(props_xml)
    return (
        f'            <KeyedObject objectId="0:{oid}">\n{body}\n'
        f"            </KeyedObject>"
    )


def interp_at(keys: list[tuple], frame: int) -> float:
    """Linear interpolate value at frame from key list."""
    if not keys:
        return 0.0
    keys = sorted(keys, key=lambda k: k[0])
    if frame <= keys[0][0]:
        return keys[0][1]
    if frame >= keys[-1][0]:
        return keys[-1][1]
    for i in range(len(keys) - 1):
        f0, v0 = keys[i][0], keys[i][1]
        f1, v1 = keys[i + 1][0], keys[i + 1][1]
        if f0 <= frame <= f1:
            if f1 == f0:
                return v1
            t = (frame - f0) / (f1 - f0)
            return v0 + (v1 - v0) * t
    return keys[-1][1]


def union_frames(*keylists) -> list[int]:
    frames = set()
    for keys in keylists:
        for k in keys:
            frames.add(k[0])
    return sorted(frames)


def bake_side(anim_body: str, side: str, rest: dict) -> str:
    ids = ARM_IDS[side]
    a1 = rest[side]["a1"]
    a2 = rest[side]["a2"]
    L1 = rest[side]["L1"]
    L2 = rest[side]["L2"]

    def extract_rot(oid: str) -> list:
        m = re.search(
            rf'<KeyedObject objectId="0:{oid}">(.*?)</KeyedObject>',
            anim_body,
            re.DOTALL,
        )
        if not m:
            return []
        pm = re.search(
            r'<KeyedProperty property="rotation">(.*?)</KeyedProperty>',
            m.group(1),
            re.DOTALL,
        )
        if not pm:
            return []
        return parse_keyframes(pm.group(1))

    ku = extract_rot(ids["upper"])
    kf = extract_rot(ids["fore"])
    kh = extract_rot(ids["hand"])
    if not ku and not kf and not kh:
        return anim_body  # nothing to bake

    # Idempotent: if upper rest key is already near absolute a1, skip this side.
    if ku and abs(ku[0][1] - a1) < 0.35:
        return anim_body

    # Treat missing as constant 0 relative
    frames = union_frames(ku, kf, kh)
    if not frames:
        return anim_body

    upper_keys = []
    fore_rot_keys = []
    fore_x_keys = []
    fore_y_keys = []
    hand_rot_keys = []
    hand_x_keys = []
    hand_y_keys = []
    # Use cubic ease on baked keys matching first available
    sample_inner = ""
    sample_itype = "cubic"
    for src in (ku, kf, kh):
        if src:
            sample_itype = src[0][2]
            sample_inner = src[0][3]
            break

    for f in frames:
        thu = interp_at(ku, f) if ku else 0.0
        thf = interp_at(kf, f) if kf else 0.0
        thh = interp_at(kh, f) if kh else 0.0
        ru = a1 + thu
        rf_ = a2 + thu + thf
        # Hand rest rot=0; absolute hand rot = inherited forearm delta + wrist.
        rh = thu + thf + thh
        fx = L1 * math.cos(ru)
        fy = L1 * math.sin(ru)
        hx = fx + L2 * math.cos(rf_)
        hy = fy + L2 * math.sin(rf_)
        upper_keys.append((f, ru, sample_itype, sample_inner))
        fore_rot_keys.append((f, rf_, sample_itype, sample_inner))
        fore_x_keys.append((f, fx, sample_itype, sample_inner))
        fore_y_keys.append((f, fy, sample_itype, sample_inner))
        hand_rot_keys.append((f, rh, sample_itype, sample_inner))
        hand_x_keys.append((f, hx, sample_itype, sample_inner))
        hand_y_keys.append((f, hy, sample_itype, sample_inner))

    def replace_or_insert(oid: str, props: list[str]) -> None:
        nonlocal anim_body
        block = keyed_object(oid, props)
        pat = re.compile(
            rf'            <KeyedObject objectId="0:{oid}">.*?</KeyedObject>',
            re.DOTALL,
        )
        if pat.search(anim_body):
            anim_body = pat.sub(block, anim_body, count=1)
        else:
            # insert before closing LinearAnimation — caller handles; append marker
            anim_body = anim_body + "\n" + block

    replace_or_insert(ids["upper"], [emit_keys(upper_keys, "rotation")])
    replace_or_insert(
        ids["fore"],
        [
            emit_keys(fore_x_keys, "x"),
            emit_keys(fore_y_keys, "y"),
            emit_keys(fore_rot_keys, "rotation"),
        ],
    )
    replace_or_insert(
        ids["hand"],
        [
            emit_keys(hand_x_keys, "x"),
            emit_keys(hand_y_keys, "y"),
            emit_keys(hand_rot_keys, "rotation"),
        ],
    )
    return anim_body


def main() -> None:
    rest = json.loads(REST.read_text())
    scene = SCENE.read_text(encoding="utf-8")
    count = 0

    def repl(m: re.Match) -> str:
        nonlocal count
        head, body, tail = m.group(1), m.group(2), m.group(3)
        new_body = body
        for side in ("l", "r"):
            new_body = bake_side(new_body, side, rest)
        if new_body != body:
            count += 1
        return head + new_body + tail

    scene2 = re.sub(
        r'(<LinearAnimation\b[^>]*>)(.*?)(</LinearAnimation>)',
        repl,
        scene,
        flags=re.DOTALL,
    )
    SCENE.write_text(scene2, encoding="utf-8")
    print(f"baked_animations={count}")


if __name__ == "__main__":
    main()
