"""Verify that the production Rive scene contains no stale generated pose art."""
import hashlib, json, re, sys
from pathlib import Path
R = Path(__file__).resolve().parents[2] / 'rive/nomi-complete'
ok = True

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
parts = json.loads((R / 'official/parts.json').read_text(encoding='utf-8'))
n = bad = 0
for grp in ('parts', 'hands'):
    for item in parts.get(grp, []):
        f = R / 'official' / item['file']
        if not f.exists(): continue
        n += 1
        if item.get('sha256') and sha(f) != item['sha256']:
            bad += 1; print('SHA MISMATCH', item['id'])
print(f'[1] official layers checked: {n}, mismatches: {bad}'); ok &= bad == 0
scene = (R / 'scene.rml').read_text(encoding='utf-8')
files = re.findall(r'file="([^"]+)"', scene)
stale = [f for f in files if f.startswith(('parts/ai/', 'gen-src/', 'fullbody/'))]
missing = [f for f in files if not (R / f).exists()]
print(f'[2] scene files: {len(files)}, stale generated refs: {len(stale)} {stale}, missing: {len(missing)} {missing}')
ok &= not stale and not missing
lic = json.loads((R / 'parts/DETAIL_LICENSE.json').read_text(encoding='utf-8'))['assets']
problems = 0
for f in files:
    if f.startswith('official/'):
        continue
    key = f if f in lic else f.removeprefix('parts/')
    entry = lic.get(key)
    if not entry or entry.get('ai_generated') is not False or entry.get('sha256') != sha(R / f):
        problems += 1; print('LICENSE/SHA problem', f)
print(f'[3] licensed production assets: {len(lic)}, problems: {problems}, LICENSE file: {(R / "LICENSE").exists()}')
ok &= problems == 0 and (R / 'LICENSE').exists()
print('BRAND LOCK', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
