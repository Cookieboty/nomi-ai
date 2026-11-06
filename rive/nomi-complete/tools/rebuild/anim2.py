"""Step 4: author every animation on the 2.5D rig (animations.xml).

usage: anim2.py <parts dir>   (needs ids.json from gen.py; run gen.py again afterwards)

Poses are rig3d poses (3D wrist targets, head / spine angles, leg angles) plus face controls; rig3d
projects them to the Rive bones. Hand shapes beyond the relaxed hand are separate painted sprites
(hand-<side>-g-<shape>) switched by opacity. Every action starts and ends at rest; `rest` keys every
channel any action uses, so a blend back to rest restores everything.
"""
import sys, os, json, math
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import rig3d  # noqa: E402

parts_dir = sys.argv[1]
ids = json.load(open(os.path.join(parts_dir, 'ids.json')))
meta = json.load(open(os.path.join(os.path.dirname(__file__), 'anims-meta.json')))
BID, IID, DRAW = ids['bone_id'], ids['images'], ids.get('draw', {})
K, OX = 1300 / 1536, 46.666666666666686
TO_ART = np.array([[K, 0, OX], [0, K, 0.0]])
REST = rig3d.rest_locals(TO_ART)
EASE = '<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>'
PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY']
GESTURES = ['fist', 'point', 'thumbsup', 'peace', 'ok', 'open']
FIST_HIDE = {'index-p0', 'index-p1', 'index-p2', 'thumb-p2', 'middle', 'ring', 'little'}
CURL_DEG = {'index': (30, 35, 25), 'thumb': (8, 14, 14), 'middle': (18,), 'ring': (18,), 'little': (18,)}
HAND_PRESET = {'fist': {'index': 1.0, 'thumb': 0.8, 'middle': 0.8, 'ring': 0.8, 'little': 0.8},
               'point': {'thumb': 0.6, 'middle': 0.8, 'ring': 0.8, 'little': 0.8},
               'thumbsup': {'index': 1.0, 'thumb': -0.6, 'middle': 0.8, 'ring': 0.8, 'little': 0.8},
               'peace': {'thumb': 0.6, 'ring': 0.8, 'little': 0.8, 'index': -0.2},
               'ok': {'index': 0.7, 'thumb': 0.7},
               'open': {'index': -0.3, 'thumb': -0.4, 'middle': -0.6, 'ring': -0.6, 'little': -0.6}}
HAND_PIECES = {s: [n for n in IID if n.startswith(f'hand-{s}-') and not n.endswith(('-clean', '-fist'))] for s in 'lr'}
BLUSH = ['head-cheek-l', 'head-cheek-c', 'head-cheek-r']
MOUTH_IMAGES = ['lips'] + [f'mouth-viseme-{v}' for v in 'aiueom']


# ------------------------------------------------------------------ pose -> channel values
def channels(pose):
    """{(bone, prop): value} for one pose (artboard units / radians), plus {image: opacity}, draw flags."""
    body = {k: v for k, v in pose.items() if not k.startswith(('_', 'front.'))}
    loc, _ = rig3d.pose_locals(body, TO_ART)
    out = {}
    for n, (x, y, r, sx, sy) in loc.items():
        for p, v in zip(PROPS, (x, y, r, sx, sy)):
            out[(n, p)] = v
    face = pose.get('_face', {})
    for s, sg in (('l', 1), ('r', -1)):
        e = f'full.eye.{s}'
        sy = face.get('eye_sy', 1.0) * face.get(f'eye_sy.{s}', 1.0)
        closed = sy < 0.45
        # squashing the open eye smears the lashes into a band: close by swapping to the drawn closed eye,
        # and keep squints mild
        out[(e, 'scaleY')] = out[(e, 'scaleY')] * (0.02 if closed else max(0.85, sy))
        b = f'full.brow.{s}'
        out[(b, 'y')] += K * face.get('brow_dy', 0)
        out[(b, 'rotation')] += math.radians(sg * face.get('brow_r', 0))
        g = f'full.eye.{s}.ball'
        gx, gy = face.get('gaze', (0, 0))
        out[(g, 'x')] = REST[g][0] + K * gx
        out[(g, 'y')] = REST[g][1] + K * gy
    img = {n: 0.0 for n in BLUSH if n in IID}
    for s in 'lr':
        sy = face.get('eye_sy', 1.0) * face.get(f'eye_sy.{s}', 1.0)
        if f'eye-{s}-closed-a' in IID:
            img[f'eye-{s}-closed-a'] = 1.0 if sy < 0.45 else 0.0
    if face.get('blush'):
        for n in BLUSH:
            if n in IID:
                img[n] = face['blush'] * (0.6 if n.endswith('-c') else 1.0)
    for s in 'lr':
        moved = f'arm.{s}' in pose          # the hand leaves its rest place: use the unmixed copies
        fist = pose.get(f'_hand.{s}') in ('fist', 'thumbsup')
        for n in HAND_PIECES[s]:
            # a fist seen from the back: palm + thumb + index base only, the curled fingers fold away
            hidden = fist
            img[n] = 0.0 if (moved or hidden) else 1.0
            if n + '-clean' in IID:
                img[n + '-clean'] = 1.0 if (moved and not hidden) else 0.0
        if f'hand-{s}-fist' in IID:
            img[f'hand-{s}-fist'] = 1.0 if fist else 0.0
    # fingers: curl toward the palm in the hand plane (degrees per joint at curl 1)
    for s in 'lr':
        g = pose.get(f'_hand.{s}')
        c = dict(HAND_PRESET.get(g, {}))
        c.update(pose.get(f'arm.{s}', {}).get('curl', {}))
        sg = -1 if s == 'l' else 1
        for f, pts in rig3d.HANDJ[s].items():
            v = c.get(f, c.get('all', 0.0))
            for i in range(len(pts) - 1):
                n = f'full.arm-{s}.{f}.j{i}'
                out[(n, 'rotation')] = REST[n][2] + math.radians(sg * v * CURL_DEG[f][i])
    draw = {s: bool(pose.get(f'front.{s}')) for s in 'lr'}
    return out, img, draw


def unwrap(prev, v):
    while v - prev > math.pi:
        v -= 2 * math.pi
    while v - prev < -math.pi:
        v += 2 * math.pi
    return v


REST_CH, REST_IMG, _ = channels({})


def render(name, aid, duration, loop, keys, force_all=False):
    keys = sorted(keys, key=lambda k: k[0])
    if keys[0][0] != 0:
        keys = [(0, {})] + keys
    if keys[-1][0] != duration and loop != 'loop':
        keys = keys + [(duration, {})]
    solved = [(fr, *channels(p)) for fr, p in keys]
    lines = [f'        <LinearAnimation name="{name}" loopValue="{loop}" duration="{duration}" fps="60" id="{aid}">']
    by_bone = {}
    for ch in REST_CH:
        vals = [s[1][ch] for s in solved]
        if ch[1] == 'rotation':
            v0 = REST_CH[ch]
            uv = []
            for v in vals:
                v0 = unwrap(v0, v)
                uv.append(v0)
            vals = uv
        if force_all or any(abs(v - REST_CH[ch]) > 1e-4 for v in vals):
            by_bone.setdefault(ch[0], []).append((ch[1], vals))
    for b, plist in by_bone.items():
        lines.append(f'            <KeyedObject objectId="{BID[b]}">')
        for p, vals in plist:
            lines.append(f'                <KeyedProperty property="{p}">')
            for (fr, *_), v in zip(solved, vals):
                lines.append(f'                    <KeyFrameDouble value="{v:.6f}" frame="{fr}" interpolationType="cubic">{EASE}</KeyFrameDouble>')
            lines.append('                </KeyedProperty>')
        lines.append('            </KeyedObject>')
    for n in REST_IMG:
        vals = [s[2][n] for s in solved]
        if force_all or any(abs(v - REST_IMG[n]) > 1e-4 for v in vals):
            hold = n.startswith(('hand-', 'eye-'))
            lines.append(f'            <KeyedObject objectId="{IID[n]}">')
            lines.append('                <KeyedProperty property="opacity">')
            for (fr, *_), v in zip(solved, vals):
                lines.append(f'                    <KeyFrameDouble value="{v:.3f}" frame="{fr}" interpolationType="hold"/>' if hold else
                             f'                    <KeyFrameDouble value="{v:.3f}" frame="{fr}" interpolationType="cubic">{EASE}</KeyFrameDouble>')
            lines.append('                </KeyedProperty>')
            lines.append('            </KeyedObject>')
    for s, d in DRAW.items():
        vals = [x[3][s] for x in solved]
        if force_all or any(vals):
            lines.append(f'            <KeyedObject objectId="{d["rules"]}">')
            lines.append('                <KeyedProperty property="drawTargetId">')
            for (fr, *_), v in zip(solved, vals):
                lines.append(f'                    <KeyFrameId value="{d["front"] if v else d["rest"]}" frame="{fr}" interpolationType="hold"/>')
            lines.append('                </KeyedProperty>')
            lines.append('            </KeyedObject>')
    lines.append('        </LinearAnimation>')
    return lines


def render_simple(name, aid, duration, loop, bone_keys, image_keys):
    """Keys for rest-kind bones (idle / blink layers) and the mouth images: bone_keys {(bone, prop): [(fr, v)]}"""
    lines = [f'        <LinearAnimation name="{name}" loopValue="{loop}" duration="{duration}" fps="60" id="{aid}">']
    byb = {}
    for (b, p), ks in bone_keys.items():
        byb.setdefault(b, []).append((p, ks))
    for b, plist in byb.items():
        lines.append(f'            <KeyedObject objectId="{BID[b]}">')
        for p, ks in plist:
            lines.append(f'                <KeyedProperty property="{p}">')
            for fr, v in ks:
                lines.append(f'                    <KeyFrameDouble value="{v:.6f}" frame="{fr}" interpolationType="cubic">{EASE}</KeyFrameDouble>')
            lines.append('                </KeyedProperty>')
        lines.append('            </KeyedObject>')
    for n, ks in image_keys.items():
        lines.append(f'            <KeyedObject objectId="{IID[n]}">')
        lines.append('                <KeyedProperty property="opacity">')
        for fr, v in ks:
            lines.append(f'                    <KeyFrameDouble value="{v:.3f}" frame="{fr}" interpolationType="hold"/>')
        lines.append('                </KeyedProperty>')
        lines.append('            </KeyedObject>')
    lines.append('        </LinearAnimation>')
    return lines


# ------------------------------------------------------------------ pose vocabulary
def merge(*ps):
    o = {}
    for p in ps:
        for k, v in p.items():
            if isinstance(v, dict) and isinstance(o.get(k), dict):
                o[k] = {**o[k], **v}
            else:
                o[k] = v
    return o


def arm(s, x, y, z, hand=(0, 0, 0), pole=None, shape=None, front=False, curl=None, elbow_z=None):
    # keep the arm close to the body plane: the drawing has no foreshortened sleeve, so reaching far
    # toward the viewer only shortens the arm while the cloth stays long
    a = {'target': (x, y, z * 0.35), 'hand': hand}
    if elbow_z is not None:
        a['elbow_z'] = elbow_z
    if curl is not None:
        a['curl'] = curl
    p = {f'arm.{s}': a}
    if shape:
        p[f'_hand.{s}'] = shape
    if front:
        p[f'front.{s}'] = 1
    return p


def face(**kw):
    return {'_face': kw}


def head(yaw=0, pitch=0, roll=0):
    return {'head': (yaw, pitch, roll)}


def spine(yaw=0, pitch=0, roll=0):
    return {'spine': (yaw, pitch, roll)}


def root(dx=0, dy=0):
    return {'root': (dx, dy)}


def squat(depth_deg):
    """Front-view squat: thighs swing toward the viewer, knees bend, feet stay flat and planted."""
    t = depth_deg
    k = 2 * t
    drop = (341.5 + 308.0) * (1 - math.cos(math.radians(t)))
    return merge(root(0, drop), {'leg.l': {'hip': (0, t, 6), 'knee': k, 'ankle': t},
                                 'leg.r': {'hip': (0, t, -6), 'knee': k, 'ankle': t}})


def osc(f0, f1, n, a, b):
    return [(round(f0 + (f1 - f0) * i / n), a if i % 2 == 0 else b) for i in range(n + 1)]


SMILE = face(eye_sy=0.75, blush=0.6, brow_dy=-1)
HAPPY = face(eye_sy=0.62, blush=0.9, brow_dy=-2)
A = {}

# greetings: elbow low, forearm up, palm toward the viewer
# wave: forearm up, fist on top (back of the hand to the viewer), the wrist rocks side to side
wave = merge(arm('r', 735, 300, 20, shape='fist', elbow_z=-0.1), head(-4, 0, 4), SMILE, spine(0, 0, -1.5))
wave_a = merge(wave, arm('r', 722, 302, 20, hand=(0, 0, -22), shape='fist', elbow_z=-0.1))
wave_b = merge(wave, arm('r', 748, 302, 20, hand=(0, 0, 22), shape='fist', elbow_z=-0.1))
A['full.wave'] = [(14, wave)] + osc(22, 88, 6, wave_a, wave_b) + [(100, {})]
hello = merge(arm('r', 705, 360, 105, hand=(0, -20, 0), pole=(1, 0.8, 0), shape='open'), head(-5, 2, 5), SMILE)
A['full.hello'] = [(14, hello)] + osc(20, 76, 4, merge(hello, arm('r', 698, 360, 108, hand=(0, -20, -20), pole=(1, 0.8, 0), shape='open')),
                                      merge(hello, arm('r', 712, 360, 102, hand=(0, -20, 18), pole=(1, 0.8, 0), shape='open'))) + [(88, {})]
cheer = merge(arm('l', 335, 255, 45, pole=(-1, 0.4, -0.2), shape='fist'), arm('r', 688, 255, 45, pole=(1, 0.4, -0.2), shape='fist'),
              root(0, -18), head(0, -6, 0), HAPPY)
A['full.cheer'] = [(12, merge(squat(10), arm('l', 360, 560, 70, shape='fist'), arm('r', 660, 560, 70, shape='fist'))), (26, cheer),
                   (40, merge(cheer, root(0, 0))), (54, merge(cheer, root(0, -16))), (72, merge(cheer, root(0, 0))), (88, {})]
cel_down = merge(arm('l', 370, 560, 80, shape='fist'), arm('r', 650, 560, 80, shape='fist'), squat(8), HAPPY)
A['full.celebrate'] = [(10, cel_down)] + osc(22, 100, 6, merge(cheer, root(0, -24)), cel_down) + [(112, {})]
# head gestures
A['full.nod'] = [(10, merge(head(0, 10, 0), face(eye_sy=0.9))), (22, head(0, -2, 0)), (34, merge(head(0, 11, 0), face(eye_sy=0.9))),
                 (48, head(0, 0, 0)), (60, head(0, 4, 0))]
A['full.shake'] = osc(6, 60, 6, merge(head(-13, 0, -2), face(gaze=(-2, 0))), merge(head(13, 0, 2), face(gaze=(2, 0))))
flinch = merge(arm('l', 468, 440, 110, shape='fist'), arm('r', 548, 440, 110, shape='fist'), {'shrug.l': 10, 'shrug.r': 10},
               spine(0, -5, 0), head(-8, 6, -6), root(0, 6), face(eye_sy=0.3, brow_dy=-4))
A['full.flinch'] = [(6, flinch), (30, flinch), (48, merge(flinch, root(0, 2))), (72, {})]
poke = merge(arm('l', 390, 500, 170, hand=(0, 70, 0), pole=(-1, 0.8, 0), shape='point'), head(6, 0, -3), face(gaze=(-2, 0)))
poke_in = merge(poke, arm('l', 395, 500, 205, hand=(0, 70, 0), pole=(-1, 0.8, 0), shape='point'))
A['full.poke'] = [(14, poke), (24, poke_in), (34, poke), (44, poke_in), (60, poke)]
clap_o = merge(arm('l', 458, 470, 115, hand=(0, 0, -70), shape='open'), arm('r', 560, 470, 115, hand=(0, 0, 70), shape='open'), SMILE)
clap_c = merge(arm('l', 494, 466, 125, hand=(0, 0, -80), shape='open'), arm('r', 522, 466, 125, hand=(0, 0, 80), shape='open'), SMILE)
A['full.clap'] = [(12, clap_o)] + osc(18, 78, 8, clap_c, clap_o) + [(86, {})]
think = merge(arm('r', 590, 235, 70, hand=(0, -20, 160), pole=(1, 0.3, -0.3), shape='point', front=True),
              arm('l', 470, 520, 100, hand=(0, 0, -70), pole=(-0.4, 1, 0.3)),
              head(6, -3, -6), face(gaze=(2, -3), brow_dy=-2))
A['full.think'] = [(18, think), (70, merge(think, head(8, -4, -8)))]
type_a = merge(arm('l', 455, 565, 150, hand=(0, 60, 0), curl={'all': 0.25}), arm('r', 562, 565, 150, hand=(0, 60, 0), curl={'all': 0.05}),
               head(0, 9, 0), face(gaze=(0, 3)))
type_b = merge(type_a, arm('l', 455, 565, 150, hand=(0, 60, 0), curl={'all': 0.05}), arm('r', 562, 565, 150, hand=(0, 60, 0), curl={'all': 0.25}))
A['full.work'] = [(12, type_a)] + osc(18, 78, 10, type_b, type_a)
A['full.typing'] = [(10, type_a)] + osc(14, 62, 12, type_b, type_a)
A['full.smile'] = [(10, merge(HAPPY, head(-3, 0, 4))), (38, merge(HAPPY, head(-3, 0, 5)))]
pump_up = merge(arm('r', 690, 320, 70, pole=(1, 0.5, -0.2), shape='fist'), spine(0, 0, -2), head(0, -3, 3), HAPPY)
pump_dn = merge(arm('r', 680, 420, 90, pole=(1, 0.5, -0.2), shape='fist'), spine(0, 0, -1), HAPPY)
A['full.fist_pump'] = [(10, pump_dn), (22, pump_up), (30, pump_dn), (40, pump_up), (48, pump_dn), (60, pump_up)]
bow = merge(spine(0, 24, 0), head(0, 9, 0), arm('l', 488, 640, 95, hand=(0, 0, -60), shape='open'),
            arm('r', 528, 640, 95, hand=(0, 0, 60), shape='open'), face(eye_sy=0.25))
A['full.bow'] = [(18, bow), (48, bow)]
salute = merge(arm('r', 588, 150, 60, hand=(0, -20, 120), pole=(1, -0.1, 0.1), shape='open', front=True), head(-3, -2, -2), face(brow_dy=-1))
A['full.salute'] = [(14, salute), (56, salute)]
prayer = merge(arm('l', 498, 410, 115, hand=(0, -20, -90), shape='open'), arm('r', 518, 410, 115, hand=(0, -20, 90), shape='open'),
               head(0, 9, 0), face(eye_sy=0.15, blush=0.3))
A['full.prayer'] = [(16, prayer), (58, merge(prayer, head(0, 11, 0)))]
okp = merge(arm('r', 690, 320, 85, hand=(0, -10, 0), pole=(1, 0.6, 0), shape='ok'), head(-4, 0, 4), SMILE)
A['full.ok'] = [(14, okp), (56, okp)]
expl_a = merge(arm('l', 335, 520, 125, hand=(0, -60, -40), pole=(-1, 0.8, 0), shape='open'), head(5, 0, -3), face(gaze=(-2, 0)))
expl_b = merge(expl_a, arm('l', 325, 505, 130, hand=(0, -60, -55), pole=(-1, 0.8, 0), shape='open'))
A['full.explain'] = [(12, expl_a)] + osc(18, 58, 4, expl_b, expl_a)
eur = merge(arm('r', 690, 245, 60, hand=(0, 0, 0), pole=(1, 0.4, 0), shape='point'), root(0, -10), head(0, -5, 0),
            face(eye_sy=1.12, brow_dy=-5))
A['full.eureka'] = [(8, merge(squat(6))), (18, eur), (56, merge(eur, root(0, 0)))]
puz = merge(head(-4, 0, 12), arm('r', 598, 128, 10, hand=(0, -10, 150), pole=(1, 0, 0), shape='point'),
            face(gaze=(2, -2), brow_dy=-3))
A['full.puzzled'] = [(16, puz)] + osc(24, 56, 4, merge(puz, arm('r', 592, 122, 10, hand=(0, -10, 160), pole=(1, 0, 0), shape='point')), puz)
A['full.look_around'] = [(14, merge(head(-15, 0, -2), face(gaze=(-4, 0)), spine(-5, 0, 0))), (34, merge(head(15, 0, 2), face(gaze=(4, 0)), spine(5, 0, 0))),
                         (52, merge(head(-8, 0, -1), face(gaze=(-3, 0)))), (62, {})]
A['full.look_lr'] = [(12, merge(head(-12, 0, 0), face(gaze=(-4, 0)))), (30, merge(head(-12, 0, 0), face(gaze=(-4, 0)))),
                     (44, merge(head(12, 0, 0), face(gaze=(4, 0)))), (60, merge(head(12, 0, 0), face(gaze=(4, 0))))]
peek = merge(spine(-6, 0, -7), head(-10, 0, -10), root(-10, 0), face(gaze=(-3, 0)), arm('r', 640, 450, 90, hand=(0, 0, 40)))
A['full.peek'] = [(14, peek), (50, merge(peek, face(gaze=(-4, 1))))]
heart = merge(arm('l', 492, 385, 120, hand=(0, -20, -40), curl={'all': 0.5}), arm('r', 524, 385, 120, hand=(0, -20, 40), curl={'all': 0.5}),
              head(0, 0, 5), HAPPY)
A['full.heart'] = [(16, heart), (56, merge(heart, head(0, 0, 7)))]
kiss_a = merge(arm('r', 528, 228, 95, hand=(0, -40, 150), pole=(0.6, 1, 0.3), shape='open', front=True), head(-4, 0, -4), face(eye_sy=0.3, blush=0.8))
kiss_b = merge(arm('r', 720, 300, 130, hand=(0, -40, 20), pole=(1, 0.6, 0), shape='open'), head(3, 0, 3), face(eye_sy=0.7, blush=0.8))
A['full.blow_kiss'] = [(14, kiss_a), (30, kiss_a), (44, kiss_b), (60, kiss_b)]
shy = merge(head(-4, 10, 8), face(eye_sy=0.6, gaze=(0, 3), blush=1.0), arm('l', 496, 600, 95, hand=(0, 0, -60)), arm('r', 520, 600, 95, hand=(0, 0, 60)),
            spine(0, 3, 2))
A['full.shy'] = [(14, shy)] + osc(22, 60, 4, merge(shy, head(-5, 11, 10)), shy)
apol = merge(bow, arm('l', 498, 450, 120, hand=(0, -20, -90), shape='open'), arm('r', 518, 450, 120, hand=(0, -20, 90), shape='open'),
             face(eye_sy=0.25, brow_r=-10))
A['full.apology'] = [(18, apol), (52, apol)]
surp = merge(arm('l', 445, 430, 60, hand=(0, -30, -20), pole=(-1, 0.6, -0.2), shape='open'),
             arm('r', 572, 430, 60, hand=(0, -30, 20), pole=(1, 0.6, -0.2), shape='open'),
             {'shrug.l': 8, 'shrug.r': 8}, root(0, -8), spine(0, -4, 0), head(0, -5, 0), face(eye_sy=1.15, brow_dy=-6))
A['full.surprise'] = [(6, surp), (40, merge(surp, root(0, 0))), (60, merge(surp, root(0, 0)))]
inh = merge(spine(0, -5, 0), head(0, -6, 0), face(eye_sy=0.4))
A['full.inhale'] = [(30, inh), (44, inh)]
smug = merge(arm('l', 425, 600, -15, hand=(0, 0, -100), pole=(-1, 0, -0.4), shape='fist'),
             arm('r', 592, 600, -15, hand=(0, 0, 100), pole=(1, 0, -0.4), shape='fist'),
             head(6, -4, -8), face(eye_sy=0.62, gaze=(-2, 0)), spine(0, -2, -2))
A['full.smug'] = [(14, smug), (60, merge(smug, head(7, -5, -9)))]
agg = merge(head(-3, 10, 6), face(eye_sy=0.7, gaze=(0, 3), brow_r=-14, brow_dy=-2), arm('l', 485, 655, 80, hand=(0, 0, -60)),
            arm('r', 530, 655, 80, hand=(0, 0, 60)), spine(0, 3, 1))
A['full.aggrieved'] = [(14, agg), (60, agg)]
wipe = arm('l', 470, 205, 75, hand=(0, -30, -150), pole=(-0.6, 1, 0.3), shape='fist', front=True)
A['full.tears'] = [(12, merge(agg, wipe))] + osc(18, 60, 8, merge(agg, wipe, head(-3, 11, 7)),
                                                 merge(agg, arm('l', 476, 198, 75, hand=(0, -30, -160), pole=(-0.6, 1, 0.3), shape='fist', front=True), head(-2, 9, 5)))
ang = merge(arm('l', 372, 690, 40, pole=(-1, 0.3, -0.5), shape='fist'), arm('r', 650, 690, 40, pole=(1, 0.3, -0.5), shape='fist'),
            {'shrug.l': 6, 'shrug.r': 6}, face(eye_sy=0.8, brow_r=16, brow_dy=2), head(0, 4, 0))
ang_b = merge(ang, root(0, 6))
A['full.angry'] = [(10, ang)] + osc(16, 60, 8, ang_b, ang)
sweat = merge(arm('r', 588, 160, -25, hand=(0, -10, 160), pole=(1, -0.2, -0.2), shape='open'), head(-4, 4, 6),
              face(gaze=(3, 0), brow_r=-10))
A['full.cold_sweat'] = [(14, sweat)] + osc(20, 60, 6, merge(sweat, head(-5, 5, 8)), sweat)
A['full.daze'] = [(10, merge(face(eye_sy=0.55), head(6, 0, 4)))] + [(10 + i * 10, merge(face(eye_sy=0.55), head(8 * math.sin(i * 1.2), 3, 6 * math.cos(i * 1.2))))
                                                                  for i in range(1, 6)]
thumbs = merge(arm('r', 655, 420, 110, hand=(0, -30, 80), pole=(1, 0.7, 0), shape='thumbsup'), head(-4, 0, 5), face(eye_sy=0.7, eye_sy_r=1, blush=0.3))
A['full.thumbs_up'] = [(14, thumbs), (58, thumbs)]
peace = merge(arm('r', 672, 255, 70, hand=(0, -10, 0), pole=(1, 0.5, -0.1), shape='peace', front=True), head(-4, 0, 7), HAPPY)
A['full.peace'] = [(14, peace), (58, merge(peace, head(-4, 0, 9)))]
air = merge(arm('l', 340, 690, 40), arm('r', 680, 690, 40))
A['full.hop'] = [(8, squat(14)), (20, merge(root(0, -48), air)), (34, merge(root(0, -52), air)), (46, squat(10)), (58, {})]
wink = merge(face(**{'eye_sy.r': 0.1}, blush=0.5), head(-3, 0, 8))
A['full.tongue'] = [(10, wink), (58, wink)]
yawn = merge(arm('r', 524, 232, 95, hand=(0, -40, 150), pole=(0.6, 1, 0.3), shape='open', front=True),
             head(0, -6, 0), face(eye_sy=0.1), spine(0, -3, 0))
A['full.yawn'] = [(20, yawn), (50, yawn)]
stretch = merge(arm('l', 488, 70, 20, pole=(-1, 0.1, 0), shape='fist'), arm('r', 528, 70, 20, pole=(1, 0.1, 0), shape='fist'),
                {'shrug.l': 6, 'shrug.r': 6}, spine(0, -4, 0), head(0, -6, 0), face(eye_sy=0.15), root(0, -6))
A['full.stretch'] = [(20, stretch), (46, merge(stretch, spine(0, -4, 4))), (56, merge(stretch, spine(0, -4, -4)))]
fist = merge(arm('l', 452, 515, 105, pole=(-1, 0.5, 0), shape='fist'), arm('r', 566, 515, 105, pole=(1, 0.5, 0), shape='fist'),
             face(eye_sy=0.85, brow_r=8))
A['full.fist'] = [(12, fist), (58, fist)]
sq = merge(squat(32), arm('l', 420, 690, 120, shape='open'), arm('r', 600, 690, 120, shape='open'))
A['full.squat'] = [(20, sq), (50, sq), (70, {})]


def gait(f0, f1, steps, swing, bob):
    out = []
    for i in range(steps * 2 + 1):
        fr = round(f0 + (f1 - f0) * i / (steps * 2))
        ph = i % 4
        if ph in (1, 3):
            s, o = ('l', 'r') if ph == 1 else ('r', 'l')
            sg = 1 if s == 'l' else -1
            legs = {f'leg.{s}': {'hip': (0, swing, 0), 'knee': swing * 1.6, 'ankle': swing * 0.4},
                    f'leg.{o}': {'hip': (0, -swing * 0.35, 0), 'knee': swing * 0.2}}
            lift = 341.5 * (1 - math.cos(math.radians(swing)))
            p = merge(legs, root(0, -bob + lift * 0.0), {'pelvis': (sg * 4, 0, 0)}, spine(-sg * 5, 0, 0), head(sg * 3, 0, 0),
                      arm(s, 330 if s == 'l' else 690, 735, -50), arm(o, 330 if o == 'l' else 690, 725, 70))
            out.append((fr, p))
        else:
            out.append((fr, root(0, 0)))
    return out


A['full.walk'] = gait(8, 248, 8, 22, 6)
A['full.run'] = gait(6, 172, 10, 38, 12)
A['full.step'] = gait(10, 140, 4, 22, 5)


# ------------------------------------------------------------------ idle / blink / mouth
def idle(dur):
    keys = {}
    for i in range(9):
        fr = round(dur * i / 8)
        ph = math.sin(2 * math.pi * i / 8)
        ph2 = math.sin(4 * math.pi * i / 8) * 0.6
        br = (1 - math.cos(4 * math.pi * i / 8)) / 2
        vals = {('full.breath', 'scaleY'): 1 + 0.012 * br, ('full.breath', 'y'): REST['full.breath'][1] - K * 1.2 * br,
                ('full.head.idle', 'rotation'): REST['full.head.idle'][2] + math.radians(1.2 * ph)}
        for s, sg in (('l', 1), ('r', -1)):
            vals[(f'full.hair.side.{s}.s1', 'rotation')] = math.radians(sg * 2.5 * ph)
            vals[(f'full.hair.side.{s}.s2', 'rotation')] = math.radians(sg * 3.0 * ph2)
            vals[(f'full.coat-{s}.front.s1', 'rotation')] = math.radians(0.8 * ph2)
            vals[(f'full.coat-{s}.front.s2', 'rotation')] = math.radians(1.2 * ph)
            vals[(f'full.hem.ribbon.{s}', 'rotation')] = math.radians(1.5 * ph2)
            vals[(f'full.hem.ribbon.{s}.s1', 'rotation')] = math.radians(2.0 * ph)
        vals[('full.hair.bow.sway', 'rotation')] = math.radians(3.0 * ph2)
        for k_ in range(5):
            phs = math.sin(2 * math.pi * i / 8 + k_ * 0.9)
            vals[(f'full.hair.strand{k_}.s0', 'rotation')] = REST[f'full.hair.strand{k_}.s0'][2] + math.radians(0.8 * phs)
            vals[(f'full.hair.strand{k_}.s1', 'rotation')] = REST[f'full.hair.strand{k_}.s1'][2] + math.radians(1.6 * phs)
        vals[('full.belt.id.sway', 'rotation')] = math.radians(2.5 * ph)
        vals[('full.belt.pouch.sway', 'rotation')] = math.radians(1.8 * ph2)
        for k, v in vals.items():
            keys.setdefault(k, []).append((fr, v))
    return keys


def blink_keys(starts, dur):
    """Blink = open eye squashes shut over 3 frames, the drawn closed eye shows for 4 frames."""
    ks, im = {}, {}
    for s in 'lr':
        seq = [(0, 1.0)]
        op = [(0, 0.0)]
        for f in starts:
            seq += [(f, 1.0), (f + 3, 0.02), (f + 7, 0.02), (f + 10, 1.0)]
            op += [(f + 3, 1.0), (f + 7, 0.0)]
        seq.append((dur, 1.0))
        op.append((dur, 0.0))
        ks[(f'full.eye.{s}.blink', 'scaleY')] = seq
        if f'eye-{s}-closed' in IID:
            im[f'eye-{s}-closed'] = op
    return ks, im


anims = []
for m in meta:
    name, aid, dur, loop, layer = m['name'], m['id'], int(m['duration']), m.get('loopValue', 'oneShot'), m['layer']
    if name == 'full.idle':
        anims += render_simple(name, aid, dur, loop, idle(dur), {})
    elif name == 'full.idle-blink':
        anims += render_simple(name, aid, dur, loop, *blink_keys([250, 560, 574, 840], dur))
    elif name == 'full.blink':
        anims += render_simple(name, aid, dur, loop, *blink_keys([8, 30], dur))
    elif layer == 'full.mouth':
        v = name.split('_')[-1] if 'viseme' in name else None
        imgs = {n: [] for n in MOUTH_IMAGES if n in IID}

        def put(fr, which):
            for n in imgs:
                imgs[n].append((fr, 1.0 if n == which else 0.0))
        if name == 'full.mouth_rest':
            put(0, 'lips'); put(dur, 'lips')
        elif v:
            put(0, f'mouth-viseme-{v}'); put(dur, f'mouth-viseme-{v}')
        else:
            for i, c in enumerate('aoeiao'):
                put(i * 10, f'mouth-viseme-{c}')
            put(dur - 6, 'lips'); put(dur, 'lips')
        anims += render_simple(name, aid, dur, loop, {}, imgs)
    elif name == 'rest':
        anims += render(name, aid, dur, loop, [(0, {}), (1, {})], force_all=True)
    else:
        assert name in A, name
        anims += render(name, aid, dur, loop, A[name])
open(os.path.join(parts_dir, 'animations.xml'), 'w').write('\n'.join(anims) + '\n')
print('animations:', sum(1 for l in anims if '<LinearAnimation' in l), 'lines', len(anims))
