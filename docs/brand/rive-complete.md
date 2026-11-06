# Rive Nomi production scene

`rive/nomi-complete` is the Rive CLI project behind the official character's
`characters/nomi/rive/character.riv`. Everything in it is derived from the supplied
full-body mother `rive/nomi-complete/source-nomi-master.png` (wrapped byte-for-byte in
`reference/svg-rig/nomi-fullbody-mother.svg`; both are embedded in the `.riv` as the
source lock checked by `packages/avatar-runtime/tests/rive.test.ts`).

## App contract

| What          | Value                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Artboard      | `Nomi-full`, 960×1300; the 1024×1536 mother is drawn at 1300/1536, offset x 46.67                        |
| State machine | `NomiFull`, layers `full.idle`, `full.autoblink`, `Actions`, `full.mouth`                                |
| View model    | `MascotFull`: one trigger per action, plus `viseme` / `mouthOpen` numbers and the viseme / talk triggers |

The view model, artboard header and state machine live in
`tools/rebuild/contract.xml` and are copied verbatim; animations keep their ids
(`tools/rebuild/anims-meta.json`), so the state machine needs no edits.

## Pipeline

```bash
rive/nomi-complete/tools/rebuild/build.sh   # needs uv and the Rive CLI
```

1. **Rest art** – `reference/svg-layered/mother-v2.png` is the mother with the body alpha
   normalised: the AI cut-out left 240–254 alpha noise inside the body, so `a ≥ 240 → 255`,
   `200 < a < 240` ramps to 255, `a ≤ 200` is unchanged. This is the image the rest pose
   must reproduce. (`tools/rebuild/owner.npz` records which old rig crop owned each mother pixel; segmentation starts from it.)
2. **Segmentation** (`segment.py`, geometry in `geometry.py`) – every mother pixel gets exactly
   one part. Clean old crops (eyes, brows, nose, lips, fingers, cuffs, belt, badge, pouch, shoes,
   socks, thigh strap, hem ribbons, hair clip / bow / ornament) are kept; everything else is
   re-split by colour class and body geometry into face, hair-front / hair-side-{l,r}, neck,
   chest, arm-{l,r}-skin, leg-{l,r}, tank, shorts, choker, sleeve-{l,r}, coat-front-{l,r},
   coat-collar-{l,r}, then a watershed grows line art and anti-aliasing into the neighbours.
3. **Painted backfill** (`paint.py`) – each part is completed to its full shape (whole torso
   under the tank and shorts, whole arms under the sleeves, thighs under the shorts, the face
   under bangs / eyes / side hair cut at the jaw line, a full back-hair mass, tank and shorts
   under the belt and coat). Colours are spread from the part's own pixels (normalised Gaussian
   convolution); skin and hair get a soft edge shade and a line-art outline. Backfill is kept
   only under a fully opaque part drawn above it, so the rest pose is unchanged. Blush is
   painted (`head-cheek-*`). Output: `rig/parts.json` + `rig/layers/*.png`.
4. **Sleeves and eyes** – `split_sleeves.py` cuts each sleeve at the elbow bisector into a rigid upper
   and forearm piece (16 px opaque overlap under the forearm piece), so a bent elbow rotates the cloth
   instead of smearing it; the jacket's collar band is split along the arm line too
   (outside rides the upper arm as the top of the sleeve, inside stays with the chest). Sleeves turn with the
   arm but take only half of its foreshortening, and a raised forearm flips its sleeve along the arm so the
   puff falls to the elbow as cloth would. Arm targets stay near the body plane (depth x0.35): the drawing
   has no foreshortened sleeve. `eyes.py` cuts the closed eye from `reference/sheets/nomi-sheet-parts.png`
   (image-right eye, mirrored for the left) and places it on each eye; blinks and closed-eye
   expressions swap to it instead of squashing the open eye. Hands always use the mother's own hand: `hand_rig.py` re-cuts each hand by
   traced anatomy (back of the hand; index reaching down, thumb pressing the middle, middle / ring / little
   curled behind it) into palm, thumb and index in three phalanges each, and one piece per curled finger, with
   joints fitted to the drawing (`hand-joints.json`). Finger bones are 2D children of the hand bone (the hand
   is never squashed); curls stay small so the drawing reads unchanged. The drawn hands' edge ring is opaque and mixed
   with the ribbon / shorts behind them, so each piece also has a `-clean` copy (edge pixels classified as
   skin / line art vs. background, background dropped, 1 px antialias) that actions show whenever the arm moves.
   Bangs are one layer down to the strand tips (no cut across the forehead), skinned to five two-bone strand
   chains that sway on the idle layer; all head parts sit at nearly one depth so nods and turns never open seams.
   Fist gestures (wave, cheer, fist pump, fist, thumbs-up) swap the whole hand for `hand-<side>-fist`: the back
   of the drawn hand down to the knuckles, the index / thumb gap filled with the hand's own skin, a rounded
   outlined knuckle edge. Elbow direction is automatic (down first, out second; forward when the hand comes up
   to the face, slightly back when it stays low) instead of a per-action pole. Loose sleeve specks stay on the body; the upper sleeve keeps an elbow cap under the forearm piece.
5. **2.5D rig** (`rig3d.py`, bindings in `bindings.py`, scene in `gen.py`) – a 3D skeleton (x right, y down,
   z toward the viewer) with depth per joint and per head / chest part. A pose (3D wrist targets solved by
   two-bone IK, head / spine / pelvis angles, leg angles, finger curl) is projected to the Rive bones:
   limb and finger bones follow their projected segment (rotation + scaleX, so a forearm reaching toward
   the viewer foreshortens), head and torso parts follow the projected frame at their depth anchor, so a
   head turn shifts near parts more than far ones. Bones are siblings (no 2D chain), tendons store each
   bone's rest frame, meshes are grids over each part with weights that only blend right at a joint.
   Each arm is one node with draw rules so a hand can come in front of the face.
   Animations (`anim2.py`) are written as such poses; idle (breathing, hair / coat / ribbon / badge /
   pouch sway) and blink live on child bones only those layers key, and `rest` keys every channel any
   action uses, so a blend back to rest restores everything.
6. **Checks** – `rive . --verify`, then a 1:1 copy of the scene (1024×1536 artboard, no
   animation) is rendered and compared with `mother-v2.png` by `check_rest.py`; the build fails if
   any pixel is off by more than 2.

## Shipping

```bash
rive/nomi-complete/tools/rebuild/export-riv.sh characters/nomi/rive/character.riv
```

The scene has no scripts, so no signing is needed: the script runs `rive . --headless-serve` and keeps
the build its live-link socket pushes (`livelink_riv.py`). `rive . --publish` (needs `rive login`) writes
the same scene as a signed `build/nomi-complete.riv`.

## Visual QA

`rive/nomi-complete/tools/preview/serve.sh` serves the repo and opens a local page that plays
`characters/nomi/rive/character.riv` with the app's runtime (`@rive-app/canvas-lite`, same artboard,
state machine and fit): one button per action, the mouth triggers, `viseme` / `mouthOpen` sliders, a
"play all" sequence, and drag-and-drop of another `.riv` to compare.

Headless, drive every action and look at two frames of each:

```bash
cd rive/nomi-complete
printf 'advance 30\ndata wave=1\nadvance 40\nscreenshot wave.png\nquit\n' | rive . --commands
```

Check the shoulder / elbow / wrist joins, the face edge when the head turns, the closed eyes
during a blink, and that nothing stays behind when an arm lifts (sleeve pieces must ride the arm,
coat front panels stay on the torso).
