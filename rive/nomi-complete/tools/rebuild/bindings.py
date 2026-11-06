"""Which Rive bones each rig part is skinned to, and how soft the blend between them is (px)."""
from rig3d import FINGERS

P = {}
SOFT = {}


def bind(name, bones, soft=3.0):
    P[name] = bones
    SOFT[name] = soft


FACE3 = ['full.face.l', 'full.face.c', 'full.face.r']
for n in ['face']:
    bind(n, ['full.face.c'])      # face and bangs share one anchor: a turn never opens a seam between them
bind('hair-front', [f'full.hair.strand{i}.s{j}' for i in range(5) for j in range(2)], 14)
bind('hair-clip', ['full.hair.clip'])
bind('hair-ornament-l', ['full.hair.side.l'])
bind('hair-bow', ['full.hair.bow.sway'])
for s in 'lr':
    bind(f'hair-side-{s}', [f'full.hair.side.{s}', f'full.hair.side.{s}.s1', f'full.hair.side.{s}.s2'], 12)
bind('hair-back', ['full.hair.back'])
for n in ['head-cheek-l', 'head-cheek-c', 'head-cheek-r']:
    bind(n, ['full.cheek'])
bind('nose', ['full.nose'])
for n in ['lips', 'face-smile'] + [f'mouth-viseme-{v}' for v in 'aiueom'] + ['mouth-smile', 'mouth-open', 'mouth-flat']:
    bind(n, ['full.mouth'])
for s in 'lr':
    for p in ['lash', 'lid', 'sclera', 'closed']:
        bind(f'eye-{s}-{p}', [f'full.eye.{s}.blink'])
    for p in ['iris', 'hl']:
        bind(f'eye-{s}-{p}', [f'full.eye.{s}.ball'])
    bind(f'brow-{s}', [f'full.brow.{s}'])
    bind(f'eye-{s}-closed', [f'full.lid.{s}'])
    bind(f'eye-{s}-closed-a', [f'full.lid.{s}'])
CHEST3 = ['full.chest.l', 'full.chest.c', 'full.chest.r']
bind('choker', ['full.neck'])
bind('neck', ['full.chest.c', 'full.neck', 'full.head'], 10)
bind('chest', ['full.torso'] + CHEST3, 30)
bind('tank', ['full.torso'] + CHEST3, 30)
# the collar band is the top of the sleeve of this off-shoulder jacket: it rides the upper arm as one piece
bind('coat-collar-l-out', ['full.sleeve-l.upper'])
bind('coat-collar-r-out', ['full.sleeve-r.upper'])
bind('coat-collar-l-in', ['full.chest.l'])
bind('coat-collar-r-in', ['full.chest.r'])
bind('belt-band', ['full.pelvis', 'full.torso'], 10)
bind('belt-id', ['full.belt.id.sway'])
bind('belt-pouch', ['full.belt.pouch.sway'])
bind('shorts', ['full.pelvis', 'full.leg-l.upper', 'full.leg-r.upper'], 10)
bind('thigh-strap', ['full.leg-l.upper'])
for s in 'lr':
    bind(f'arm-{s}-skin', [f'full.clav.{s}', f'full.arm-{s}.upper', f'full.arm-{s}.fore', f'full.arm-{s}.hand'])
    bind(f'sleeve-{s}', [f'full.arm-{s}.upper', f'full.arm-{s}.fore', f'full.arm-{s}.hand'])
    bind(f'sleeve-{s}-upper', [f'full.sleeve-{s}.upper'])
    bind(f'sleeve-{s}-fore', [f'full.sleeve-{s}.fore'])
    bind(f'sleeve-{s}-specks', [f'full.chest.{s}'])
    bind(f'arm-{s}-cuff', [f'full.arm-{s}.fore', f'full.arm-{s}.hand'])
    bind(f'hand-{s}-palm', [f'full.arm-{s}.hand'])
    bind(f'hand-{s}-fist', [f'full.arm-{s}.hand'])
    for f in ['index', 'thumb']:
        for i in range(3):
            bind(f'hand-{s}-{f}-p{i}', [f'full.arm-{s}.{f}.j{i}'])
    for f in ['middle', 'ring', 'little']:
        bind(f'hand-{s}-{f}', [f'full.arm-{s}.{f}.j0'])
    bind(f'hand-{s}-palm-meta', [f'full.arm-{s}.hand'])
    for g in ['fist', 'point', 'thumbsup', 'peace', 'ok', 'open']:
        bind(f'hand-{s}-g-{g}', [f'full.arm-{s}.hand'])
    bind(f'coat-front-{s}', [f'full.chest.{s}', f'full.coat-{s}.front', f'full.coat-{s}.front.s1', f'full.coat-{s}.front.s2'], 12)
    bind(f'hem-ribbon-{s}', [f'full.hem.ribbon.{s}', f'full.hem.ribbon.{s}.s1'], 12)
    bind(f'leg-{s}', ['full.pelvis', f'full.leg-{s}.upper', f'full.leg-{s}.lower', f'full.leg-{s}.foot'])
    bind(f'sock-{s}', [f'full.leg-{s}.lower', f'full.leg-{s}.foot'])
    bind(f'shoe-{s}', [f'full.leg-{s}.foot'])


# clean hand copies ride the same bones as the pieces they replace
for _n in list(P):
    if _n.startswith('hand-') and not _n.endswith('-clean'):
        bind(_n + '-clean', P[_n], SOFT[_n])
