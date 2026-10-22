#!/usr/bin/env python3
"""ROUND45 — lip-sync mouth visemes for Nomi.

Original art only has a closed smile (head-mouth.png). Open visemes are NEW art from that
palette (lip colour + blush kept; dark cavity / soft teeth band are new). Rest keeps the
existing head-mouthline so idle stays pixel-identical.

Viseme Images are direct children of full.head (same pattern as face.smile). Driver bone
full.mouth.shapes is keyed with g.mouth during yaw; each viseme Image x is keyed to the same
offset so lips stay attached.
ViewModel: Number viseme (0..6) + mouthOpen (0..1); Triggers mouth-open/close, talking, talk,
viseme_*. SM layer full.mouth. Idempotent (MARK)."""
from __future__ import annotations
import re, json, hashlib
from pathlib import Path
import round10_layers as L10
import round8_scene as R8
import round41_head_yaw_rig as R41

SCENE = L10.PROJECT / "scene.rml"
RIG = R41.RIG
MARK = "full.mouth.shapes"
VISEMES = ("a", "i", "u", "e", "o", "m")
META = json.loads(Path(__file__).with_name("mouth-visemes-r45.json").read_text())


def next_ids(s, n):
    m = R41.max_id(s)
    return [f"0:{m + 1 + i}" for i in range(n)]


def main():
    s = SCENE.read_text(encoding="utf-8")
    if MARK in s:
        print("ROUND45 mouth already wired"); return
    (kx, ky, bx, by), _ = R41.head_tex_frame(s)
    x0, y0, _, _ = META["rest"]["bbox"]
    ix, iy = bx + kx * x0, by + ky * y0
    ids = next_ids(s, 90)
    def take():
        return ids.pop(0)

    bone_id, rest_anim, talk_anim = take(), take(), take()
    vis_anim = {v: take() for v in VISEMES}
    vis_asset = {v: take() for v in VISEMES}
    vis_img = {v: take() for v in VISEMES}
    vm_viseme, vm_open = take(), take()
    vm_tr = {n: take() for n in ("mouth-open", "mouth-close", "talking", "talk",
                                 *(f"viseme_{v}" for v in VISEMES))}
    layer_id = take(); st_rest = take(); st = {v: take() for v in VISEMES}; st_talk = take()
    mouthline_id = re.search(r'<Image name="full\.head\.mouthline\.image"[^>]*id="(0:\d+)"', s).group(1)

    at = re.search(r'<ImageAsset name="fullbody-head-mouth"[^>]*>', s)
    add_assets = "".join(
        f'\n    <ImageAsset name="fullbody-mouth-viseme-{v}" file="reference/svg-rig/mouth-viseme-{v}.png" id="{vis_asset[v]}"/>'
        for v in VISEMES)
    s = s[:at.end()] + add_assets + s[at.end():]

    bone = f'<RootBone name="full.mouth.shapes" x="0" y="0" rotation="0" length="1" scaleX="1" id="{bone_id}"/>'
    imgs = "".join(
        f'<Image name="full.mouth.viseme.{v}.image" assetId="{vis_asset[v]}" x="{ix:.4f}" y="{iy:.4f}" '
        f'originX="0" originY="0" scaleX="{kx:.6f}" scaleY="{ky:.6f}" opacity="0" id="{vis_img[v]}"/>'
        for v in VISEMES)
    # first-declared draws on top: place right after mouthline so visemes cover head-face
    a, b = R8.find_elem(s, "Image", "full.head.mouthline.image")
    s = s[:b] + bone + imgs + s[b:]

    def opacity_anim(aid, name, hold, values):
        body = ""
        for oid, kfs in values.items():
            body += f'\n            <KeyedObject objectId="{oid}"><!--r45mouth--><KeyedProperty property="opacity">'
            body += "".join(f'<KeyFrameDouble value="{v:.4f}" frame="{f}" interpolationType="linear"/>' for f, v in kfs)
            body += "</KeyedProperty></KeyedObject>"
        return (f'\n        <LinearAnimation name="{name}" loopValue="oneShot" duration="{hold}" fps="60" id="{aid}">'
                f'{body}\n        </LinearAnimation>')

    rest_vals = {mouthline_id: [(0, 1.0)], **{vis_img[v]: [(0, 0.0)] for v in VISEMES}}
    anims = opacity_anim(rest_anim, "full.mouth_rest", 6, rest_vals)
    for v in VISEMES:
        # M/B/P is closed: keep original mouthline (pixel-identical smile), no overlay.
        if v == "m":
            vals = {mouthline_id: [(0, 1.0)], **{vis_img[w]: [(0, 0.0)] for w in VISEMES}}
        else:
            vals = {mouthline_id: [(0, 0.0)], **{vis_img[w]: [(0, 1.0 if w == v else 0.0)] for w in VISEMES}}
        anims += opacity_anim(vis_anim[v], f"full.viseme_{v}", 30, vals)

    order = ["rest", *VISEMES, "rest"]
    talk_body = ""
    for oid, kind in [(mouthline_id, "rest")] + [(vis_img[v], v) for v in VISEMES]:
        talk_body += f'\n            <KeyedObject objectId="{oid}"><!--r45mouth--><KeyedProperty property="opacity">'
        for i, name in enumerate(order):
            if oid == mouthline_id:
                val = 1.0 if name in ("rest", "m") else 0.0
            else:
                val = 1.0 if (name == kind and kind != "m") else 0.0  # M = original mouthline
            talk_body += (
                f'<KeyFrameDouble value="{val:.4f}" frame="{i*10}" interpolationType="hold"/>')
        talk_body += "</KeyedProperty></KeyedObject>"
    dur = (len(order) - 1) * 10
    anims += (f'\n        <LinearAnimation name="full.talk" loopValue="oneShot" duration="{dur}" fps="60" id="{talk_anim}">'
              f'{talk_body}\n        </LinearAnimation>')
    last = s.rfind("</LinearAnimation>\n") + len("</LinearAnimation>\n")
    s = s[:last] + anims + s[last:]

    s = s.replace(
        '<ViewModelPropertyTrigger name="step" id="0:292"/>',
        '<ViewModelPropertyTrigger name="step" id="0:292"/>\n'
        + f'        <ViewModelPropertyNumber name="viseme" id="{vm_viseme}"/>\n'
        + f'        <ViewModelPropertyNumber name="mouthOpen" id="{vm_open}"/>\n'
        + "".join(f'        <ViewModelPropertyTrigger name="{n}" id="{tid}"/>\n' for n, tid in vm_tr.items()),
        1)
    s = s.replace(
        '<ViewModelInstanceTrigger viewModelPropertyId="0:292"/>',
        '<ViewModelInstanceTrigger viewModelPropertyId="0:292"/>\n'
        + f'            <ViewModelInstanceNumber propertyValue="0" viewModelPropertyId="{vm_viseme}"/>\n'
        + f'            <ViewModelInstanceNumber propertyValue="0" viewModelPropertyId="{vm_open}"/>\n'
        + "".join(f'            <ViewModelInstanceTrigger viewModelPropertyId="{tid}"/>\n' for tid in vm_tr.values()),
        1)

    def trig_cond(tid):
        return (f'''                        <TransitionViewModelCondition>
                            <TransitionPropertyViewModelComparator>
                                <BindablePropertyTrigger>
                                    <DataBindContext sourcePathIds="0:9100-{tid}" propertyKey="686"/>
                                </BindablePropertyTrigger>
                            </TransitionPropertyViewModelComparator>
                            <TransitionValueTriggerComparator/>
                        </TransitionViewModelCondition>''')

    def num_cond(pid, val):
        return (f'''                        <TransitionViewModelCondition>
                            <TransitionPropertyViewModelComparator>
                                <BindablePropertyNumber propertyValue="{val}">
                                    <DataBindContext sourcePathIds="0:9100-{pid}" propertyKey="636"/>
                                </BindablePropertyNumber>
                            </TransitionPropertyViewModelComparator>
                            <TransitionValueNumberComparator value="{val}"/>
                        </TransitionViewModelCondition>''')

    def all_trans(exclude):
        parts = []
        if exclude != "rest":
            # Close only via mouth-close trigger (NOT viseme==0): number==0 would
            # immediately eject talk / trigger-driven opens while the VM number stays 0.
            parts.append(f'''                    <StateTransition stateToId="{st_rest}" duration="0">\n{trig_cond(vm_tr["mouth-close"])}\n                    </StateTransition>''')
        for i, v in enumerate(VISEMES, 1):
            if exclude == v: continue
            parts += [f'''                    <StateTransition stateToId="{st[v]}" duration="0">\n{trig_cond(vm_tr[f"viseme_{v}"])}\n                    </StateTransition>''',
                      f'''                    <StateTransition stateToId="{st[v]}" duration="0">\n{num_cond(vm_viseme, i)}\n                    </StateTransition>''']
        if exclude != "a":
            parts += [f'''                    <StateTransition stateToId="{st["a"]}" duration="0">\n{trig_cond(vm_tr["mouth-open"])}\n                    </StateTransition>''',
                      f'''                    <StateTransition stateToId="{st["a"]}" duration="0">\n{trig_cond(vm_tr["talking"])}\n                    </StateTransition>''']
        if exclude != "talk":
            parts.append(f'''                    <StateTransition stateToId="{st_talk}" duration="0">\n{trig_cond(vm_tr["talk"])}\n                    </StateTransition>''')
        return "\n".join(parts)

    layer = f'''            <StateMachineLayer name="full.mouth" id="{layer_id}">
                <AnyState x="0" y="-80"/>
                <ExitState x="400" y="-80"/>
                <EntryState>
                    <StateTransition stateToId="{st_rest}"/>
                </EntryState>
                <AnimationState x="200" y="0" animationId="{rest_anim}" id="{st_rest}">
{all_trans("rest")}
                </AnimationState>
'''
    for i, v in enumerate(VISEMES):
        layer += f'''                <AnimationState x="200" y="{(i+1)*80}" animationId="{vis_anim[v]}" id="{st[v]}">
{all_trans(v)}
                </AnimationState>
'''
    layer += f'''                <AnimationState x="200" y="560" animationId="{talk_anim}" id="{st_talk}">
                    <StateTransition stateToId="{st_rest}" duration="0" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>
{all_trans("talk")}
                </AnimationState>
            </StateMachineLayer>
'''
    m = re.search(r'(</StateMachineLayer>\n)(        </StateMachine>)', s)
    s = s[:m.end(1)] + layer + s[m.start(2):]
    SCENE.write_text(s, encoding="utf-8")

    d = json.loads(R41.LIC.read_text())
    for v in VISEMES:
        f = RIG / f"mouth-viseme-{v}.png"
        bb = f.read_bytes()
        d["assets"][f"reference/svg-rig/mouth-viseme-{v}.png"] = {
            "sha256": hashlib.sha256(bb).hexdigest(), "bytes": len(bb), "ai_generated": False,
            "in_scene": True,
            "method": "ROUND45: NEW art from original head-mouth palette (lip colour + blush); "
                      "dark oral cavity and soft teeth band are new. Rest uses original head-mouthline."}
    f = RIG / "mouth-viseme-rest.png"
    if f.exists():
        bb = f.read_bytes()
        d["assets"][f"reference/svg-rig/mouth-viseme-rest.png"] = {
            "sha256": hashlib.sha256(bb).hexdigest(), "bytes": len(bb), "ai_generated": False,
            "in_scene": False, "method": "ROUND45: crop of original head-mouth.png"}
    R41.LIC.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("ROUND45 mouth visemes", {"bone": bone_id, "ix": round(ix, 3), "iy": round(iy, 3),
                                    "vm_viseme": vm_viseme, "vm_mouthOpen": vm_open})


if __name__ == "__main__":
    main()
