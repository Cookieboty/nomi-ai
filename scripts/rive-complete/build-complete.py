#!/usr/bin/env python3
"""Generate rive/nomi-complete/{rive.yaml,scene.rml}: upper-body Nomi on COMPLETED parts.

Layers (back -> front): torso flanks (official-derived) / hands / completed arm meshes (3 bones: shoulder, elbow, wrist) /
body-noarm / strap + badge / head group.   Animations: idle (breath, sway, hair), wave (screen-right arm), cheer (both arms),
poses sampled from the canvas rig's own wave / celebrate tracks (scripts/rive-complete/harness/dump-params.js).
Run:  python3 scripts/rive-complete/make_sleeve_solid.py && make_arm_parts.py && make_hand_parts.py && build-complete.py
      ~/.rive/bin/rive rive/nomi-complete --once
"""
from __future__ import annotations
import base64, json, math, os, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(__file__).parent)); sys.path.insert(0, str(Path(__file__).parents[1] / 'rive-eval'))
from rml import El
from rc_common import *

PROJ = ROOT / 'rive/nomi-complete'
PARAMS = Path(os.environ.get('RC_PARAMS', str(ROOT / 'rive/nomi-complete/data')))
AB_W, AB_H = 960, 1300
FIG = (480.0, 1120.0)
NECK = (474.0, 395.52)
P_BY = {p['id']: p for p in PJ['parts']}
S_ELBOW = 340.0
STRAP_C = {'l': (128.0, 1127.0), 'r': (812.0, 1127.0)}
WRIST_PT = {'l': (147.0, 1196.0), 'r': (799.0, 1196.0)}
ZF = 0.8   # forearm foreshortening at z=1 (canvas rig: 0.45, but its forearm ends at the hand piece; ours includes the cuff, so it is shorter on screen)
CHAR_SIDE = {'r': 'L', 'l': 'R'}   # rig 'r' arm = screen-right = character's LEFT; never swapped

# ---------------------------------------------------------------- assets
assets: dict[str, El] = {}
def asset(key, rel):
    if key not in assets:
        assets[key] = El('ImageAsset', key, ident=True, file=rel)
    return assets[key]
def layer_asset(n): return asset(n, f'official/{P_BY[n]["file"]}')
def part_asset(n): return asset(n, f'parts/{n}.png')

def rel(a, b): return (a[0] - b[0], a[1] - b[1])
def node(name, pos, parent, **kw):
    r = rel(pos, parent); return El('Node', name, ident=True, x=r[0], y=r[1], **kw)
def image(name, parent_abs, **kw):
    p = P_BY[name]; r = rel(p['offset'], parent_abs)
    el = El('Image', name, ident=True, assetId=layer_asset(name).need_id(), x=r[0], y=r[1], originX=0, originY=0, **kw)
    if p['scale'] != 1: el.attrs['scaleX'] = el.attrs['scaleY'] = p['scale']
    return el
def back_to_front(parent, *kids):
    parent.add(*reversed(kids)); return parent
def smooth01(x):
    x = max(0.0, min(1.0, x)); return x * x * (3 - 2 * x)
def varuint(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def ns_of(a, x, y):
    dx, dy = x - a['s0'][0], y - a['s0'][1]
    return dx * a['w'][0] + dy * a['w'][1], dx * a['u'][0] + dy * a['u'][1]

# ---------------------------------------------------------------- arm (AI pose-state art, skinned 3-bone meshes)
AI_DIR = PARTS / 'ai'
AIM = json.loads((AI_DIR / 'ai_arms.json').read_text())
# similarity-fit of each state's art into rig space: scale (rig px per native art px) and rest direction
# r4 proportions (rig px; measured on the canvas rig renders, see docs/brand/rive-complete.md r4):
#  across-arm scale of each art (sleeve width), along-arm length = canvas rig length (bone stretch), hand size via the wrist tendon scale
SCALE = {'hang': 1.28, 'bent': 0.62, 'up': 0.60}   # isotropic art scale = sleeve width (hang 1.185 -> ~150 px incl. the part under the jacket)
HAND_SHRINK = {'hang': 1.30, 'bent': 1.38, 'up': 1.0}   # wrist-tendon scale: hand+cuff drawn at scale/HAND_SHRINK (canvas hand ~145-175 px tall)
REST_LEN = 490.0                     # shoulder pivot -> cuff centre at rest (canvas sleeve ends 468 px from the pivot, cuff centre ~ +0)
HOLD_L1, HOLD_L2 = 130.0, 195.0      # raised pose (canvas wave/cheer hold): pivot->elbow, elbow->cuff centre
REST_TILT = math.radians(78.0)       # hanging arm leans slightly outward (screen-right arm; mirrored for the left)
HAND_MASK_BACK = 72.0                # native art px above W (cuff centre) where the front hand copy starts (above cuff rim)
GRID = 30.0
CAP_Y = 108.0                        # native art px of the hang sleeve kept as a permanent shoulder cap (alpha fades out from ~62)
def wrap(a):
    while a > math.pi: a -= 2 * math.pi
    while a < -math.pi: a += 2 * math.pi
    return a

class ArtState:
    """one pose-state texture of one arm, fitted to the rig; joints in rig px."""
    def __init__(self, arm, state):
        self.arm, self.name = arm, state
        meta = AIM[state]; J = meta[arm.side]
        self.S, self.E, self.W = (tuple(J[k]) for k in ('S', 'E', 'W'))     # art (native) px
        s = SCALE[state]; self.s = s; self.sw = HAND_SHRINK[state]
        sx = sy = s
        if state == 'hang':
            axis = math.atan2(self.W[1] - self.S[1], self.W[0] - self.S[0])
            tilt = REST_TILT if arm.side == 'r' else math.pi - REST_TILT
            self.rot = tilt - axis
            sy = REST_LEN / math.hypot(self.W[0] - self.S[0], self.W[1] - self.S[1])   # art axis ~ art y: along-arm scale -> canvas rest length
        else:
            self.rot = 0.0
        self.sx, self.sy = sx, sy
        c, sn = math.cos(self.rot), math.sin(self.rot)
        self.M = np.array([[c, -sn], [sn, c]]) @ np.diag([sx, sy])
        P = arm.P
        self.to_rig = lambda p: (P[0] + self.M[0, 0] * (p[0] - self.S[0]) + self.M[0, 1] * (p[1] - self.S[1]),
                                 P[1] + self.M[1, 0] * (p[0] - self.S[0]) + self.M[1, 1] * (p[1] - self.S[1]))
        self.Sb, self.Eb, self.Wb = P, self.to_rig(self.E), self.to_rig(self.W)
        self.a1 = math.atan2(self.Eb[1] - self.Sb[1], self.Eb[0] - self.Sb[0])
        self.a2 = math.atan2(self.Wb[1] - self.Eb[1], self.Wb[0] - self.Eb[0])
        self.A1 = math.hypot(self.Eb[0] - self.Sb[0], self.Eb[1] - self.Sb[1])
        self.A2 = math.hypot(self.Wb[0] - self.Eb[0], self.Wb[1] - self.Eb[1])
        self.img = cv2.imread(str(AI_DIR / f'arm-{state}-{arm.side}.png'), cv2.IMREAD_UNCHANGED)
        self.verts = 0
    @property
    def dist(self): return math.hypot(self.Wb[0] - self.Sb[0], self.Wb[1] - self.Sb[1])

    def weights(self, px, py):
        """packed skin weight of an art-space point: shoulder / elbow / wrist"""
        S, E, W = self.S, self.E, self.W
        d1 = np.array([E[0] - S[0], E[1] - S[1]]); d1 /= np.linalg.norm(d1)
        d2 = np.array([W[0] - E[0], W[1] - E[1]]); d2 /= np.linalg.norm(d2)
        nb = d1 + d2; nb /= np.linalg.norm(nb)
        B = 70.0 if self.name == 'hang' else 55.0
        u2 = (px - E[0]) * nb[0] + (py - E[1]) * nb[1]       # signed distance across the elbow bisector plane
        u3 = (px - W[0]) * d2[0] + (py - W[1]) * d2[1]       # along the forearm; wrist bone owns cuff + hand
        w3 = smooth01((u3 + 84) / 44)
        w2 = smooth01((u2 + B) / (2 * B)) * (1 - w3)
        w1 = 1 - w2 - w3
        vals = [int(round(255 * v)) for v in (w1, w2, w3)]; vals[0] += 255 - sum(vals)
        return sum(v << (8 * i) for i, v in enumerate(vals)), sum((i + 1) << (8 * i) for i in range(3))

    def hand_front_png(self):
        im = self.img.copy(); H, W = im.shape[:2]
        yy, xx = np.mgrid[0:H, 0:W]
        d2 = np.array([self.W[0] - self.E[0], self.W[1] - self.E[1]]); d2 /= np.linalg.norm(d2)
        u3 = (xx - self.W[0]) * d2[0] + (yy - self.W[1]) * d2[1]
        keep = (u3 > -HAND_MASK_BACK).astype(np.float32)
        im[..., 3] = (im[..., 3].astype(np.float32) * keep).astype(np.uint8)
        p = AI_DIR / f'arm-{self.name}-{self.arm.side}-hand.png'; cv2.imwrite(str(p), im); return p

def cap_png(arm):
    im = arm.states['hang'].img.copy()
    yy = np.mgrid[0:im.shape[0], 0:im.shape[1]][0].astype(np.float32)
    f = np.clip((CAP_Y - yy) / (CAP_Y - 62.0), 0, 1); f = f * f * (3 - 2 * f)
    im[..., 3] = (im[..., 3].astype(np.float32) * f).astype(np.uint8)
    ys, xs = np.where(im[..., 3] > 0)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    p = AI_DIR / f'arm-hang-{arm.side}-cap.png'; cv2.imwrite(str(p), im[y0:y1, x0:x1]); return p, (x0, y0)

def ai_asset(rel): return asset(rel, f'parts/ai/{rel}.png')

class Arm:
    def __init__(self, side):
        self.side = side; a = self.a = arm_geom(side); self.sg = a['sg']
        self.P = tuple(a['pivot'])
        self.states = {s: ArtState(self, s) for s in ('hang', 'bent', 'up')}
        h = self.states['hang']
        self.W = h.Wb; self.bones = {}; self.mesh_els = {}; self.front_els = {}

    def make_rig(self, fig_abs):
        """Three independent RootBones (shoulder / elbow / wrist). A nested chain would make the foreshortening scaleX of a
        parent shear its rotated child (Rive has no skew), so joint positions are keyed from the IK solution instead.
        bone scaleX = current link length in rig px; each state's Tendon carries its bind length as a scale, so the skin
        transform is length/bind_length along the bone. Base values = hang pose."""
        h = self.states['hang']; P = self.P
        n = node(f'arm-{self.side}.rig', P, fig_abs)
        sh = El('RootBone', f'arm-{self.side}.shoulder', ident=True, x=0, y=0, rotation=h.a1, scaleX=h.A1, length=1)
        el = El('RootBone', f'arm-{self.side}.elbow', ident=True, x=h.Eb[0] - P[0], y=h.Eb[1] - P[1], rotation=h.a2, scaleX=h.A2, length=1)
        wr = El('RootBone', f'arm-{self.side}.wrist', ident=True, x=h.Wb[0] - P[0], y=h.Wb[1] - P[1], rotation=h.a2, length=1)
        n.add(sh, el, wr)
        self.bones = dict(sh=sh, el=el, wr=wr); self.rig = n
        return n

    def cap_image(self, fig_abs):
        p, (x0, y0) = cap_png(self); st = self.states['hang']
        rx, ry = st.to_rig((x0, y0))
        return El('Image', f'arm-{self.side}.shoulderCap', ident=True, assetId=ai_asset(f'arm-hang-{self.side}-cap').need_id(),
                  x=rx - fig_abs[0], y=ry - fig_abs[1], originX=0, originY=0, rotation=st.rot, scaleX=st.sx, scaleY=st.sy)

    def mesh_image(self, state, fig_abs, front=False):
        st = self.states[state]
        tex = st.img
        Ht, Wt = tex.shape[:2]
        if front:
            p = st.hand_front_png(); tex = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        ys, xs = np.where(tex[..., 3] > 8)
        x0, x1 = max(xs.min() - 6, 0), min(xs.max() + 6, Wt - 1); y0, y1 = max(ys.min() - 6, 0), min(ys.max() + 6, Ht - 1)
        cols = max(3, int(round((x1 - x0) / GRID)) + 1); rows = max(3, int(round((y1 - y0) / GRID)) + 1)
        verts = []
        for r in range(rows):
            for c in range(cols):
                px = x0 + (x1 - x0) * c / (cols - 1); py = y0 + (y1 - y0) * r / (rows - 1)
                rx, ry = st.to_rig((px, py))
                verts.append((rx, ry, px / Wt, py / Ht, px, py))
        idx = lambda r, c: r * cols + c
        bset = {idx(r, c) for r in range(rows) for c in range(cols) if r in (0, rows - 1) or c in (0, cols - 1)}
        order = sorted(bset) + [i for i in range(len(verts)) if i not in bset]
        newi = {o: n for n, o in enumerate(order)}
        tri = bytearray()
        for r in range(rows - 1):
            for c in range(cols - 1):
                p0, p1, p2, p3 = idx(r, c), idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c)
                for t3 in ((p0, p1, p2), (p0, p2, p3)):
                    for v in t3: tri += varuint(newi[v])
        nm = f'arm-{self.side}.{state}' + ('.hand' if front else '')
        key = f'arm-{state}-{self.side}' + ('-hand' if front else '')
        op = 1.0 if state == 'hang' and not front else 0.0
        el = El('Image', nm, ident=True, assetId=ai_asset(key).need_id(), x=-fig_abs[0], y=-fig_abs[1], originX=0, originY=0, opacity=op)
        mesh = El('Mesh', 'Mesh', triangleIndexBytes=base64.b64encode(bytes(tri)).decode())
        for i in order:
            rx, ry, u, v, px, py = verts[i]
            vals, inds = st.weights(px, py)
            vtx = El('ContourMeshVertex' if i in bset else 'MeshVertex', x=rx, y=ry, u=u, v=v)
            vtx.add(El('Weight', values=vals, indices=inds)); mesh.add(vtx)
        st.verts += len(verts)
        el.add(mesh)
        sk = El('Skin', 'Skin', xx=1, xy=0, yx=0, yy=1, tx=0, ty=0)
        for nm_, bid, ang, org, sig in (('shoulder', 'sh', st.a1, st.Sb, st.A1), ('elbow', 'el', st.a2, st.Eb, st.A2), ('wrist', 'wr', st.a2, st.Wb, st.sw)):
            c, s_ = math.cos(ang), math.sin(ang)
            sw_ = st.sw if bid == 'wr' else 1.0
            sk.add(El('Tendon', nm_, boneId=self.bones[bid].need_id(), xx=c * sig, xy=s_ * sig, yx=-s_ * sw_, yy=c * sw_, tx=org[0], ty=org[1]))
        mesh.add(sk)
        (self.front_els if front else self.mesh_els)[state] = el
        return el

# ---------------------------------------------------------------- animation machinery
CURVES = {'io': (0.42, 0, 0.58, 1), 'o': (0, 0, 0.58, 1), 'i': (0.42, 0, 1, 1)}
class Anim:
    def __init__(self, name, frames, loop):
        self.el = El('LinearAnimation', name, ident=True, loopValue='loop' if loop else 'oneShot', duration=int(frames), fps=60)
        self.items = {}; self.name = name; self.frames = int(frames)
    def key(self, target, prop, keys):
        _, props = self.items.setdefault(target.need_id(), (target, {}))
        props[prop] = sorted(keys, key=lambda k: k[0])
    def finish(self):
        for el, props in self.items.values():
            ko = El('KeyedObject', objectId=el.id)
            for prop, keys in props.items():
                kp = El('KeyedProperty', property=prop)
                for fr, v, e in keys:
                    kf = El('KeyFrameDouble', value=v, frame=int(fr))
                    if e == 's': kf.attrs['interpolationType'] = 'hold'
                    elif e == 'l': kf.attrs['interpolationType'] = 'linear'
                    else:
                        kf.attrs['interpolationType'] = 'cubic'
                        x1, y1, x2, y2 = CURVES[e]; kf.add(El('CubicEaseInterpolator', x1=x1, y1=y1, x2=x2, y2=y2))
                    kp.add(kf)
                ko.add(kp)
            self.el.add(ko)
        return self.el

def simplify(pts, eps):
    """Ramer-Douglas-Peucker on [(frame, value)]"""
    if len(pts) < 3: return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dmax, im = 0, 0
    for i in range(1, len(pts) - 1):
        t = (pts[i][0] - x0) / max(x1 - x0, 1e-9); yy = y0 + (y1 - y0) * t
        d = abs(pts[i][1] - yy)
        if d > dmax: dmax, im = d, i
    if dmax <= eps: return [pts[0], pts[-1]]
    return simplify(pts[:im + 1], eps)[:-1] + simplify(pts[im:], eps)

def swing(frames, cycles, amp, phase=0.0, base=0.0, n_per=4):
    n = cycles * n_per; keys = []
    for i in range(n + 1):
        t = i / n; keys.append((round(frames * t), base + amp * math.sin(2 * math.pi * cycles * t + phase), 'io'))
    keys[-1] = (frames, keys[0][1], 'io'); return keys

# ---------------------------------------------------------------- scene
class Scene:
    def __init__(self):
        self.ab = El('Artboard', 'Nomi', width=AB_W, height=AB_H, styleId='0:5'); self.ab.attrs['id'] = '0:2'; self.ab.id = '0:2'
        self.ab.add(El('LayoutComponentStyle', 'Artboard Style', id='0:5'))
        self.rest: dict = {}
        self.build()

    def build(self):
        ab = self.ab
        self.figIdle = node('fig.idle', FIG, (0, 0)); self.figAct = node('fig.act', FIG, FIG); self.figIdle.add(self.figAct)
        self.arms = {'l': Arm('l'), 'r': Arm('r')}
        rigs, back_meshes, front_meshes = [], [], []
        for sd, arm in self.arms.items():
            rigs.append(arm.make_rig(FIG))
        # AI pose-state art meshes. back -> front inside each arm: raised states over the hang state
        for sd, arm in self.arms.items():
            st_list = ['bent']
            for st in st_list: back_meshes.append(arm.mesh_image(st, FIG))
            back_meshes.append(arm.mesh_image('hang', FIG))
            for st in st_list: front_meshes.append(arm.mesh_image(st, FIG, front=True))
        caps = [arm.cap_image(FIG) for arm in self.arms.values()]
        flank_l = image('body-flank-l', FIG); flank_r = image('body-flank-r', FIG)
        body = image('body-noarm', FIG)
        # The official composite contains the exact neutral sleeves and jacket
        # seams from the supplied sheet. Keep it as the idle plate so the
        # neutral pose is pixel-faithful; action clips fade it out and reveal
        # the rigged arm meshes underneath.
        body_full = image('body', FIG, opacity=1.0)
        self.bodyFull = body_full
        self.badge = node('badge.idle', tuple(P_BY['badge']['pivot']), FIG); self.badge.add(image('badge', tuple(P_BY['badge']['pivot'])))
        self.strap = node('strap-r.idle', tuple(P_BY['strap-r']['pivot']), FIG); self.strap.add(image('strap-r', tuple(P_BY['strap-r']['pivot'])))
        # head
        self.headIdle = node('head.idle', NECK, FIG); self.headAct = node('head.act', NECK, NECK); self.headIdle.add(self.headAct)
        self.tails = {}
        tail_nodes = []
        for sd in ('l', 'r'):
            root = tuple(PJ['chains'][f'hair-tail-{sd}']['root'])
            tn = node(f'tail-{sd}.idle', root, NECK); tn.add(image(f'hair-tail-{sd}', root)); self.tails[sd] = tn; tail_nodes.append(tn)
        feats = []
        self.eye = {}
        for sd in ('l', 'r'):
            m = PJ['eyes'][sd]; cx = (m['x0'] + m['x1']) / 2; ep = (cx, m['top'])
            blink = node(f'eye-{sd}.blink', ep, NECK); look = node(f'iris-{sd}.look', ep, ep)
            look.add(image(f'iris-{sd}', ep))
            back_to_front(blink, image(f'eye-white-{sd}', ep), look, image(f'lash-{sd}', ep))
            feats.append(blink); self.eye[sd] = dict(blink=blink, look=look)
        # Face plates are kept as separate official rasters.  The runtime drives their
        # opacity through the state machine instead of recolouring pixels, so every
        # expression stays byte-identical to the supplied character sheet.
        mouth = image('mouth', NECK)
        mouth_open = image('mouth-open', NECK); mouth_open.attrs['opacity'] = 0
        mouth_o = image('mouth-o', NECK); mouth_o.attrs['opacity'] = 0
        mouth_frown = image('mouth-frown', NECK); mouth_frown.attrs['opacity'] = 0
        self.mouth = {
            'base': mouth,
            'open': mouth_open,
            'o': mouth_o,
            'frown': mouth_frown,
        }
        self.ribbon = node('ribbon.idle', tuple(PJ['joints']['ribbonKnot']), NECK)
        self.ribbon.add(image('ribbon', tuple(PJ['joints']['ribbonKnot'])))
        back_to_front(self.headAct, *tail_nodes, image('head', NECK), image('crown', NECK), *feats,
                      mouth, mouth_open, mouth_o, mouth_frown, image('bangs', NECK),
                      image('clip', NECK), self.ribbon, image('earring', NECK))
        # z: back -> front
        back_to_front(self.figAct, body_full, flank_l, flank_r, *rigs, *back_meshes, *caps, body, self.strap, self.badge, self.headIdle, *front_meshes)
        ab.add(self.figIdle)
        if os.environ.get('RC_BG'):   # review renders only: opaque cream backdrop so CLI frames match the canvas rig's bg
            bg = El('Shape', 'review.bg', ident=True, x=0, y=0)
            bg.add(El('Rectangle', 'r', originX=0, originY=0, width=AB_W, height=AB_H))
            f = El('Fill', 'f'); f.add(El('SolidColor', 'c', colorValue='FFF6EFE8')); bg.add(f)
            ab.add(bg)   # Rive paints the FIRST child on top, so the backdrop goes last
        self.flank_l, self.flank_r = flank_l, flank_r

    def rest_of(self, el, prop):
        if prop in el.attrs: return float(el.attrs[prop])
        return {'scaleX': 1, 'scaleY': 1, 'opacity': 1}.get(prop, 0.0)


class FullScene:
    """Full-body pose plates generated from the supplied character reference.

    The plates are deliberately kept as separate rasters so the face, costume,
    hands and shoes stay pixel-stable while Rive crossfades between neutral,
    wave and cheer poses.  This gives the renderer a usable full-body mode
    without mixing generated pixels into the official half-body layers above.
    """

    def __init__(self):
        # Keep the artboard origin at (0,0): the renderer and CLI select this
        # artboard directly, so an editor-stage offset would place its pixels
        # outside the capture viewport.
        self.ab = El('Artboard', 'Nomi-full', width=AB_W, height=AB_H, styleId='0:6')
        # Keep the runtime artboard in the same local viewport as the half-body
        # board. Without explicit coordinates the CLI lays the second board out
        # at x=1100 to avoid editor overlap, which makes screenshot/runtime
        # capture select an empty 960px viewport.
        self.ab.attrs['x'] = 0; self.ab.attrs['y'] = 0
        self.ab.attrs['id'] = '0:3'; self.ab.id = '0:3'
        self.ab.add(El('LayoutComponentStyle', 'Artboard Style Full', id='0:6'))
        self.pose = node('full.pose', (0, 0), (0, 0))
        self.plates = {}
        # The generated plates are 1024x1536 and share the same framing.  The
        # fixed scale leaves a small breathing margin on the 960x1300 artboard.
        scale = 0.82
        for name in ('neutral', 'wave', 'cheer'):
            path = PROJ / 'fullbody' / f'{name}.png'
            with Image.open(path) as im:
                width, height = im.size
            # Rive Image x/y is the local top-left when originX/originY are 0.
            # The previous center-origin placement put the full-body plates
            # outside the selected artboard, producing a blank screenshot.
            x = (AB_W - width * scale) / 2
            y = (AB_H - height * scale) / 2
            a = asset(f'full-{name}', f'fullbody/{name}.png')
            el = El('Image', f'full.{name}', ident=True, assetId=a.need_id(), x=x, y=y,
                    originX=0, originY=0, scaleX=scale, scaleY=scale,
                    opacity=1.0 if name == 'neutral' else 0.0)
            self.plates[name] = el
        back_to_front(self.pose, self.plates['neutral'], self.plates['wave'], self.plates['cheer'])
        self.ab.add(self.pose)

    def rest_of(self, el, prop):
        if prop in el.attrs: return float(el.attrs[prop])
        return {'scaleX': 1, 'scaleY': 1, 'opacity': 1}.get(prop, 0.0)


def build_full_action(sc: FullScene, name: str, plate: str):
    n = 72 if plate == 'wave' else 84
    an = Anim(f'full.{name}', n, False)
    for key, el in sc.plates.items():
        if key == 'neutral':
            values = [(0, 1.0 if plate == 'neutral' else 0.0, 'l'),
                      (4, 1.0 if plate == 'neutral' else 0.0, 'io'),
                      (n, 1.0 if plate == 'neutral' else 0.0, 'l')]
        else:
            values = [(0, 1.0 if key == plate else 0.0, 'l'),
                      (4, 1.0 if key == plate else 0.0, 'io'),
                      (n, 1.0 if key == plate else 0.0, 'l')]
        an.key(el, 'opacity', values)
    # A tiny settle makes the full-body action read as an animation even when
    # the source plate itself is a single high-resolution frame.
    an.key(sc.pose, 'scaleY', [(0, 1.0, 'io'), (n // 2, 1.008, 'io'), (n, 1.0, 'io')])
    return an


def build_full_idle(sc: FullScene):
    n = 216; an = Anim('full.idle', n, True)
    an.key(sc.plates['neutral'], 'opacity', [(0, 1.0, 'l'), (n, 1.0, 'l')])
    an.key(sc.pose, 'scaleY', [(0, 1.0, 'io'), (n // 2, 1.006, 'io'), (n, 1.0, 'io')])
    return [an]

# ---------------------------------------------------------------- actions from the canvas rig's own tracks
def load_rows(name):
    return json.loads((PARAMS / f'{name}.json').read_text())

MID_X2 = 2 * 476.0   # mirror axis between the two shoulder pivots (rig x)
HAND_XMIN = 722
HAND_D = 52.0        # canvas hand anchor -> cuff centre distance (rig px)
X_MAX_SWING = 735.0  # max wrist x while swinging (hand still points sideways)
X_MAX = 830.0        # max wrist x for the screen-right arm during swings (mirrored for the left)
def _unwrap(v):
    out = [v[0]]
    for x in v[1:]:
        while x - out[-1] > math.pi: x -= 2 * math.pi
        while x - out[-1] < -math.pi: x += 2 * math.pi
        out.append(x)
    return out

def ik_art(arm, rows, pre, state):
    """Two-link IK per frame. The target wrist is the canvas rig's own hand anchor (same timestamps); link lengths and the
    reach distance morph from the hang art's to the raised-state art's by w (raise amount from the canvas hand height); the
    elbow branch is the one closest to the art's own bind direction so a bent-elbow art keeps its upper arm out to the side."""
    hang, tgt_st = arm.states['hang'], arm.states[state]
    def tgt(r):
        h = r['hand']; return (h['hx'] + HAND_D * math.sin(h['hPsi']), h['hy'] - HAND_D * math.cos(h['hPsi']))
    t0 = tgt(rows[0])
    flip = -1.0 if arm.side == 'l' else 1.0
    P = arm.P; Wrest = hang.Wb
    def canvasT(r):
        t = tgt(r); z = max(0.0, min(1.0, r[pre + 'Z']))
        tx = t[0] if flip > 0 else MID_X2 - t[0]; ox = t0[0] if flip > 0 else MID_X2 - t0[0]
        zb = max(0.0, min(1.0, z / 0.8))
        tx = max(tx, HAND_XMIN) if flip > 0 else min(tx, MID_X2 - HAND_XMIN)
        return (tx + (1 - zb) * (Wrest[0] - ox), t[1] + (1 - zb) * (Wrest[1] - t0[1]))
    holdT = [canvasT(r) for r in rows if r[pre + 'Z'] > 0.8]
    Thold_y = sum(t[1] for t in holdT) / len(holdT)
    A, E, WR, L1, L2, Wx, Wy, Wl = [], [], [], [], [], [], [], []
    for r in rows:
        Tc = canvasT(r)
        w = smooth01(((Wrest[1] - Tc[1]) / (Wrest[1] - Thold_y) - 0.22) / 0.6)    # raise amount from the canvas hand height
        T = Tc                                                                    # canvas rig's own wrist target: no re-scaling
        xm = X_MAX_SWING + (X_MAX - X_MAX_SWING) * smooth01((w - 0.92) / 0.08)   # hand points sideways mid-swing: keep it on the artboard
        T = (min(T[0], xm) if arm.side == 'r' else max(T[0], MID_X2 - xm), T[1])   # keep the wrist (and the big hand) inside the artboard
        l1 = hang.A1 + (HOLD_L1 - hang.A1) * w; l2 = hang.A2 + (HOLD_L2 - hang.A2) * w   # canvas-length links
        dx, dy = T[0] - P[0], T[1] - P[1]
        d = max(abs(l1 - l2) + 1.0, min(l1 + l2 - 0.05, math.hypot(dx, dy)))
        th = math.atan2(dy, dx)
        al = math.acos(max(-1, min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))))
        # elbow branch: elbow stays low/out and lifts as the forearm comes up (screen-right arm: th + al; mirrored for the left arm)
        a1w = th + al if arm.side == 'r' else th - al
        ex, ey = P[0] + l1 * math.cos(a1w), P[1] + l1 * math.sin(a1w)
        wx_, wy_ = P[0] + d * math.cos(th), P[1] + d * math.sin(th)     # wrist on the (clamped) reach circle
        a2w = math.atan2(wy_ - ey, wx_ - ex)
        hp = r['hand']['hPsi']
        thh = math.atan2(-math.cos(hp), math.sin(hp))
        thh_eff = thh if arm.side == 'r' else math.pi - thh
        A.append(a1w); E.append(a2w); WR.append(thh_eff - a2w); L1.append(l1); L2.append(l2)
        Wx.append(wx_ - P[0]); Wy.append(wy_ - P[1]); Wl.append(w)
    E = _unwrap(E); A = _unwrap(A)
    W0 = WR[0]; WR = _unwrap([x - W0 for x in WR])
    # hand roll follows the canvas hand angle partially (clamped); art hands are upright continuations of the forearm
    WR = [max(-0.45, min(0.45, 0.55 * x)) * w for x, w in zip(WR, Wl)]
    return dict(A=A, E=E, WR=WR, L1=L1, L2=L2, Wx=Wx, Wy=Wy, w=Wl)

def build_action(sc: Scene, name: str, src: str, sides: dict[str, str], state: str):
    d = load_rows(src); rows = d['rows']; n = len(rows) - 1
    an = Anim(name, n, False)
    def track(vals, eps):
        return simplify([(r['f'], v) for r, v in zip(rows, vals)], eps)
    for side, pre in sides.items():
        arm = sc.arms[side]
        k = ik_art(arm, rows, pre, state); arm.last = k
        A, E, WR, L1, L2, Wx, Wy = (k[q] for q in ('A', 'E', 'WR', 'L1', 'L2', 'Wx', 'Wy'))
        ex = [l * math.cos(a) for l, a in zip(L1, A)]; ey = [l * math.sin(a) for l, a in zip(L1, A)]
        an.key(arm.bones['sh'], 'scaleX', [(f, v, 'l') for f, v in track(L1, 0.4)])
        an.key(arm.bones['el'], 'scaleX', [(f, v, 'l') for f, v in track(L2, 0.4)])
        an.key(arm.bones['sh'], 'rotation', [(f, v, 'l') for f, v in track(A, 0.004)])
        an.key(arm.bones['el'], 'rotation', [(f, v, 'l') for f, v in track(E, 0.004)])
        an.key(arm.bones['wr'], 'rotation', [(f, v, 'l') for f, v in track([e + w for e, w in zip(E, WR)], 0.004)])
        for bn, xs, ys in (('el', ex, ey), ('wr', Wx, Wy)):
            an.key(arm.bones[bn], 'x', [(f, v, 'l') for f, v in track(xs, 0.3)])
            an.key(arm.bones[bn], 'y', [(f, v, 'l') for f, v in track(ys, 0.3)])
        # crossfade hang art -> raised-state art (hang stays underneath until the raised art is fully opaque)
        alpha = [1.0 if w >= 0.56 else 0.0 for w in k["w"]]   # hard switch: no double-exposed hands/sleeves
        an.key(arm.mesh_els[state], 'opacity', [(f, v, 'l') for f, v in track(alpha, 0.02)])
        an.key(arm.front_els[state], 'opacity', [(f, v, 'l') for f, v in track(alpha, 0.02)])
        an.key(arm.mesh_els['hang'], 'opacity', [(f, v, 'l') for f, v in track([1.0 if a_ < 0.999 else 0.0 for a_ in alpha], 0.02)])
    an.key(sc.figAct, 'y', [(f, v, 'l') for f, v in track([r['bodyY'] for r in rows], 0.15)])
    an.key(sc.figAct, 'x', [(f, v, 'l') for f, v in track([r['torsoX'] for r in rows], 0.15)])
    an.key(sc.headAct, 'rotation', [(f, v, 'l') for f, v in track([r['headRot'] for r in rows], 0.004)])
    if 'r' in sides:
        an.key(sc.strap, 'opacity', [(f, 1 - min(1.0, v), 'l') for f, v in track([r['rOn'] for r in rows], 0.02)])
    # Reveal the rigged action arms for this clip; the official composite is
    # restored by the shared rest animation after the one-shot completes.
    an.key(sc.bodyFull, 'opacity', [(0, 0.0, 'l'), (n, 0.0, 'l')])
    return an

def build_idle(sc: Scene):
    out = []; n = 216
    a = Anim('idle.breath', n, True)
    a.key(sc.figIdle, 'scaleY', [(0, 1.0, 'io'), (n // 2, 1.011, 'io'), (n, 1.0, 'io')])
    a.key(sc.figIdle, 'scaleX', [(0, 1.0, 'io'), (n // 2, 1.003, 'io'), (n, 1.0, 'io')])
    a.key(sc.headIdle, 'rotation', [(0, -0.012, 'io'), (n // 2, 0.014, 'io'), (n, -0.012, 'io')])
    a.key(sc.badge, 'rotation', swing(n, 1, 0.05, 0.6)); a.key(sc.strap, 'rotation', swing(n, 1, 0.012, 1.2))
    out.append(a)
    # A short loop with two natural blinks.  The eye groups are already isolated at
    # their upper-lid pivots, so this preserves the iris and lash artwork while the
    # rest of the character continues its breathing loop.
    n = 180; a = Anim('idle.blink', n, True)
    for side in ('l', 'r'):
        eye = sc.eye[side]['blink']
        a.key(eye, 'scaleY', [
            (0, 1.0, 'l'), (42, 1.0, 'l'), (46, 0.08, 'io'),
            (52, 1.0, 'io'), (112, 1.0, 'l'), (116, 0.08, 'io'),
            (122, 1.0, 'io'), (n, 1.0, 'l'),
        ])
    out.append(a)
    n = 264; a = Anim('idle.hair', n, True)
    a.key(sc.tails['l'], 'rotation', swing(n, 2, 0.05, 0.0)); a.key(sc.tails['r'], 'rotation', swing(n, 2, 0.05, 1.4))
    a.key(sc.ribbon, 'rotation', swing(n, 3, 0.035, 0.7))
    out.append(a)
    return out


def build_expression(sc: Scene, name: str):
    """Build a one-shot expression from the official mouth plates and face pose.

    Rive's state machine blends these tracks with the body action layer.  Keeping
    the mouth plates as opacity tracks gives us stable lip-sync fallbacks while
    leaving all brand pixels untouched.
    """
    n = 24
    an = Anim(f'expr.{name}', n, False)
    mouth = sc.mouth
    variant = {
        'neutral': 'base', 'happy': 'open', 'angry': 'frown',
        'sad': 'frown', 'relaxed': 'base', 'surprised': 'o',
    }.get(name, 'base')
    for key, el in mouth.items():
        an.key(el, 'opacity', [(0, 1.0 if key == variant else 0.0, 'l'),
                               (n, 1.0 if key == variant else 0.0, 'l')])
    # Subtle head accents make the expression readable in a small desktop window.
    # The supplied head artwork remains unchanged.
    tilt = {'happy': -0.035, 'angry': 0.025, 'sad': 0.045,
            'relaxed': -0.015, 'surprised': -0.02}.get(name, 0.0)
    an.key(sc.headAct, 'rotation', [(0, tilt, 'io'), (12, tilt * 0.65, 'io'), (n, 0.0, 'io')])
    if name in ('relaxed', 'sad'):
        for side in ('l', 'r'):
            an.key(sc.eye[side]['blink'], 'scaleY', [(0, 0.82, 'io'), (12, 0.88, 'io'), (n, 1.0, 'io')])
    return an


def build_face_action(sc: Scene, name: str, mouth_variant: str):
    """Short mouth action used by the talking bridge when RMS crosses a threshold."""
    n = 12; an = Anim(name, n, False)
    for key, el in sc.mouth.items():
        on = 1.0 if key == mouth_variant else 0.0
        an.key(el, 'opacity', [(0, on, 'io'), (n, on, 'l')])
    return an

def build_rest(sc, acts):
    rest = Anim('rest', 1, True); touched = {}
    for an in acts:
        for eid, (el, props) in an.items.items():
            for prop in props: touched[(eid, prop)] = (el, prop)
    for (eid, prop), (el, p) in touched.items():
        v = sc.rest_of(el, p)
        if p == 'rotation' and el.attrs.get('name', '').startswith('arm-'): v = float(el.attrs.get('rotation', 0))
        rest.key(el, p, [(0, v, 'l')])
    return rest

VM_ID, VM_INST = '0:9000', '0:9001'
def build_sm(idle, acts, rest, *, name='Nomi', vm_name='Mascot', vm_id=VM_ID, vm_inst=VM_INST, sm_id='0:7'):
    vm = El('ViewModel', vm_name, id=vm_id); vm.attrs['defaultInstanceId'] = vm_inst
    inst = El('ViewModelInstance', 'Default', id=vm_inst, exports=True); props = {}
    for an in acts:
        pr = El('ViewModelPropertyTrigger', an.name, ident=True); vm.add(pr); props[an.name] = pr
        inst.add(El('ViewModelInstanceTrigger', viewModelPropertyId=pr.id))
    vm.add(inst)
    sm = El('StateMachine', name, id=sm_id)
    for k, an in enumerate(idle):
        ly = El('StateMachineLayer', an.name, ident=True)
        st = El('AnimationState', ident=True, x=200, y=100 * k, animationId=an.el.id)
        entry = El('EntryState'); entry.add(El('StateTransition', stateToId=st.id))
        ly.add(El('AnyState', x=0, y=-100), El('ExitState', x=400, y=-100), entry, st); sm.add(ly)
    ly = El('StateMachineLayer', 'Actions', ident=True)
    rest_st = El('AnimationState', ident=True, x=200, y=0, animationId=rest.el.id)
    states = {an.name: El('AnimationState', ident=True, x=520, y=-160 + i * 100, animationId=an.el.id) for i, an in enumerate(acts)}
    entry = El('EntryState'); entry.add(El('StateTransition', stateToId=rest_st.id))
    for nm, st in states.items():
        tr = El('StateTransition', stateToId=st.id, duration=0)
        c = El('TransitionViewModelCondition'); cmp_ = El('TransitionPropertyViewModelComparator'); bp = El('BindablePropertyTrigger')
        bp.add(El('DataBindContext', sourcePathIds=f'{vm_id}-{props[nm].id}', propertyKey=686)); cmp_.add(bp)
        c.add(cmp_, El('TransitionValueTriggerComparator')); tr.add(c); rest_st.add(tr)
        st.add(El('StateTransition', stateToId=rest_st.id, duration=0, enableExitTime=True, exitTimeIsPercetange=True, exitTime=100))
    ly.add(El('AnyState', x=0, y=-100), El('ExitState', x=400, y=-100), entry, rest_st, *states.values()); sm.add(ly)
    return vm, sm

def main():
    sc = Scene()
    idle = build_idle(sc)
    wave = build_action(sc, 'wave', 'wave', {'r': 'r'}, 'bent')
    cheer = build_action(sc, 'cheer', 'celebrate', {'r': 'r', 'l': 'l'}, 'bent')
    # Aliases keep the existing mascot command vocabulary useful on Rive while
    # sharing the same high-fidelity baked arm tracks.
    hello = build_action(sc, 'hello', 'wave', {'r': 'r'}, 'bent')
    celebrate = build_action(sc, 'celebrate', 'celebrate', {'r': 'r', 'l': 'l'}, 'bent')
    acts = [wave, cheer, hello, celebrate]
    acts.extend(build_expression(sc, name) for name in
                ('neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'))
    acts.extend([
        build_face_action(sc, 'mouth-open', 'open'),
        build_face_action(sc, 'mouth-close', 'base'),
        build_face_action(sc, 'talking', 'open'),
    ])
    rest = build_rest(sc, acts)
    vm, sm = build_sm(idle, acts, rest)
    for an in [*idle, rest, *acts]: sc.ab.add(an.finish())
    sc.ab.add(sm); sc.ab.attrs['defaultStateMachineId'] = '0:7'; sc.ab.attrs['viewModelId'] = VM_ID
    # Full-body artboard: the generated plates are kept in a separate state
    # machine so the renderer can opt into it with ?rive=full.
    full = FullScene()
    full_idle = build_full_idle(full)
    full_wave = build_full_action(full, 'wave', 'wave')
    full_cheer = build_full_action(full, 'cheer', 'cheer')
    full_hello = build_full_action(full, 'hello', 'wave')
    full_celebrate = build_full_action(full, 'celebrate', 'cheer')
    full_acts = [full_wave, full_cheer, full_hello, full_celebrate]
    full_rest = build_rest(full, full_acts)
    full_vm, full_sm = build_sm(full_idle, full_acts, full_rest,
                                name='NomiFull', vm_name='MascotFull',
                                vm_id='0:9100', vm_inst='0:9101', sm_id='0:8')
    for an in [*full_idle, full_rest, *full_acts]: full.ab.add(an.finish())
    full.ab.add(full_sm); full.ab.attrs['defaultStateMachineId'] = '0:8'; full.ab.attrs['viewModelId'] = '0:9100'
    PROJ.mkdir(parents=True, exist_ok=True)
    (PROJ / 'rive.yaml').write_text('name: nomi-complete\nlogs:\n  file: build/rive.log\n  problems: build/problems.log\n')
    body = '<Rive version="1" kind="fragment">\n'
    for a_ in assets.values(): body += a_.emit(1)
    body += vm.emit(1) + full_vm.emit(1) + sc.ab.emit(1) + full.ab.emit(1) + '</Rive>\n'
    (PROJ / 'scene.rml').write_text(body)
    print('wrote scene.rml; mesh verts', {s: {k: v.verts for k, v in a.states.items()} for s, a in sc.arms.items()}, 'assets', len(assets), 'wave frames', wave.frames, 'cheer', cheer.frames)

if __name__ == '__main__':
    main()

