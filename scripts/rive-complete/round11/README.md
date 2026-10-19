ROUND11 verification tools (all need the `rive` CLI in PATH: `export PATH=$HOME/.rive/bin:$PATH`).

- handonly.py PROJ OUT [regex] copy of a project in which every Image not matching regex has opacity 0 (hand-only renders).
- gapscan.py PROJ TAG TRIGGER f1,f2,.. hand-only coverage masks (/tmp/gs); gapmetric.py TAGA TAGB TRIGGER -> gap px table.
- thumbscan.py PROJ TAG f1,.. real `fist` renders: thumb px outside the palm width (sideT), outside the rest hull (outT), all-hand (outA); thumbsheet.py draws the sheet.
- allclips2.py A B OUT.md frames all triggers A vs B, diff px inside / outside the hand zone.
- shots11.py BEFORE AFTER OUTDIR before/after closeups + contact sheets.
- prev.py / fistsim.py / search_thumb.py numpy skinning preview used to design the thumb path (same maths as the Rive skin).
- otherclips12.py BEFORE AFTER OUTDIR (ROUND12) enclosed-hole px of the hand coverage + before|after sheets for wave/hello/poke/ok/peace/thumbs_up/explain/fist_pump (needs the /tmp/_ac_* hand-only copies that allclips2.py makes).

ROUND12: the 虎口 (thumb-index web) opening of the mother art is backed by a `web` piece (round10_hand.py `web_patch`/`web_weights`):
skin/outline colours sampled from the neighbouring mother pixels, drawn right above the palm and under all fingers, skinned to hand + thumb root + index root.
