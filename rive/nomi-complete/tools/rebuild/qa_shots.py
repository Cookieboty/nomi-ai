"""Write a `rive . --commands` script that fires every action and screenshots it at the given fractions
of its duration. usage: qa_shots.py <out dir> [fractions, default 0.3,0.6] > cmds.txt"""
import sys, os, json
out = os.path.abspath(sys.argv[1])
fr = [float(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '0.3,0.6').split(',')]
meta = json.load(open(os.path.join(os.path.dirname(__file__), 'anims-meta.json')))
print('advance 30')
print(f'screenshot {out}/000-rest.png')
for m in meta:
    if m['layer'] != 'Actions' or m['name'] == 'rest':
        continue
    t = m['name'].split('.', 1)[1]
    d = int(m['duration'])
    print(f'data {t}=1')
    at = 0
    for i, f in enumerate(fr):
        tgt = int(d * f) + 12
        print(f'advance {tgt - at}')
        at = tgt
        print(f'screenshot {out}/{t}-{"abcdefgh"[i]}.png')
    print(f'advance {d - at + 40}')
print('quit')
