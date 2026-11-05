"""Step 3: write scene.rml for the rebuilt rig.

usage: gen.py <parts dir> <old scene.rml> <out scene.rml> [--verify]

The parts dir holds parts.json + layers/*.png (paint.py output). Coordinates are mother pixels,
written in artboard units: x_art = OX + K * x, y_art = K * y (the 960x1300 artboard shows the
1024x1536 mother at 1300/1536). --verify writes a 1024x1536 artboard at scale 1 with no animation,
for a pixel comparison of the rest pose against mother-v2.
Bones, images, animations, the state machine and the view model keep the ids of the old scene, so
the app contract (artboard Nomi-full, state machine NomiFull, view model MascotFull) is unchanged.
"""
import sys, os, re, json, base64
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
import rig3d  # noqa: E402
from bindings import P, SOFT  # noqa: E402

parts_dir, old_scene, out_scene = sys.argv[1:4]
VERIFY = '--verify' in sys.argv
POSE = {}
for a in sys.argv:
    if a.startswith('--pose='):
        POSE = json.loads(a[len('--pose='):])
K, OX = (1.0, 0.0) if VERIFY else (1300 / 1536, 46.666666666666686)
AW, AH = (1024, 1536) if VERIFY else (960, 1300)
asset_prefix = os.path.relpath(os.path.join(parts_dir, 'layers'), os.path.dirname(os.path.abspath(out_scene)))

old = open(old_scene).read()
parts = json.load(open(os.path.join(parts_dir, 'parts.json')))['top_first']

# ---------------------------------------------------------------- ids
_n = [0]


def nid():
    _n[0] += 1
    return f'7:{_n[0]}'


# keep the old ids of bones / images that still exist by name so nothing else needs remapping
old_ids = dict(re.findall(r'<(?:RootBone|Bone)[^>]*?name="([^"]+)"[^>]*?id="([^"]+)"', old))
bone_id = {n: old_ids.get(n) or nid() for n in rig3d.ORDER}
TO_ART = np.array([[K, 0, OX], [0, K, 0.0]])


def A(x, y):
    return OX + K * x, K * y


def f(v):
    return f'{v:.7f}'.rstrip('0').rstrip('.') if abs(v) > 1e-12 else '0'


# ---------------------------------------------------------------- bones
children = {}
for n in rig3d.ORDER:
    children.setdefault(rig3d.B[n]['parent'], []).append(n)
LOCALS = rig3d.rest_locals(TO_ART)
if POSE:
    LOCALS.update(rig3d.pose_locals(POSE, TO_ART)[0])


def emit_bone(n, depth):
    x, y, r, sx, sy = LOCALS[n]
    ind = '    ' * depth
    sc = '' if abs(sx - 1) < 1e-6 and abs(sy - 1) < 1e-6 else f' scaleX="{f(sx)}" scaleY="{f(sy)}"'
    s = [f'{ind}<RootBone name="{n}" x="{f(x)}" y="{f(y)}" rotation="{f(r)}"{sc} length="1" id="{bone_id[n]}">']
    for c in children.get(n, []):
        s += emit_bone(c, depth + 1)
    s.append(f'{ind}</RootBone>')
    return s


# ---------------------------------------------------------------- meshes
def seg_dist(p, a, b):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    d = b - a
    L2 = float(d @ d)
    if L2 < 1e-9:
        return np.hypot(p[:, 0] - a[0], p[:, 1] - a[1])
    t = np.clip(((p[:, 0] - a[0]) * d[0] + (p[:, 1] - a[1]) * d[1]) / L2, 0, 1)
    return np.hypot(p[:, 0] - (a[0] + t * d[0]), p[:, 1] - (a[1] + t * d[1]))


def weights(pts, bones, soft):
    """Each vertex belongs to its nearest bone segment; only vertices about equally close to two
    segments (i.e. at a joint) blend, over ~`soft` px, so limbs bend at the joint instead of stretching."""
    if len(bones) == 1:
        return [(255, 1)] * len(pts)
    D = np.stack([seg_dist(pts, *rig3d.seg2d(b)) for b in bones], 1)
    w = np.exp(-(D - D.min(1, keepdims=True)) / soft)
    out = []
    for row in w:
        top = np.argsort(-row)[:4]
        v = row[top] / row[top].sum()
        q = np.floor(v * 255).astype(int)
        q[0] += 255 - q.sum()
        keep = [(int(q[i]), int(top[i]) + 1) for i in range(len(top)) if q[i] > 0]
        vals = sum(v_ << (8 * i) for i, (v_, _) in enumerate(keep))
        idxs = sum(t_ << (8 * i) for i, (_, t_) in enumerate(keep))
        out.append((vals, idxs))
    return out


def varuint(n):
    b = bytearray()
    while True:
        c = n & 0x7F
        n >>= 7
        if n:
            b.append(c | 0x80)
        else:
            b.append(c)
            return bytes(b)


def build_mesh(name, box, alpha, bones):
    x0, y0, w, h = box
    rigid = len(bones) == 1
    if rigid:
        xs = [0, w]
        ys = [0, h]
    else:
        step = int(np.clip(max(w, h) / 14, 8, 22))
        xs = list(range(0, w, step)) + [w]
        ys = list(range(0, h, step)) + [h]
    cells = []
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            if alpha[ys[j]:ys[j + 1], xs[i]:xs[i + 1]].any():
                cells.append((i, j))
    vid = {}
    verts = []
    for i, j in cells:
        for (a, b_) in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
            if (a, b_) not in vid:
                vid[(a, b_)] = len(verts)
                verts.append((a, b_))
    tris = []
    for i, j in cells:
        v0, v1, v2, v3 = vid[(i, j)], vid[(i + 1, j)], vid[(i + 1, j + 1)], vid[(i, j + 1)]
        tris += [v0, v1, v2, v0, v2, v3]
    pts = np.array([(x0 + xs[a], y0 + ys[b_]) for a, b_ in verts], float)
    W8 = weights(pts, bones, SOFT.get(name, 3.0))
    tib = base64.b64encode(b''.join(varuint(t) for t in tris)).decode()
    mid = nid()
    s = [f'<Mesh triangleIndexBytes="{tib}" name="{name}.mesh" id="{mid}">']
    for (a, b_), (px, py), (vals, idxs) in zip(verts, pts, W8):
        ax, ay = A(px, py)
        s.append(f'<MeshVertex x="{f(ax)}" y="{f(ay)}" u="{xs[a] / w:.6f}" v="{ys[b_] / h:.6f}">'
                 f'<Weight values="{vals}" indices="{idxs}"/></MeshVertex>')
    s.append(f'<Skin name="{name}.skin" id="{nid()}">')
    for bn in bones:
        T = rig3d.tendon(bn, TO_ART)     # columns: x axis, y axis, origin
        s.append(f'<Tendon boneId="{bone_id[bn]}" xx="{f(T[0, 0])}" xy="{f(T[1, 0])}" yx="{f(T[0, 1])}" yy="{f(T[1, 1])}" '
                 f'tx="{f(T[0, 2])}" ty="{f(T[1, 2])}" name="{name}.t.{bn}"/>')
    s.append('</Skin></Mesh>')
    return s, len(verts)


# ---------------------------------------------------------------- images
assets = []
images = []
nverts = 0
for p in parts:
    if not p.get('box'):
        continue
    name = p['name']
    path = os.path.join(parts_dir, 'layers', name + '.png')
    L = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    aid = nid()
    assets.append(f'    <ImageAsset name="{name}" file="{asset_prefix}/{name}.png" id="{aid}"/>')
    ms, nv = build_mesh(name, p['box'], L[..., 3] > 0, P[name])
    nverts += nv
    op = '' if p['visible'] else ' opacity="0"'
    iid = nid()
    p['image_id'] = iid
    block = [f'<Image name="full.{name}" assetId="{aid}" x="0" y="0" originX="0" originY="0"{op} id="{iid}">'] + ms + ['</Image>']
    images.append((name, iid, block))


def arm_group(name):
    for s_ in 'lr':
        if name.startswith((f'hand-{s_}-', f'arm-{s_}-', f'sleeve-{s_}')):
            return s_
    return None


# each arm (sleeve, skin, cuff, hand, fingers) is one Node so a DrawRules can lift it above the head when the
# hand comes in front of the face; DRAW holds the ids the animations key
DRAW = {}
top_image = images[0][1]
flat = []
i = 0
while i < len(images):
    g = arm_group(images[i][0])
    if g is None:
        flat += images[i][2]
        i += 1
        continue
    j = i
    while j < len(images) and arm_group(images[j][0]) == g:
        j += 1
    nxt = images[j][1] if j < len(images) else None
    nid_node, nid_rules, t_rest, t_front = nid(), nid(), nid(), nid()
    DRAW[g] = dict(rules=nid_rules, rest=t_rest, front=t_front)
    active = t_front if POSE.get(f'front.{g}') else t_rest
    flat.append(f'<Node name="full.arm-{g}.layer" x="0" y="0" id="{nid_node}">')
    flat.append(f'<DrawRules name="full.arm-{g}.rules" drawTargetId="{active}" id="{nid_rules}">')
    flat.append(f'<DrawTarget name="arm-{g}.rest" drawableId="{nxt}" placementValue="before" id="{t_rest}"/>')
    flat.append(f'<DrawTarget name="arm-{g}.front" drawableId="{top_image}" placementValue="before" id="{t_front}"/>')
    flat.append('</DrawRules>')
    for k in range(i, j):
        flat += images[k][2]
    flat.append('</Node>')
    i = j
images = flat

# ---------------------------------------------------------------- assemble
vm = old[old.index('    <ViewModel '):old.index('</ViewModel>') + len('</ViewModel>')]
art_open = re.search(r'<Artboard [^>]*>', old).group(0)
art_open = re.sub(r'width="[^"]+"', f'width="{AW}"', art_open)
art_open = re.sub(r'height="[^"]+"', f'height="{AH}"', art_open)
if VERIFY:
    art_open = re.sub(r' defaultStateMachineId="[^"]+"', '', art_open)
    art_open = re.sub(r' viewModelId="[^"]+"', '', art_open)
style = re.search(r'<LayoutComponentStyle [^>]*/>', old).group(0)
out = ['<Rive version="1" kind="fragment">'] + assets
if not VERIFY:
    # source lock (packages/avatar-runtime/tests/rive.test.ts): the .riv embeds the supplied mother PNG and
    # its SVG wrapper byte for byte, so every layer can be traced back to them
    out.append('    <ImageAsset name="source-nomi-master" file="source-nomi-master.png" id="0:191"/>')
    out.append('    <BlobAsset name="nomi-fullbody-mother-svg" file="reference/svg-rig/nomi-fullbody-mother.svg" id="0:9208"/>')
    out.append(vm)
out += ['    ' + art_open, '        ' + style, '        <Node name="full.pose" x="0" y="0" id="0:190">']
out += emit_bone('full.root', 3)
out.append('            <Node name="full.art" x="0" y="0" id="7:99999">')
out += ['                ' + l for l in images]
out.append('            </Node>')
out.append('        </Node>')
if not VERIFY and os.path.exists(os.path.join(parts_dir, 'animations.xml')):
    out.append(open(os.path.join(parts_dir, 'animations.xml')).read())
    sm = old[old.index('<StateMachine '):old.index('</StateMachine>') + len('</StateMachine>')]
    out.append('        ' + sm)
out += ['    </Artboard>', '</Rive>']
open(out_scene, 'w').write('\n'.join(out) + '\n')
json.dump(dict(bone_id=bone_id, images={p['name']: p.get('image_id') for p in parts}, draw=DRAW),
          open(os.path.join(parts_dir, 'ids.json'), 'w'), indent=1)
print('wrote', out_scene, len(images), 'image lines,', nverts, 'vertices')
