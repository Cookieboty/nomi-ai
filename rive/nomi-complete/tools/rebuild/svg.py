"""Write the layered SVG of the rig parts (rig/parts.json + rig/layers), bottom -> top, one Inkscape layer
per part. Visible layers recompose mother-v2 exactly; alternates (finger phalanges, visemes, blush) are
display:none. usage: svg.py <rig dir> <out.svg>"""
import sys, os, json, base64
rig, out_svg = sys.argv[1:3]
parts = json.load(open(os.path.join(rig, 'parts.json')))['top_first']
o = ['<?xml version="1.0" encoding="UTF-8"?>',
     '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
     'width="1024" height="1536" viewBox="0 0 1024 1536">',
     '  <!-- Nomi rig parts, bottom -> top (rive/nomi-complete/rig). Each layer holds its rest pixels of',
     '       mother-v2 plus painted backfill hidden under the parts above; the visible layers recompose',
     '       mother-v2 exactly. display:none layers are animation alternates. -->']
for p in reversed(parts):
    if not p.get('box'):
        continue
    x, y, w, h = p['box']
    b = base64.b64encode(open(os.path.join(rig, 'layers', p['name'] + '.png'), 'rb').read()).decode()
    st = '' if p['visible'] else ' style="display:none"'
    o.append(f'  <g id="{p["name"]}" inkscape:groupmode="layer" inkscape:label="{p["name"]}"{st}>')
    o.append(f'    <image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="none" '
             f'style="image-rendering:pixelated" href="data:image/png;base64,{b}"/>')
    o.append('  </g>')
o.append('</svg>')
open(out_svg, 'w').write('\n'.join(o) + '\n')
print('wrote', out_svg, sum(1 for p in parts if p.get('box')), 'layers')
