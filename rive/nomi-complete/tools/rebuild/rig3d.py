"""2.5D rig for Nomi: a 3D skeleton whose poses are projected to 2D Rive bones.

Coordinates are mother pixels: x right, y down, z toward the viewer (right-handed). Rotations use the
screen convention: about z, positive turns clockwise on screen; about x, positive swings a limb that
points down toward the viewer; about y, positive turns the right side of the body toward the viewer.

Rive bones are of two kinds:
  seg   - follows a 3D segment (limbs, fingers): rotation = projected direction, scaleX = projected
          length / rest length, so a limb pointing at the viewer gets shorter (foreshortening)
  frame - follows a 3D frame at an anchor point (head parts, torso columns): the bone's x / y axes are the
          projected frame axes, so a head turn compresses parts in x and shifts them by their depth
Driven bones are keyed by the Actions layer (absolute pose). Idle / blink bones are children whose only
keys come from their own layers, so layers never fight over a property.
"""
import json
import math
import os

import numpy as np

HERE = os.path.dirname(__file__)
_HJ = os.path.join(HERE, 'hand-joints.json')
HANDJ = json.load(open(_HJ)) if os.path.exists(_HJ) else {'l': {}, 'r': {}}
_OLD = json.load(open(os.path.join(HERE, 'oldbones.json')))


def _old(name, z=0.0):
    x, y = _OLD[name]['mother']
    return (x, y, z)


# ------------------------------------------------------------------ 3D rest joints
J = {
    'root': (507, 700, 0), 'pelvis': (507, 640, 0), 'abdomen': (507, 520, 0), 'chest': (507, 400, 0),
    'neck': (507, 272, -6), 'head': (505, 232, -6),
}
FINGERS = ['thumb', 'index', 'middle', 'ring', 'little']
for s, sx in (('l', -1), ('r', 1)):
    J[f'clav.{s}'] = (507 + sx * 37, 283, 0)
    J[f'shoulder.{s}'] = ((398, 318, -4) if s == 'l' else (625, 318, -4))
    J[f'elbow.{s}'] = ((356, 548, -16) if s == 'l' else (667, 548, -16))
    J[f'wrist.{s}'] = ((320, 742, -4) if s == 'l' else (700, 742, -4))
    J[f'handend.{s}'] = ((316, 792, -4) if s == 'l' else (704, 792, -4))
    for f in FINGERS:
        pts = [_old(f'full.arm-{s}.{f}.j{i}', -4) for i in range(3)]
        tip = tuple(pts[2][k] + 0.8 * (pts[2][k] - pts[1][k]) for k in range(3))
        for i in range(3):
            J[f'{f}{i}.{s}'] = pts[i]
        J[f'{f}3.{s}'] = tip
    J[f'hip.{s}'] = ((452, 668, 0) if s == 'l' else (563, 668, 0))
    J[f'knee.{s}'] = ((469, 1010, 8) if s == 'l' else (558, 1010, 8))
    J[f'ankle.{s}'] = ((465, 1318, -4) if s == 'l' else (570, 1318, -4))
    J[f'toe.{s}'] = ((458, 1470, 40) if s == 'l' else (575, 1470, 40))
J = {k: np.array(v, float) for k, v in J.items()}


# ------------------------------------------------------------------ math
def rot(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    if axis == 'x':
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == 'y':
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler(yaw=0.0, pitch=0.0, roll=0.0):
    """yaw about y, pitch about x, roll about z (applied roll * pitch * yaw)."""
    return rot('z', roll) @ rot('x', pitch) @ rot('y', yaw)


class Xf:
    """Rigid 3D transform p -> R p + t."""

    def __init__(self, R=None, t=None):
        self.R = np.eye(3) if R is None else R
        self.t = np.zeros(3) if t is None else t

    def __matmul__(self, o):
        return Xf(self.R @ o.R, self.R @ o.t + self.t)

    def __call__(self, p):
        return self.R @ np.asarray(p, float) + self.t


def about(pivot, R):
    pivot = np.asarray(pivot, float)
    return Xf(R, pivot - R @ pivot)


# ------------------------------------------------------------------ pose solve
def two_bone(S, T, L1, L2, pole):
    """Shoulder S, target T, lengths, pole direction -> elbow, wrist (wrist may stop short)."""
    d = T - S
    dist = np.linalg.norm(d)
    dist = max(abs(L1 - L2) + 1e-3, min(L1 + L2 - 1e-3, dist))
    u = d / max(np.linalg.norm(d), 1e-9)
    W = S + u * dist
    a = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)
    a = max(-1, min(1, a))
    h = L1 * math.sqrt(1 - a * a)
    pole = np.asarray(pole, float)
    v = pole - (pole @ u) * u
    nv = np.linalg.norm(v)
    if nv < 1e-6:
        v = np.array([0, 0, -1.0]) - u[2] * u
        nv = np.linalg.norm(v)
    v /= nv
    E = S + u * (L1 * a) + v * h
    return E, W


def solve(pose):
    """pose -> dict of 3D world points and frames.

    pose keys (all optional, degrees / px):
      root: (dx, dy)             body offset
      pelvis: (yaw, pitch, roll)
      spine: (yaw, pitch, roll)  bend / twist of the torso, split 40 / 60 between abdomen and chest
      breathe: s                 (unused here; the idle layer does breathing)
      head: (yaw, pitch, roll)   neck 30%, head 70%
      neck_dy: px
      shrug.l / shrug.r: px      shoulder lift
      arm.l / arm.r: dict(target=(x,y,z) wrist target in body space, pole=(x,y,z),
                          hand=(yaw, pitch, roll) relative to the forearm, curl={finger: 0..1}, spread=deg)
      leg.l / leg.r: dict(hip=(yaw, pitch, roll), knee=deg (bend backwards), ankle=deg)
    """
    P = {}
    F = {}
    dx, dy = pose.get('root', (0, 0))
    root = Xf(t=np.array([dx, dy, 0.0]))
    pel = root @ about(J['pelvis'], euler(*pose.get('pelvis', (0, 0, 0))))
    sy, sp, sr = pose.get('spine', (0, 0, 0))
    abd = pel @ about(J['abdomen'], euler(0.4 * sy, 0.4 * sp, 0.4 * sr))
    chest = abd @ about(J['chest'], euler(0.6 * sy, 0.6 * sp, 0.6 * sr))
    hy, hp, hr = pose.get('head', (0, 0, 0))
    neck = chest @ about(J['neck'], euler(0.3 * hy, 0.3 * hp, 0.3 * hr)) @ Xf(t=np.array([0, pose.get('neck_dy', 0), 0.0]))
    head = neck @ about(J['head'], euler(0.7 * hy, 0.7 * hp, 0.7 * hr))
    F.update(root=root, pelvis=pel, abdomen=abd, chest=chest, neck=neck, head=head)
    for k in ['pelvis', 'abdomen', 'chest', 'neck', 'head']:
        P[k] = F[k](J[k])
    P['root'] = root(J['root'])
    for s in 'lr':
        lift = pose.get(f'shrug.{s}', 0)
        clav = chest @ Xf(t=np.array([0, -lift, 0.0]))
        F[f'clav.{s}'] = clav
        P[f'clav.{s}'] = chest(J[f'clav.{s}'])
        S = clav(J[f'shoulder.{s}'])
        a = pose.get(f'arm.{s}', {})
        L1 = np.linalg.norm(J[f'elbow.{s}'] - J[f'shoulder.{s}'])
        L2 = np.linalg.norm(J[f'wrist.{s}'] - J[f'elbow.{s}'])
        if 'target' in a:
            T = np.asarray(a['target'], float) + np.array([dx, dy, 0.0])
        else:
            T = clav(J[f'wrist.{s}'])
        sgn = -1 if s == 'l' else 1
        # elbow hangs down and a little out; when the hand comes up toward the face / chest the elbow
        # comes forward (toward the viewer), when it stays low the elbow goes slightly back
        high = float(np.clip((S[1] + 120 - T[1]) / 160.0, 0, 1))
        inward = float(np.clip((T[0] - S[0]) * sgn * -1 / 120.0, 0, 1))   # hand crosses toward the body
        fz = 0.9 * max(high, inward) - 0.35 * (1 - max(high, inward))
        pole = np.array([sgn * 0.35, 1.0, a.get('elbow_z', fz)])
        E, Wr = two_bone(S, T, L1, L2, pole)
        P[f'shoulder.{s}'], P[f'elbow.{s}'], P[f'wrist.{s}'] = S, E, Wr
        # hand frame: rest hand direction / palm normal rotated by the forearm swing, then the hand pose
        fore_rest = J[f'wrist.{s}'] - J[f'elbow.{s}']
        fore_now = Wr - E
        Rsw = _swing(fore_rest, fore_now)          # already includes the torso rotation
        Rh = Rsw @ euler(*a.get('hand', (0, 0, 0)))
        hand = Xf(Rh, Wr - Rh @ J[f'wrist.{s}'])
        F[f'hand.{s}'] = hand
        P[f'handend.{s}'] = hand(J[f'handend.{s}'])
        curl = a.get('curl', {})
        spread = a.get('spread', 0)
        # palm normal at rest: towards the body and a little back (the relaxed hand shows its back side)
        nrm = np.array([1.0, 0, -0.7]) if s == 'l' else np.array([-1.0, 0, -0.7])
        for fi, f in enumerate(FINGERS):
            c = curl.get(f, curl.get('all', 0.0))
            pts = [J[f'{f}{i}.{s}'] for i in range(4)]
            base = hand
            Pf = [hand(pts[0])]
            for i in range(3):
                seg = pts[i + 1] - pts[i]
                axis = np.cross(nrm, seg / np.linalg.norm(seg))
                axis /= max(np.linalg.norm(axis), 1e-9)
                ang = c * (55 if f == 'thumb' else (80, 95, 70)[i])
                Rb = _axis_angle(axis, ang * (1 if s == 'r' else -1) * -1)
                if i == 0 and spread and f != 'thumb':
                    Rb = Rb @ rot('z', spread * (fi - 2) * (-1 if s == 'l' else 1))
                base = base @ about(pts[i], Rb)
                Pf.append(base(pts[i + 1]))
            for i in range(4):
                P[f'{f}{i}.{s}'] = Pf[i]
        lg = pose.get(f'leg.{s}', {})
        hip = pel @ about(J[f'hip.{s}'], euler(*lg.get('hip', (0, 0, 0))))
        knee = hip @ about(J[f'knee.{s}'], rot('x', -lg.get('knee', 0)))
        ank = knee @ about(J[f'ankle.{s}'], rot('x', lg.get('ankle', 0)))
        F[f'hip.{s}'], F[f'knee.{s}'], F[f'ankle.{s}'] = hip, knee, ank
        P[f'hip.{s}'] = hip(J[f'hip.{s}'])
        P[f'knee.{s}'] = hip(J[f'knee.{s}'])
        P[f'ankle.{s}'] = knee(J[f'ankle.{s}'])
        P[f'toe.{s}'] = ank(J[f'toe.{s}'])
    return P, F


def _axis_angle(axis, deg):
    a = math.radians(deg)
    x, y, z = axis
    c, s, C = math.cos(a), math.sin(a), 1 - math.cos(a)
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def _swing(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    s = np.linalg.norm(v)
    c = float(a @ b)
    if s < 1e-9:
        return np.eye(3)
    return _axis_angle(v / s, math.degrees(math.atan2(s, c)))


# ------------------------------------------------------------------ Rive bones
# name: (parent, group, kind, spec, weight segment end (2D) or None)
B = {}
ORDER = []


def bone(name, parent, group, kind, spec, wend=None):
    B[name] = dict(name=name, parent=parent, group=group, kind=kind, spec=spec, wend=wend)
    ORDER.append(name)


bone('full.root', None, 'action', 'frame', ('root', (507, 700, 0)))
bone('full.pelvis', 'full.root', 'action', 'frame', ('pelvis', (507, 640, 0)), (507, 560))
for s in 'lr':
    bone(f'full.leg-{s}.upper', 'full.root', 'action', 'seg', (f'hip.{s}', f'knee.{s}'))
    bone(f'full.leg-{s}.lower', 'full.root', 'action', 'seg', (f'knee.{s}', f'ankle.{s}'))
    bone(f'full.leg-{s}.foot', 'full.root', 'action', 'seg', (f'ankle.{s}', f'toe.{s}'))
bone('full.breath', 'full.root', 'idle', 'rest', (507, 470))
bone('full.torso', 'full.breath', 'action', 'frame', ('abdomen', (507, 520, 0)), (507, 440))
for c, x, z in (('l', 440, -30), ('c', 507, 35), ('r', 574, -30)):
    bone(f'full.chest.{c}', 'full.breath', 'action', 'frame', ('chest', (x, 380, z)))
bone('full.neck', 'full.breath', 'action', 'frame', ('neck', (507, 268, -6)), (505, 232))
bone('full.head.idle', 'full.breath', 'idle', 'rest', (505, 232))
bone('full.head', 'full.head.idle', 'action', 'frame', ('head', (505, 232, -6)), (505, 120))
HEAD_PARTS = {
    # depths are kept shallow: the art is one flat drawing, so parallax only has to suggest volume
    'full.face.l': (452, 165, -14), 'full.face.c': (506, 165, 22), 'full.face.r': (560, 165, -14),
    'full.eye.l': (465, 162, 16), 'full.eye.r': (544, 157, 16),
    'full.lid.l': (465, 164, 17), 'full.lid.r': (545, 158, 17),
    'full.brow.l': (463, 134, 20), 'full.brow.r': (534, 127, 20),
    'full.nose': (506, 186, 30), 'full.mouth': (505, 212, 22), 'full.cheek': (506, 195, 20),
    # bangs ride the face columns (same depth), so a nod never opens a gap between bangs and forehead
    'full.hair.front.l': (452, 70, -14), 'full.hair.front.c': (507, 45, 22), 'full.hair.front.r': (562, 70, -14),
    'full.hair.side.l': (452, 140, 4), 'full.hair.side.r': (562, 140, 4),
    'full.hair.back': (507, 150, -30), 'full.hair.bow': (612, 150, -4), 'full.hair.clip': (580, 100, 20),
}
# the face is one flat drawing: parts sit at (almost) one depth so a nod / turn moves them together and
# never uncovers the painted face beneath; a small residual keeps a hint of volume on turns
for n, p in HEAD_PARTS.items():
    bone(n, 'full.head.idle', 'action', 'frame', ('head', (p[0], p[1], 22 + (p[2] - 22) * 0.15)))
for s, sg in (('l', -1), ('r', 1)):
    bone(f'full.eye.{s}.blink', f'full.eye.{s}', 'blink', 'rest',
         ((465, 169) if s == 'l' else (544, 164)))
    bone(f'full.eye.{s}.ball', f'full.eye.{s}.blink', 'action', 'rest', ((468, 165) if s == 'l' else (547, 160)))
    x0 = 507 + sg * 55
    bone(f'full.hair.side.{s}.s1', f'full.hair.side.{s}', 'idle', 'rest', (x0 + sg * 22, 215), (x0 + sg * 35, 290))
    bone(f'full.hair.side.{s}.s2', f'full.hair.side.{s}.s1', 'idle', 'rest', (x0 + sg * 35, 290), (x0 + sg * 42, 330))
bone('full.hair.bow.sway', 'full.hair.bow', 'idle', 'rest', (612, 150))
# bangs: five strands, each a two-bone chain from the crown to the strand tip, hung on the face column it
# lies over (so head turns keep the parallax), swayed only by the idle layer
STRANDS = [(447, 'l'), (474, 'l'), (505, 'c'), (535, 'r'), (563, 'r')]
for i, (x, col) in enumerate(STRANDS):
    bone(f'full.hair.strand{i}.s0', 'full.face.c', 'idle', 'rest', (x, 62), (x + (x - 505) * 0.12, 112))
    bone(f'full.hair.strand{i}.s1', f'full.hair.strand{i}.s0', 'idle', 'rest', (x + (x - 505) * 0.12, 112),
         (x + (x - 505) * 0.2, 165))
for s, sg in (('l', -1), ('r', 1)):
    bone(f'full.clav.{s}', 'full.breath', 'action', 'seg', (f'clav.{s}', f'shoulder.{s}'))
    bone(f'full.arm-{s}.upper', 'full.breath', 'action', 'seg', (f'shoulder.{s}', f'elbow.{s}'))
    bone(f'full.arm-{s}.fore', 'full.breath', 'action', 'seg', (f'elbow.{s}', f'wrist.{s}'))
    bone(f'full.arm-{s}.hand', 'full.breath', 'action', 'seg', (f'wrist.{s}', f'handend.{s}'))
    # cloth on the arm turns with it but is never squashed along the arm (a puffed sleeve does not
    # foreshorten like a bone; squashing it fans it out)
    bone(f'full.sleeve-{s}.upper', 'full.breath', 'action', 'seg', (f'shoulder.{s}', f'elbow.{s}'))
    bone(f'full.sleeve-{s}.fore', 'full.breath', 'action', 'seg', (f'elbow.{s}', f'wrist.{s}'))
    # fingers: fitted to the drawn hand (hand_rig.py), 2D children of the hand bone so they always stay on it
    for f, pts in HANDJ[s].items():
        par = f'full.arm-{s}.hand'
        for i in range(len(pts) - 1):
            n = f'full.arm-{s}.{f}.j{i}'
            bone(n, par, 'action', 'rest', tuple(pts[i]), tuple(pts[i + 1]))
            par = n
    cx = 507 + sg * 80
    bone(f'full.coat-{s}.front', 'full.breath', 'action', 'frame', ('chest', (cx, 410, -10)), (cx + sg * 2, 560))
    bone(f'full.coat-{s}.front.s1', f'full.coat-{s}.front', 'idle', 'rest', (cx + sg * 2, 560), (cx + sg * 8, 700))
    bone(f'full.coat-{s}.front.s2', f'full.coat-{s}.front.s1', 'idle', 'rest', (cx + sg * 8, 700), (cx + sg * 10, 760))
    rx, ry = (365, 662) if s == 'l' else (655, 706)
    bone(f'full.hem.ribbon.{s}', f'full.coat-{s}.front.s1', 'idle', 'rest', (rx, ry), (rx - sg * 5, ry + 140))
    bone(f'full.hem.ribbon.{s}.s1', f'full.hem.ribbon.{s}', 'idle', 'rest', (rx - sg * 5, ry + 140), (rx - sg * 9, ry + 290))
bone('full.belt.id', 'full.breath', 'action', 'frame', ('pelvis', (455, 512, 30)), (455, 640))
bone('full.belt.id.sway', 'full.belt.id', 'idle', 'rest', (455, 512), (455, 640))
bone('full.belt.pouch', 'full.breath', 'action', 'frame', ('pelvis', (592, 532, 20)), (600, 610))
bone('full.belt.pouch.sway', 'full.belt.pouch', 'idle', 'rest', (592, 532), (600, 610))

GROUP = {n: b['group'] for n, b in B.items()}


def world2d(name, P, F):
    """2x3 affine (columns: x axis, y axis, origin) of a driven bone for a solved pose."""
    b = B[name]
    if b['kind'] == 'seg':
        j0, j1 = b['spec']
        p0, p1 = P[j0][:2], P[j1][:2]
        r0, r1 = J[j0][:2], J[j1][:2]
        L = np.linalg.norm(r1 - r0)
        d = p1 - p0
        n = np.linalg.norm(d)
        if name.endswith('.hand') or name.startswith('full.sleeve-'):
            # the hand is a rigid drawing: turn it, never squash it; a sleeve follows half the
            # foreshortening of its arm so it stays on the arm without fanning out
            u = d / n if n > 1e-6 else (r1 - r0) / L
            k = 1.0 if name.endswith('.hand') else 0.5 + 0.5 * min(1.0, n / L)
            ay = np.array([-u[1], u[0]])
            if name.endswith('.fore') and name.startswith('full.sleeve-'):
                # a raised forearm: the cloth slides down to the elbow, so the puff (drawn at the cuff end)
                # flips along the forearm; the flip blends in between 'horizontal' and 'pointing up'
                up = -u[1]                                  # 1 = forearm straight up
                f = float(np.clip((up - 0.15) / 0.45, 0, 1))
                if f > 0:
                    sgn = 1 - 2 * f                         # +1 -> -1
                    Ln = n * k
                    origin = p0 + u * Ln * (1 - sgn) / 2    # flipped: the cuff end sits at the elbow
                    return np.column_stack([u * k * sgn, ay, origin])
            return np.column_stack([u * k, ay, p0])
        if n < 0.2 * L:   # pointing (almost) at the viewer: keep a stable direction
            u = (r1 - r0) / L if n < 1e-6 else d / n
            n = 0.2 * L
        else:
            u = d / n
        ax = u * (n / L)
        ay = np.array([-u[1], u[0]])
        return np.column_stack([ax, ay, p0])
    node, anchor = b['spec']
    X = F[node]
    o = X(anchor)[:2]
    ax = X.R[:2, 0]
    ay = X.R[:2, 1]
    return np.column_stack([ax, ay, o])


def rest_world2d(name):
    """Rest 2x3 affine of any bone (driven bones at rest, 'rest' bones at their pivot with identity axes)."""
    b = B[name]
    if b['kind'] == 'rest':
        x, y = b['spec']
        return np.array([[1.0, 0, x], [0, 1.0, y]])
    P, F = solve({})
    return world2d(name, P, F)


REST = {n: rest_world2d(n) for n in ORDER}


def seg2d(name):
    """Rest 2D segment used for skin weights."""
    b = B[name]
    W = REST[name]
    o = W[:, 2]
    if b['kind'] == 'seg':
        j0, j1 = b['spec']
        return J[j0][:2], J[j1][:2]
    if b['wend'] is not None:
        return o, np.array(b['wend'], float)
    return o, o


def _inv(A):
    M = A[:, :2]
    t = A[:, 2]
    Mi = np.linalg.inv(M)
    return np.column_stack([Mi, -Mi @ t])


def _mul(A, Bm):
    return np.column_stack([A[:, :2] @ Bm[:, :2], A[:, :2] @ Bm[:, 2] + A[:, 2]])


def decompose(A):
    """2x3 local affine -> x, y, rotation (rad), scaleX, scaleY (skew dropped)."""
    M = A[:, :2]
    sx = math.hypot(M[0, 0], M[1, 0])
    r = math.atan2(M[1, 0], M[0, 0])
    det = M[0, 0] * M[1, 1] - M[0, 1] * M[1, 0]
    sy = det / sx if sx > 1e-9 else 1.0
    return A[0, 2], A[1, 2], r, sx, sy


def pose_locals(pose, to_art):
    """Solve a pose -> {driven bone: (x, y, rotation, sx, sy)} local to its Rive parent, in artboard units.
    to_art: 2x3 affine mother px -> artboard units."""
    P, F = solve(pose)
    world = {}
    for n in ORDER:
        b = B[n]
        if b['kind'] == 'rest':
            par = world.get(b['parent'])
            rest_local = _mul(_inv(REST[b['parent']]), REST[n]) if b['parent'] else REST[n]
            world[n] = _mul(par, rest_local) if par is not None else REST[n]
        else:
            world[n] = world2d(n, P, F)
    out = {}
    for n in ORDER:
        if B[n]['kind'] == 'rest' and B[n]['group'] != 'action':
            continue
        if B[n]['kind'] == 'rest':
            continue
        wa = _mul(to_art, world[n])
        if B[n]['parent']:
            pa = _mul(to_art, world[B[n]['parent']])
            loc = _mul(_inv(pa), wa)
        else:
            loc = wa
        out[n] = decompose(loc)
    return out, P


def rest_locals(to_art):
    out = {}
    for n in ORDER:
        wa = _mul(to_art, REST[n])
        if B[n]['parent']:
            loc = _mul(_inv(_mul(to_art, REST[B[n]['parent']])), wa)
        else:
            loc = wa
        out[n] = decompose(loc)
    return out


def tendon(name, to_art):
    return _mul(to_art, REST[name])
