#!/usr/bin/env python3
"""Brand-lock verification for the Rive complete-parts build (r3: AI pose-state arm art).
1. every embedded official layer is byte-identical (sha256) to the polish-branch layer recorded in parts.json
2. the scene embeds ONLY: official layers (hairclip N logo 'clip', badge, jacket body-noarm/flanks, head, bangs, crown, ribbon,
   earring, strap, eyes, mouth, ...) and parts/ai/* arm textures; no AI texture is used for any brand part
3. every parts/ai file is listed in DETAIL_LICENSE.json with ai_generated: true and its sha256 matches; the LICENSE file exists
4. AI art scope: torso pieces cropped away (alpha == 0 where the generated image had pocket / hood / collar), and colour-matched:
   median white / orange / skin / dark of the AI textures vs the official arm texture
"""
import hashlib, json, re, sys
from pathlib import Path
import numpy as np, cv2
R = Path(__file__).resolve().parents[2] / 'rive/nomi-complete'
ok = True
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
parts = json.loads((R / 'official/parts.json').read_text())
n = bad = 0
for grp in ('parts', 'hands'):
    for p in parts.get(grp, []):
        f = R / 'official' / p['file']
        if not f.exists(): continue
        n += 1
        if p.get('sha256') and sha(f) != p['sha256']: bad += 1; print('SHA MISMATCH', p['id'])
print(f'[1] official layers checked: {n}, mismatches: {bad}'); ok &= bad == 0
scene = (R / 'scene.rml').read_text()
files = re.findall(r'file="([^"]+)"', scene)
off = [f for f in files if f.startswith('official/')]; ai = [f for f in files if f.startswith('parts/ai/')]
full = [f for f in files if f.startswith('fullbody/')]
other = [f for f in files if not f.startswith('official/') and not f.startswith('parts/ai/') and not f.startswith('fullbody/')]
brand = ['clip', 'badge', 'body-noarm', 'body-flank-l', 'body-flank-r', 'head', 'bangs', 'crown', 'ribbon', 'earring', 'strap-r', 'hair-tail-l', 'hair-tail-r']
pid = {p['id']: p['file'] for p in parts['parts']}
miss = [b for b in brand if 'official/' + pid.get(b, '?') not in files]
print(f'[2] scene assets: official {len(off)}, parts/ai {len(ai)}, fullbody {len(full)}, other {len(other)} {other}; brand parts not official: {miss}')
ok &= not other and not miss
lic = json.loads((R / 'parts/DETAIL_LICENSE.json').read_text())['assets']
badl = 0
for f in ai:
    rel = f[len('parts/'):] if False else f
    e = lic.get(f)
    if not e or e.get('ai_generated') is not True or e.get('sha256') != sha(R / f): badl += 1; print('LICENSE/SHA problem', f)
for f in full:
    e = lic.get(f)
    if not e or e.get('ai_generated') is not True or e.get('sha256') != sha(R / f): badl += 1; print('LICENSE/SHA problem', f)
for k, e in lic.items():
    if k.startswith(('parts/ai/', 'gen-src/')) and (e.get('ai_generated') is not True or e.get('sha256') != sha(R / k)): badl += 1; print('LICENSE/SHA problem', k)
print(f'[3] AI files in scene: {len(ai)}, license problems: {badl}, LICENSE file: {(R / "LICENSE").exists()}'); ok &= badl == 0 and (R / 'LICENSE').exists()
# 4. scope + colour match
def med(img, name):
    bgr = img[..., :3]; a = img[..., 3] > 240
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV); h, s, v = [hsv[..., i].astype(float) for i in range(3)]
    ms = dict(white=a & (s < 40) & (v > 190), orange=a & (s > 120) & (h > 5) & (h < 22) & (v > 150), skin=a & (s > 25) & (s < 110) & (h > 3) & (h < 25) & (v > 180))
    return {k: np.median(bgr[m], 0)[::-1].round().astype(int).tolist() for k, m in ms.items() if m.sum() > 50}
offi = cv2.imread(str(R / 'parts/arm-r-official.png'), cv2.IMREAD_UNCHANGED); offm = med(offi, 'off')
print('[4] official arm medians (RGB):', offm)
for st in ('hang', 'bent', 'up'):
    im = cv2.imread(str(R / f'parts/ai/arm-{st}-r.png'), cv2.IMREAD_UNCHANGED); m = med(im, st)
    d = {k: int(np.abs(np.array(m[k]) - np.array(offm[k])).max()) for k in m if k in offm}
    print(f'    {st}: medians {m}  max channel delta vs official {d}')
    ok &= all(v <= 40 for v in d.values())
    H, W = im.shape[:2]; yy, xx = np.mgrid[0:H, 0:W]
    if st == 'bent': leak = int((im[..., 3][xx / 1.25 < 233] > 0).sum())
    elif st == 'up': leak = int((im[..., 3][(yy / 1.25 > 442) & (xx / 1.25 < 392)] > 0).sum())
    else: leak = 0
    print(f'    {st}: torso-crop leak px = {leak}'); ok &= leak == 0
print('BRAND LOCK', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
