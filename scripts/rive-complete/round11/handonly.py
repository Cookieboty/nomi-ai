#!/usr/bin/env python3
"""handonly.py PROJ OUTPROJ [regex]: copy of PROJ whose Images not matching regex (default: hand pieces) get opacity=0.
Renders then give the true hand coverage alpha (transparent background)."""
import os, re, shutil, subprocess, sys
proj, out = sys.argv[1], sys.argv[2]
rx = re.compile(sys.argv[3] if len(sys.argv) > 3 else r'full\.hand-[lr]\.')
os.makedirs(out, exist_ok=True)
for n in os.listdir(proj):
    if n in ('scene.rml', 'build'): continue
    d = os.path.join(out, n)
    if not os.path.exists(d): os.symlink(os.path.abspath(os.path.join(proj, n)), d)
s = open(os.path.join(proj, 'scene.rml'), encoding='utf-8').read()
def f(m):
    return m.group(0) if rx.search(m.group(1)) else m.group(0).replace('<Image ', '<Image opacity="0" ', 1)
def g(m):
    t = m.group(0)
    if ' opacity="' in t or rx.search(m.group(1)): return t
    return t.replace('<Image ', '<Image opacity="0" ', 1)
s = re.sub(r'<Image name="([^"]*)"[^>]*?>', g, s)
open(os.path.join(out, 'scene.rml'), 'w', encoding='utf-8').write(s)
