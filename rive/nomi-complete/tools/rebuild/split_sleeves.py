"""Split each sleeve into a rigid upper piece (shoulder -> elbow) and a rigid forearm piece (elbow -> cuff).

A single skinned sleeve smears into a blob when the elbow bends; two rigid pieces rotate cleanly. The cut is
the elbow bisector; the upper piece keeps a 16 px overlap past the cut, but only where the pixel is fully
opaque, so the forearm piece drawn on top covers it exactly and the rest pose is unchanged.
usage: split_sleeves.py <rig dir>"""
import sys, os, json
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
import rig3d  # noqa: E402

rig_dir = sys.argv[1]
meta_p = os.path.join(rig_dir, 'parts.json')
meta = json.load(open(meta_p))
parts = meta['top_first']
for s in 'lr':
    i = next(k for k, p in enumerate(parts) if p['name'] == f'sleeve-{s}')
    p = parts[i]
    x, y, w, h = p['box']
    L = cv2.imread(os.path.join(rig_dir, 'layers', f'sleeve-{s}.png'), cv2.IMREAD_UNCHANGED)
    S, E, W = (rig3d.J[f'{j}.{s}'][:2] for j in ('shoulder', 'elbow', 'wrist'))
    u1 = (E - S) / np.linalg.norm(E - S)
    u2 = (W - E) / np.linalg.norm(W - E)
    nb = u1 + u2
    nb /= np.linalg.norm(nb)                       # normal of the elbow bisector plane
    yy, xx = np.mgrid[y:y + h, x:x + w]
    t = (xx - E[0]) * nb[0] + (yy - E[1]) * nb[1]  # > 0: forearm side
    has = L[..., 3] > 0
    # loose specks (not connected to the sleeve) stay on the body instead of flying with the arm
    n_, lab, st, _ = cv2.connectedComponentsWithStats(has.astype(np.uint8), 8)
    main = np.zeros_like(has)
    for c in range(1, n_):
        if st[c, 4] >= 400:
            main |= lab == c
    specks = has & ~main
    opaque = L[..., 3] == 255
    fore = main & (t > 0)
    # elbow cap: the upper piece continues under the forearm piece in a disc around the elbow (opaque
    # mother pixels only), so a bent elbow shows cloth, not a straight cut
    r_cap = 44
    disc = np.hypot(xx - E[0], yy - E[1]) <= r_cap
    upper = main & ((t <= 0) | ((t <= r_cap) & disc & opaque))
    # the forearm piece fades over 10 px past the cut where the cap lies under it (same pixels: exact)
    Lf = L.copy()
    ramp = np.clip(t / 10.0, 0, 1)
    fade = fore & upper
    Lf[..., 3] = np.where(fade, np.round(L[..., 3] * (0.25 + 0.75 * ramp)), L[..., 3]).astype(np.uint8)
    for n, m, src in ((f'sleeve-{s}-fore', fore, Lf), (f'sleeve-{s}-upper', upper, L), (f'sleeve-{s}-specks', specks, L)):
        C = np.zeros_like(L)
        C[m] = src[m]
        cv2.imwrite(os.path.join(rig_dir, 'layers', n + '.png'), C)
    os.remove(os.path.join(rig_dir, 'layers', f'sleeve-{s}.png'))
    parts[i:i + 1] = [dict(p, name=f'sleeve-{s}-fore'), dict(p, name=f'sleeve-{s}-upper'),
                      dict(p, name=f'sleeve-{s}-specks')]
# the collar band: the part outside the arm line is the top of the sleeve (rides the upper arm), the part
# inside it belongs to the jacket body draped behind the arm (stays with the chest)
for s in 'lr':
    i = next(k for k, p in enumerate(parts) if p['name'] == f'coat-collar-{s}')
    p = parts[i]
    x, y, w, h = p['box']
    L = cv2.imread(os.path.join(rig_dir, 'layers', f'coat-collar-{s}.png'), cv2.IMREAD_UNCHANGED)
    S, E = (rig3d.J[f'{j}.{s}'][:2] for j in ('shoulder', 'elbow'))
    yy, xx = np.mgrid[y:y + h, x:x + w]
    lx = S[0] + (E[0] - S[0]) * np.clip((yy - S[1]) / (E[1] - S[1]), 0, 1)
    outer = (xx < lx + 6) if s == 'l' else (xx > lx - 6)
    has = L[..., 3] > 0
    for n, m in ((f'coat-collar-{s}-out', has & outer), (f'coat-collar-{s}-in', has & ~outer)):
        C = np.zeros_like(L)
        C[m] = L[m]
        cv2.imwrite(os.path.join(rig_dir, 'layers', n + '.png'), C)
    os.remove(os.path.join(rig_dir, 'layers', f'coat-collar-{s}.png'))
    parts[i:i + 1] = [dict(p, name=f'coat-collar-{s}-out'), dict(p, name=f'coat-collar-{s}-in')]
json.dump(meta, open(meta_p, 'w'), indent=1)
print('sleeves and collars split')
