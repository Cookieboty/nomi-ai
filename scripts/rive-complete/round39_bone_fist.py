#!/usr/bin/env python3
"""ROUND39 - full-bone fist from the ORIGINAL hand art (replaces the R38 procedural fist, reverted in R39a).

Per hand (l, r) and finger (thumb, index, middle, ring, little):
1. Joint centres.  The finger crop hand-{s}-{f}.png (R10 cut from the mother) is measured: principal axis of its
   alpha, base end = end nearer the palm centroid.  MCP / PIP / DIP (thumb: CMC / MCP / IP) sit on that axis at
   fractions J of the visible length.  The bones full.arm-{s}.{f}, .1, .2 are moved to those centres (rest rotation
   stays 0) and EVERY Tendon on those bones (finger + web skins) gets the matching bind translation, so the rest pose
   renders unchanged while rotations now pivot on the joints.
2. Phalanx pieces.  The crop's pixels are split by projection on the axis into meta (before MCP, rigid to the hand
   bone), p0 (MCP..PIP, bone f), p1 (PIP..DIP, bone f.1), p2 (DIP.., bone f.2).  Each distal piece also carries a
   knuckle cap = original fully-opaque pixels within CAP_R of its proximal joint plus a 2 px underlap into the
   proximal piece; it is drawn UNDER the proximal piece, so at rest it is hidden and when bent it fills the joint
   wedge with real art.  Transparent texels keep the source RGB (no dark bilinear fringe).
   Pieces are rigid quads (4 vertices, 100 % one bone) declared where the source finger image was, order
   meta > p0 > p1 > p2 (proximal over distal); the source finger image stays (keeps the R37b pouch DrawRules
   anchor on hand-r.thumb) but gets opacity 0.
3. Fist pose by bones only.  Curl sign per finger = the side of the palm centroid (tip moves into the palm).
   MCP 80 deg, PIP 95, DIP 50; thumb CMC 15, MCP 35, IP 30.  full.fist: index leads (grip f12), middle f13, ring f14,
   little f15, thumb last (f20); squeeze +5 % at f28, hold, release by f68, 0 at f0 / f72.
   full.run: the same grip x run envelope (thumb 2 f behind), 0 at f0 and on the last frame.
Idempotent: strips its own bones / images / assets / keys and rebuilds."""
from __future__ import annotations
import json, math, re, hashlib
import numpy as np
from PIL import Image
import round13_anim as A
import round10_layers as L10
import round8_scene as R8
import round26_gait as G

SCENE = L10.PROJECT / "scene.rml"
RIG = L10.PROJECT / "reference/svg-rig"
LIC = L10.PROJECT / "parts/DETAIL_LICENSE.json"
FING = ("thumb", "index", "middle", "ring", "little")
SEGS = ("", ".1", ".2")
TEX = 0.8464
J = {"thumb": (0.05, 0.45, 0.75), "index": (0.0, 0.45, 0.75), "middle": (0.0, 0.45, 0.75),
     "ring": (0.0, 0.45, 0.75), "little": (0.0, 0.45, 0.75)}
DEG = {"thumb": (10, 35, 50)}
DEG_F = (80, 95, 50)
LEAD = {"index": 12, "middle": 13, "ring": 14, "little": 15, "thumb": 20}
CAP_R = 2.5
KIN = 0.3
THUMB_FS = 0.5
VIS_MIN = 0.12


def ss(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)


def max_id(s):
    return max(int(x) for x in re.findall(r'id="0:(\d+)"', s))


def leb(n):
    o = bytearray()
    while True:
        b = n & 0x7F; n >>= 7; o.append(b | (0x80 if n else 0))
        if not n:
            return bytes(o)


def tex_frame(s, sd):
    """texel -> rig affine of the hand crops (from the palm rest mesh) + hand bone bind (palm tendon t0)."""
    a, b = R8.find_elem(s, "Image", f"full.hand-{sd}.palm.image"); t = s[a:b]
    V = [(float(x), float(y), float(u), float(v)) for x, y, u, v in re.findall(r'MeshVertex x="([-\d.]+)" y="([-\d.]+)" u="([-\d.]+)" v="([-\d.]+)"', t)]
    (x0, y0, u0, v0), (x1, y1, u1, v1) = min(V, key=lambda q: q[2] + q[3]), max(V, key=lambda q: q[2] + q[3])
    W, H = Image.open(RIG / f"hand-{sd}-palm.png").size
    kx = (x1 - x0) / ((u1 - u0) * W); ky = (y1 - y0) / ((v1 - v0) * H)
    hb = re.search(r'<Tendon [^>]*tx="([-\d.]+)" ty="([-\d.]+)" name="full\.hand-' + sd + r'\.palm\.t0"', t)
    return (kx, ky, x0 - kx * u0 * W, y0 - ky * v0 * H), (float(hb.group(1)), float(hb.group(2))), (W, H)


def analyse(sd, fg, palm_c):
    im = np.asarray(Image.open(RIG / f"hand-{sd}-{fg}.png").convert("RGBA")).astype(np.float64)
    from scipy.ndimage import label
    lab, n = label(im[..., 3] > 127)
    big = np.argmax(np.bincount(lab.ravel())[1:]) + 1          # main blob only (ownership specks ignored)
    ys, xs = np.nonzero(lab == big)
    P = np.c_[xs, ys].astype(float) + 0.5; c = P.mean(0)
    w, V = np.linalg.eigh(np.cov((P - c).T)); ax = V[:, np.argmax(w)]
    t = (P - c) @ ax
    lo, hi = c + ax * t.min(), c + ax * t.max()
    near = (lambda q: abs(q[0] - palm_c[0])) if fg in ("middle", "ring", "little") else (lambda q: np.linalg.norm(q - palm_c))
    if near(lo) > near(hi):          # base (knuckle) end: nearer the palm (side fingers: nearer in x, they point sideways)
        ax = -ax
    t = (P - c) @ ax; t0, t1 = t.min(), t.max(); L = t1 - t0
    joints = [c + ax * (t0 + f * L) for f in J[fg]]
    return im, ax, joints, L


def split(im, ax, joints):
    H, W = im.shape[:2]; yy, xx = np.mgrid[0:H, 0:W]; Pt = np.stack([xx + 0.5, yy + 0.5], -1)
    al = im[..., 3]
    tj = [float(j @ ax) for j in joints]; tp = Pt @ ax
    own = [(al > 0) & (tp < tj[0])] + [(al > 0) & (tp >= tj[k]) & ((tp < tj[k + 1]) if k < 2 else True) for k in range(3)]
    full = al >= 255
    pieces = []
    for k in range(4):
        m = own[k].copy()
        if k >= 1:                                         # knuckle cap + underlap: real opaque pixels, drawn under
            jx, jy = joints[k - 1]
            disk = (xx + 0.5 - jx) ** 2 + (yy + 0.5 - jy) ** 2 <= CAP_R ** 2
            under = (tp >= tj[k - 1] - 2.0) & (tp < tj[k - 1])
            m |= (full & disk) | ((al > 0) & under)
        rgba = im.copy(); rgba[..., 3] = np.where(m, al, 0)
        pieces.append((rgba.astype(np.uint8), int(own[k].sum()), int(m.sum() - own[k].sum())))
    return pieces


def underlay(sd):
    """palm backfill (rigid to the hand bone, drawn under every hand piece while the pieces are shown): the closed /
    hole-filled palm+web silhouette, each texel coloured from the NEAREST original opaque palm texel, lightly blurred,
    so a finger that folds away never opens a hole into the background inside the hand."""
    from scipy.ndimage import binary_closing, binary_fill_holes, distance_transform_edt, gaussian_filter
    pa = np.asarray(Image.open(RIG / f"hand-{sd}-palm.png").convert("RGBA")).astype(np.float64)
    from scipy.spatial import ConvexHull
    from matplotlib.path import Path
    base = pa[..., 3] > 127                                   # palm + proximal (knuckle) parts of the four fingers
    for f in ("index", "middle", "ring", "little"):
        for t in ("meta", "p0"):
            q = RIG / f"hand-{sd}-{f}-{t}.png"
            if q.exists():
                base |= np.asarray(Image.open(q).convert("RGBA"))[..., 3] > 127
    yy, xx = np.nonzero(base); pts = np.c_[xx, yy] + 0.5
    hull = Path(pts[ConvexHull(pts).vertices])
    H, W = pa.shape[:2]; gy, gx = np.mgrid[0:H, 0:W]
    inside = hull.contains_points(np.c_[gx.ravel() + 0.5, gy.ravel() + 0.5]).reshape(H, W)
    sil = pa[..., 3] > 127
    for f in ("web",) + FING:
        sil |= np.asarray(Image.open(RIG / f"hand-{sd}-{f}.png").convert("RGBA"))[..., 3] > 127
    m = inside & binary_fill_holes(sil)
    comp = pa.copy()
    for f in ("web", "index", "middle", "ring", "little"):
        q = np.asarray(Image.open(RIG / f"hand-{sd}-{f}.png").convert("RGBA")).astype(np.float64)
        comp = np.where((q[..., 3:] >= 250) & (comp[..., 3:] < 250), q, comp)
    src = comp[..., 3] >= 250
    _, (iy, ix) = distance_transform_edt(~src, return_indices=True)
    rgb = comp[iy, ix, :3]
    rgb = np.stack([gaussian_filter(rgb[..., c], 1.0) for c in range(3)], -1)
    out = np.dstack([rgb, np.where(m, 255.0, 0.0)]).clip(0, 255).astype(np.uint8)
    return out, int(m.sum())


def main():
    s = SCENE.read_text(encoding="utf-8")
    # ---- strip own state
    s = re.sub(r'<RootBone name="full\.arm-[lr]\.[a-z]+\.j[012]"[^>]*/>', "", s)
    s = re.sub(r'<Image name="full\.hand-[lr]\.palm\.meta\.image".*?</Image>\n {20}', "", s, flags=re.S)
    s = re.sub(r'<Image name="full\.hand-[lr]\.[a-z]+\.(?:meta|p[012])\.image".*?</Image>\n {20}', "", s, flags=re.S)
    s = re.sub(r'<ImageAsset name="fullbody-hand-[lr]-[a-z]+-(?:meta|p[012])"[^>]*/>\n    ', "", s)
    own_ids = set()
    ids = A.ids_by_name(s)
    nid = max_id(s) + 1
    lic = json.loads(LIC.read_text())
    report = {}
    curl = {}
    phis = {}
    seglen = {}
    rest = {}
    for sd in "lr":
        (kx, ky, bx, by), hand_b, (W, H) = tex_frame(s, sd)
        to_rig = lambda p: (bx + kx * p[0], by + ky * p[1])
        pal = np.asarray(Image.open(RIG / f"hand-{sd}-palm.png").convert("RGBA"))[..., 3]
        py, px = np.nonzero(pal > 127); palm_c = np.array([px.mean(), py.mean()]) + 0.5
        for fg in FING:
            im, ax, joints, L = analyse(sd, fg, palm_c)
            jr = [to_rig(j) for j in joints]
            # ---- new joint-centred bones j0 (MCP/CMC) > j1 (PIP/MCP) > j2 (DIP/IP) under the hand bone
            names = [f"full.arm-{sd}.{fg}.j{k}" for k in range(3)]
            phi = math.atan2(ax[1] * ky, ax[0] * kx); phis[(sd, fg)] = phi
            xml = ""
            for k, (n, p) in enumerate(zip(names, jr)):     # siblings under the hand bone; FK is baked into x/y keys
                xml += (f'<RootBone name="{n}" x="{p[0] - hand_b[0]:.4f}" y="{p[1] - hand_b[1]:.4f}" rotation="{phi:.6f}" '
                        f'length="1" scaleX="1" id="0:{nid}"/>')
                ids[n] = f"0:{nid}"; nid += 1
            seglen[(sd, fg)] = [math.dist(jr[0], jr[1]), math.dist(jr[1], jr[2])]
            rest[(sd, fg)] = [(p[0] - hand_b[0], p[1] - hand_b[1]) for p in jr]
            hm = re.search(r'<RootBone name="full\.arm-' + sd + r'\.hand"[^>]*>', s)
            s = s[:hm.end()] + xml + s[hm.end():]
            # ---- curl sign: tip moves toward the palm centroid
            v = joints[2] - joints[0]; w = palm_c - joints[0]
            sign = 1.0 if v[0] * w[1] - v[1] * w[0] > 0 else -1.0
            curl[(sd, fg)] = sign
            # ---- pieces
            pcs = split(im, ax, joints)
            src_a, src_b = R8.find_elem(s, "Image", f"full.hand-{sd}.{fg}.image")
            ins = ""; assets = ""
            binds = [hand_b] + jr
            bone_ids = [ids[f"full.arm-{sd}.hand"]] + [ids[n] for n in names]
            report[f"{sd}.{fg}"] = dict(sign=sign, L_px=round(L, 1), joints_tex=[[round(float(a), 1) for a in j] for j in joints],
                                        own=[p[1] for p in pcs], cap=[p[2] for p in pcs])
            for k, tag in enumerate(("meta", "p0", "p1", "p2")):
                rgba, n_own, n_cap = pcs[k]
                if n_own == 0:
                    continue
                fn = f"hand-{sd}-{fg}-{tag}.png"
                own_ids.add((sd, fg, tag))
                Image.fromarray(rgba, "RGBA").save(RIG / fn, format="PNG", optimize=False, compress_level=9)
                aid, iid, mid, kid, tid = (f"0:{nid + i}" for i in range(5)); nid += 5
                vx = "".join(f'<MeshVertex x="{bx + kx * u * W:.4f}" y="{by + ky * v * H:.4f}" u="{u:.6f}" v="{v:.6f}" name="hand-{sd}-{fg}-{tag}.v{i}">'
                             '<Weight values="255" indices="1"/></MeshVertex>' for i, (u, v) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))))
                tri = __import__("base64").b64encode(b"".join(leb(i) for i in (0, 1, 2, 1, 3, 2))).decode()
                bb = binds[k]
                cr, sr = (1.0, 0.0) if k == 0 else (math.cos(phi), math.sin(phi))   # bind = bone rest (rotated to the finger axis)
                ins += (f'<Image name="full.hand-{sd}.{fg}.{tag}.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" opacity="0" id="{iid}">'
                        f'<Mesh triangleIndexBytes="{tri}" id="{mid}">{vx}<Skin name="hand-{sd}-{fg}-{tag}.skin" id="{kid}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">'
                        f'<Tendon boneId="{bone_ids[k]}" xx="{cr:.6f}" xy="{sr:.6f}" yx="{-sr:.6f}" yy="{cr:.6f}" tx="{bb[0]:.4f}" ty="{bb[1]:.4f}" name="hand-{sd}-{fg}-{tag}.t0"/>'
                        '</Skin></Mesh></Image>\n                    ')
                assets += f'<ImageAsset name="fullbody-hand-{sd}-{fg}-{tag}" file="reference/svg-rig/{fn}" id="{aid}"/>\n    '
                p = RIG / fn
                lic["assets"][f"reference/svg-rig/{fn}"] = dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size,
                    ai_generated=False, in_scene=True, method=f"ROUND39: {tag} phalanx piece of hand-{sd}-{fg}.png (original mother pixels, split at the "
                    "measured joint line; knuckle cap = original opaque pixels within 2.5 px of the joint + 2 px underlap)")
            el = s[src_a:src_b]
            if fg == "thumb":   # thumb over index / middle when folded: thumb pieces sit above the other fingers (below palm/web)
                src_a, _ = R8.find_elem(s, "Image", f"full.hand-{sd}.little.image")
            s = s[:src_a] + ins + s[src_a:]
            a = s.find('<ImageAsset name="fullbody-hand-l-palm"')
            s = s[:a] + assets + s[a:]
    for sd in "lr":
        (kx, ky, bx, by), hand_b, (W, H) = tex_frame(s, sd)
        rgba, n_u = underlay(sd)
        fn = f"hand-{sd}-palm-meta.png"
        Image.fromarray(rgba, "RGBA").save(RIG / fn, format="PNG", optimize=False, compress_level=9)
        aid, iid, mid, kid = (f"0:{nid + i}" for i in range(4)); nid += 4
        vx = "".join(f'<MeshVertex x="{bx + kx * u * W:.4f}" y="{by + ky * v * H:.4f}" u="{u:.6f}" v="{v:.6f}" name="hand-{sd}-palm-meta.v{i}">'
                     '<Weight values="255" indices="1"/></MeshVertex>' for i, (u, v) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))))
        tri = __import__("base64").b64encode(b"".join(leb(i) for i in (0, 1, 2, 1, 3, 2))).decode()
        img = (f'<Image name="full.hand-{sd}.palm.meta.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" opacity="0" id="{iid}">'
               f'<Mesh triangleIndexBytes="{tri}" id="{mid}">{vx}<Skin name="hand-{sd}-palm-meta.skin" id="{kid}" xx="1" xy="0" yx="0" yy="1" tx="0" ty="0">'
               f'<Tendon boneId="{ids[f"full.arm-{sd}.hand"]}" xx="1.000000" xy="0.000000" yx="0.000000" yy="1.000000" tx="{hand_b[0]:.4f}" ty="{hand_b[1]:.4f}" name="hand-{sd}-palm-meta.t0"/>'
               '</Skin></Mesh></Image>\n                    ')
        # under every hand piece: right after the last hand image of this side (thumb source image)
        # directly above the (hidden) thumb source image: below every piece, and above the R37b pouch slot
        # (pouch "behind" target = after hand-r.thumb.image), so the pouch never covers the backfill
        ta, tb = R8.find_elem(s, "Image", f"full.hand-{sd}.thumb.image")
        s = s[:ta] + img.rstrip() + "\n                    " + s[ta:]
        a = s.find('<ImageAsset name="fullbody-hand-l-palm"')
        s = s[:a] + f'<ImageAsset name="fullbody-hand-{sd}-palm-meta" file="reference/svg-rig/{fn}" id="{aid}"/>\n    ' + s[a:]
        own_ids.add((sd, "palm", "meta"))
        p = RIG / fn
        lic["assets"][f"reference/svg-rig/{fn}"] = dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size,
            ai_generated=False, in_scene=True, method="ROUND39: palm backfill under the phalanx pieces; colours = nearest original opaque "
            "hand-" + sd + "-palm.png texel (mother pixels), 1 px blur; shown only while full.fist / full.run curl the fingers")
        report[f"{sd}.palm-backfill_px"] = n_u
    for sd in "lr":   # middle / ring / little curl together: majority sign of the three
        g3 = sum(curl[(sd, f)] for f in ("middle", "ring", "little"))
        for f in ("middle", "ring", "little"):
            curl[(sd, f)] = 1.0 if g3 > 0 else -1.0
            report[f"{sd}.{f}"]["sign"] = curl[(sd, f)]
    # drop license entries of pieces that no longer exist
    for k in list(lic["assets"]):
        if re.match(r"reference/svg-rig/hand-[lr]-[a-z]+-(meta|p[012])\.png$", k) and not (L10.PROJECT / k).exists():
            lic["assets"].pop(k)
    if "ROUND39 bone fist" not in lic["note"]:
        lic["note"] += (" ROUND39 bone fist: every finger crop split into meta/p0/p1/p2 phalanx pieces (original pixels, knuckle caps from "
                        "original opaque pixels), rigid to joint-centred bones; R38 procedural fist removed.")
    LIC.write_text(json.dumps(lic, indent=2) + "\n")
    # ---- clips
    ids = A.ids_by_name(s)
    old_f = {ids[f"full.arm-{sd}.{fg}{g}"] for sd in "lr" for fg in FING for g in SEGS}
    fing_ids = {ids[f"full.arm-{sd}.{fg}.j{k}"]: (sd, fg, k) for sd in "lr" for fg in FING for k in range(3)}
    src_img = [ids[f"full.hand-{sd}.{fg}.image"] for sd in "lr" for fg in FING]
    pc_img = [ids[f"full.hand-{sd}.{fg}.{tag}.image"] for (sd, fg, tag) in sorted(own_ids)]
    def grip(sd, fg, k):
        return curl[(sd, fg)] * math.radians(DEG.get(fg, DEG_F)[k])
    for clip in ("full.fist", "full.run"):
        m = re.search(r'(<LinearAnimation name="' + re.escape(clip) + r'"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
        dur = int(m.group(2)); body = m.group(3)
        drop = set(fing_ids) | set(src_img) | set(pc_img)   # old finger tracks stay: they pose the source crops on the frames they show
        body = re.sub(r'\s*<KeyedObject objectId="(0:\d+)"><KeyedProperty property="(?:rotation|opacity|scaleX|x|y)">.*?</KeyedProperty></KeyedObject>',
                      lambda k: "" if k.group(1) in drop else k.group(0), body, flags=re.S)
        frames = sorted(set(range(0, dur + 1, 2)) | {dur})
        add = []; occ = {}
        for bid, (sd, fg, k) in fing_ids.items():
            if clip == "full.fist":
                g0 = LEAD[fg]
                env = lambda f, g0=g0: (ss(f / g0) * (1 + 0.05 * math.sin(math.pi * min(1, max(0, (f - g0) / (44 - g0)))))
                                        * (1 - ss((f - 58) / 10.0)))
            else:
                lag = 2 if fg == "thumb" else 0
                env = lambda f, lag=lag: G.run_frame(max(0, f - lag))["env"]
            # 3-D flex theta_k (MCP/PIP/DIP) is shown as: in-plane rotation KIN * theta (toward the palm) + foreshortening of
            # the phalanx along its axis, |visible| = cos(cumulative flex) (fingers fold away from the viewer, so a
            # folded-back distal phalanx (cos < 0) points back over the proximal one and is drawn under it).
            kin = 1.0 if fg == "thumb" else KIN
            fs = THUMB_FS if fg == "thumb" else 1.0                 # thumb: mostly in-plane wrap, tip half-tucked
            e = [0.0 if f in (0, dur) else env(f) for f in frames]
            th = [math.radians(DEG.get(fg, DEG_F)[i]) for i in range(3)]
            ph, sg, Ls, R0 = phis[(sd, fg)], curl[(sd, fg)], seglen[(sd, fg)], rest[(sd, fg)]
            rot, scl, px, py = [], [], [], []
            for ee in e:
                ang = [ph + sg * kin * sum(th[:j + 1]) * ee for j in range(3)]
                vis = [1.0 + fs * (max(VIS_MIN, math.cos(ee * sum(th[:j + 1]))) - 1.0) for j in range(3)]   # folded past 90 deg: tucked under
                P = [R0[0]]
                for j in range(2):
                    P.append((P[j][0] + Ls[j] * vis[j] * math.cos(ang[j]), P[j][1] + Ls[j] * vis[j] * math.sin(ang[j])))
                rot.append(ang[k]); scl.append(vis[k]); px.append(P[k][0]); py.append(P[k][1])
            kp = ""
            for prop, vv in (("rotation", rot), ("scaleX", scl), ("x", px), ("y", py)):
                if prop == "scaleX" and fs == 0.0:
                    continue
                kf = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in zip(frames, vv))
                kp += f'<KeyedProperty property="{prop}">{kf}</KeyedProperty>'
            add.append(f'\n            <KeyedObject objectId="{bid}">{kp}</KeyedObject>')
            if fs == 1.0 and k >= 1:          # p1 / p2 folded past ~83 deg are behind the hand: fade with the visible length
                occ[(sd, fg, f"p{k}")] = [ss((v - VIS_MIN) / 0.25) for v in scl]
        # same original pixels either way: pieces replace the skinned finger crops from frame 1 (curl ~0) until the last frame
        hold = lambda on: (f'<KeyFrameDouble value="{0 if on else 1}" frame="0" interpolationType="hold"/>'
                           f'<KeyFrameDouble value="{1 if on else 0}" frame="1" interpolationType="hold"/>'
                           f'<KeyFrameDouble value="{0 if on else 1}" frame="{dur}" interpolationType="hold"/>')
        for i in src_img:
            add.append(f'\n            <KeyedObject objectId="{i}"><KeyedProperty property="opacity">{hold(False)}</KeyedProperty></KeyedObject>')
        for key in sorted(own_ids):
            i = ids[f"full.hand-{key[0]}.{key[1]}.{key[2]}.image"]
            if key in occ:
                kf = '<KeyFrameDouble value="0" frame="0" interpolationType="hold"/><KeyFrameDouble value="1" frame="1" interpolationType="linear"/>' + "".join(
                    f'<KeyFrameDouble value="{v:.6f}" frame="{max(1, f)}" interpolationType="linear"/>' for f, v in zip(frames[1:-1], occ[key][1:-1])) + \
                    f'<KeyFrameDouble value="0" frame="{dur}" interpolationType="hold"/>'
            else:
                kf = hold(True)
            add.append(f'\n            <KeyedObject objectId="{i}"><KeyedProperty property="opacity">{kf}</KeyedProperty></KeyedObject>')
        s = s[:m.start(3)] + body + "".join(add) + s[m.end(3):]
    SCENE.write_text(s, encoding="utf-8")
    (L10.ROOT / "scripts/rive-complete/round39-bone-fist.json").write_text(json.dumps(report, indent=1) + "\n")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round39_bone_fist" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip("\n") + "\npython3 round39_bone_fist.py\n")
    print("ROUND39 bone fist:", {k: (v["sign"], v["own"]) if isinstance(v, dict) else v for k, v in report.items()})


if __name__ == "__main__":
    main()
