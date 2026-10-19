ROUND11 verification tools (all need the `rive` CLI in PATH: `export PATH=$HOME/.rive/bin:$PATH`).

- handonly.py PROJ OUT [regex] copy of a project in which every Image not matching regex has opacity 0 (hand-only renders).
- gapscan.py PROJ TAG TRIGGER f1,f2,.. hand-only coverage masks (/tmp/gs); gapmetric.py TAGA TAGB TRIGGER -> gap px table.
- thumbscan.py PROJ TAG f1,.. real `fist` renders: thumb px outside the palm width (sideT), outside the rest hull (outT), all-hand (outA); thumbsheet.py draws the sheet.
- allclips2.py A B OUT.md frames all triggers A vs B, diff px inside / outside the hand zone.
- shots11.py BEFORE AFTER OUTDIR before/after closeups + contact sheets.
- prev.py / fistsim.py / search_thumb.py numpy skinning preview used to design the thumb path (same maths as the Rive skin).
