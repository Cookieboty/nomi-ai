# Rive Nomi production scene

The production Rive scene uses only the supplied full-body mother at
`rive/nomi-complete/source-nomi-master.png`. The mother is embedded byte-for-byte
in `reference/svg-rig/nomi-fullbody-mother.svg`; Rive CLI bundles that SVG as
the source asset while the runtime draws the same pixels. The `Nomi-full`
artboard and its root/torso/head/upper-arm/forearm/hand bones share one 960×1300
coordinate system, so fit and zoom scale the complete hierarchy.

## Build and verify

```powershell
& "$env:USERPROFILE/.rive/bin/rive.exe" doctor
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" scripts/rive-complete/build-fullbody-svg-rig.py
Push-Location rive/nomi-complete
& "$env:USERPROFILE/.rive/bin/rive.exe" . --verify
& "$env:USERPROFILE/.rive/bin/rive.exe" . --once
Pop-Location
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" scripts/rive-complete/brand-check.py
```

The resulting `rive/nomi-complete/build/nomi-complete.riv` is copied to
`characters/nomi/rive/character.riv` (the official character pack) by the release
workflow.

## Asset rule

The scene contains no old AI pose plates or legacy full-body pose images. Every
non-official file is listed with a SHA-256 hash in
`rive/nomi-complete/parts/DETAIL_LICENSE.json`.

The `Nomi-full` artboard is the only production artboard. The previous half-body
artboard, layer stack and generated pose plates were removed so a stale renderer
cannot select a detached-arm asset. The full-body source is split into a body,
head, six sleeve/forearm/hand layers and a small smile overlay; the head image is
parented to `full.head` at the neck pivot.

## Skeleton and animation surface

The view model exposes the full-body action triggers wave, hello, cheer,
celebrate, nod, flinch, poke, shake, clap, think, work and smile. The idle timeline
keeps a subtle breathing scale while action timelines transition through timed
state-machine blends. The torso and neck anchors stay fixed while upper-arm,
forearm and hand bones move. The visible sleeves are parented to shoulder
pivots in the same artboard space; action offsets are added to their authored
absolute coordinates, so changing Rive fit or zoom scales the complete
hierarchy rather than separating the hands, cuffs, shoulders or head.

The production source preserves the raster fabric and face texture inside the
SVG mother. Rive root bones are authored for the full-body hierarchy and the
derived arm crops are kept in the same source coordinate system. New actions
must reuse this SVG-backed mother and its bone-bound derivatives instead of
importing a separately generated pose plate, which would break the source lock
and introduce costume drift.

## Visual QA

Capture neutral and wave frames with the same viewport and inspect the shoulder,
elbow, wrist, hand and neck anchors. Also test a pointer drag after changing
zoom. `brand-check.py` must report zero stale generated references and zero
license problems before committing.

## Full-bone crop pass (feat/mascot-rive-full-bone-rig)

Rebuild the arm/hand crops from `source-nomi-master.png` so each moving layer is a
true silhouette matte (shoulder / upper sleeve / lower sleeve / cuff / palm /
five fingers per side). Dark and orange garment detail passes are restored as
separate mother-pixel layers that share the arm bones with the base fabric.

The right thumb is occluded in the mother rest pose; the build script mirrors the
left-thumb mother pixels into `hand-r-thumb.png` and composites any native sliver
on top (registered in `parts/DETAIL_LICENSE.json`).

### Animation fixes

- **clap**: both `full.arm-*.rig` translate toward the chest while elbows bend
  inward and wrists rotate so palms face each other (no left/right cross-through).
- **wave / cheer / idle**: retimed on the production bone ids; idle adds a soft
  torso/arm sway on top of the breathing scale.

### Mesh+Skin (ROUND2)

`scripts/rive-complete/add-arm-meshes.py` migrates each arm to three independent
RootBones (`upper` / `fore` / `hand`) under `arm.rig` with **rest rotation = limb
angle** (r3 pattern). Sleeve / coat-shoulder / cuff / upper-skin Images are remounted
under `arm.rig` (not under a rotating bone) and carry a grid `Mesh` + `Skin` with
Tendon **rotation matrices**. `bone.scaleX` stays `1` on mother crops: putting the
link length into `scaleX` (as r3 does for AI straight-sleeve art) warped the rest pose.

`scripts/rive-complete/bake-arm-fk-anims.py` converts relative rotation keys into
absolute FK (`rotation` + fore/hand `x`/`y`). It is idempotent. Elbow overlap in
`build-fullbody-svg-rig.py` was widened so upper/lower sleeves share a blend zone.

### ROUND3 — continuous sleeve + Solo bent scaffold

`partition()` keeps the full garment matte in the base layer (no orange/dark
punch-holes). Arms use mother-derived `sleeve-{l,r}-full` crops with a denser
three-bone Mesh (GRID=16, elbow blend ±85 artboard px). Palm/fingers draw after
the cuff. A Solo hang/bent pair is authored (`sleeve-*-bent.png` = mother-pixel
forearm warp); clap/wave currently stay on hang because the warp art is not yet
cleaner than continuous skin at peak bend. Clap uses less `arm.rig` chest pull.

### ROUND4 — shoulder seam + torso-locked collar

Coat/sleeve hard-subtract left **zero overlap**, so orange collar sawteeth and cream
gaps appeared as soon as meshes diverged. Crops now keep a ~12–20px soft underlap
(sleeve core eroded before subtract) and absorb collar-band orange into the coat
matte. `coat-*-shoulder` is **torso-locked** (static under `full.root`, drawn after
arm.rig) so clap `arm.rig` chest pull cannot tear the orange collar off the jacket
body; sleeves still slide underneath. Clap arm.rig translation further reduced.
Coat shoulder alpha is lightly feathered to reduce polygon sawteeth.

### ROUND5 — shoulder stump + raised wave

Idle sawteeth: deeper soft underlap (~24–36px), stronger coat alpha feather, and
proximal **stump lock** on `sleeve-*-full` (upper-only near shoulder). A torso-locked
`sleeve-*-stump` mother patch sits under the orange collar so raised arms do not open
a cream socket hole.

**wave** retimed for a viewer-facing raise: modest outward upper (~−0.6 rad) + deep
elbow bend (~−2.1) so the hand reaches cheek/head height with wrist oscillation; Solo
stays on hang. Extreme upper (~−1.15) tore the sleeve off the collar.

### ROUND6 — windshield-wiper wave

**wave** retargeted to a real greeting: `upper≈−1.10` (hold) + `fore≈−1.55`
(bake interior ≈ |fore_delta| → ~90° elbow), hand FK ~head-side. Wrist relative
keys **cancel** chain inheritance so absolute palm faces the camera; finger bones
spread open. Elbow Mesh blend band **B=85→20** for a harder bone polyline.
Solo stays hang (outward bent Solo still tears). See scratch `v6/` screenshots.

### ROUND7 — full mother decompose (layers + skeleton coverage)

Pause single-action polish. Inventory every mother-visible part vs Image/RootBone/Mesh,
then crop missing face/hair/accessory/leg layers from `source-nomi-master.png`, punch
them out of `head.png` / `fullbody-base-no-head-arms.png`, and parent Images under
existing or new bones (`hair.clip`, `hair.bow`, `choker`, `belt*`, `hem.ribbon.*`,
`thigh.strap`).

Selective Mesh+Skin (honest, not full-body claim): remounted single-bone meshes on
thigh / calf-sock / shoe (L+R) and coat tails. Arm meshes unchanged. Finger phalanx
sub-crops skipped (≈6px); whole-finger Images stay on finger roots without Mesh.

Idle meanΔ vs mother (character ROI) improves vs ROUND6; screenshots in scratch `v7/`.
Script: `scripts/rive-complete/round7-full-decompose.py`. Checklist:
`/workspace/scratch/rive-bone-rig/FULL-DECOMPOSE-CHECKLIST.md`.

### ROUND8 — tank / shorts split + continuous leg & finger skinning

Built on ROUND7 (`5d7f38c`). R7 labels were wrong in places (the "belt" crop was really
the shorts band; thigh/calf bones sat at the wrong joints), so the layers were re-cut from
`source-nomi-master.png` (`round8_layers.py`) and the scene rebuilt from the pinned R7
scene (`round8_scene.py`, idempotent).

- **Black vest + N logo** (`torso-tank`) and **shorts** (+ `belt-id` / `belt-pouch`
  overlays on dedicated pelvis bones) are independent Images; the base keeps only a 7px
  ring under them (no see-through when the torso sways). Shorts carry a dark fabric fill
  under the swinging ID/pouch. Mother body alpha (249–253) is snapped to 255 on every cut layer.
- **belt-band** is a light 3-tendon Mesh (torso → pelvis blend), overlapped 6px with the tank and shorts.
- **Legs**: one continuous Mesh+Skin per leg (thigh incl. thigh strap → calf → sock) with
  3 tendons (thigh/knee/ankle) and smoothstep weights across knee and ankle; shoes ride the
  foot bones. Skin holes left by the hands are inpainted, the thigh top tucks under the shorts.
- **Fingers**: every finger is a nested 3-bone chain (`.1` at PIP, `.2` at DIP) with one
  3-tendon Mesh. The R7 "parent-space" failure came from skinning Images that sat under
  the finger root: Images must sit under the same parent as the bones (here `arm.rig`,
  like the sleeves) and tendon binds are in that rig space. Original root pivots are
  kept so wave/clap finger spread matches ROUND7.
- Residual hand-fringe slivers (hem-ribbon / coat tails / base) were removed.

Scripts: `round8_layers.py`, `round8_scene.py`, `round8_metrics.py`. Screenshots in scratch `v8/`.

### ROUND9 — one continuous skinned hand per side (finger ghosts / overlap removed)

Root cause of the "multi-layer, ghosted, floating" fingers in R8: the hand skin pixels were
drawn ~8× per hand (≈2.4× on average). The cuff crop embedded the whole hand (+ thigh chunk and
ribbon strip), the palm crop already contained all fingers, and five more whole-finger crops
overlapped it. Finger bones also pivoted ~60px below the fingertips and the hand bone sat 38px
off the wrist, so any rotation slid the stacked copies apart; the wave counter-rotated the hand.

- Each hand is now **one** crop (`hand-l.png` / `hand-r.png`, cut from the mother) skinned as a
  single Mesh with 17 tendons: hand + 5×3 phalanx bones at the real joints (soft capsule
  weights, no seams) + the forearm bone, whose weight is 100% on the wrist rows so they ride
  the cuff band exactly and then blend into the hand (no wedge when the wrist flexes).
- Hand bone re-pivoted to the wrist (`round9_scene.py`, keys rewritten so the pose is unchanged);
  the wave hand follows the forearm and the forearm leans slightly inward at the peak.
- Cuff / sleeve / hem-ribbon / base crops had their embedded hand, wrist and sliver pixels
  removed (`round9_layers.py`). Old `hand-*-{palm,thumb,index,middle,ring,little}` assets deleted.
- Result per hand: 9 → 4 Images touching the hand (1 hand mesh + cuff/sleeve/hem with ≤ 150 px
  of fringe), skin overdraw 2.4× → 1.0× (max 5× → 2×). Image 61→51, Mesh/Skin 25→17.

Scripts: `round9_{layers,rig,scene,shots,viz,inventory}.py` (idempotent, pinned to `be33278`).
Screenshots in scratch `v9/`.

### ROUND10 — cuff drawn once, ribbon shard gone, fist-ready hand pieces

- **Orange shard beside the wave wrist**: `arm-*-cuff` (and `sleeve-l-full`) still carried a chunk of
  the orange hem ribbon (R 270 px, L 385+72 px). It rode the forearm, so it floated next to the wrist
  in wave. The shard (and the 1px AA strands along the cuff edge) is removed from the cuff / sleeve
  crops and handed to the body-locked `hem-ribbon-*` layer, whose crop now grows upward (L +53 rows,
  R +9) so the ribbon still reaches up behind the cuff in idle.
- **Cuff band drawn twice**: `sleeve-*-full` (+ `-full-dark` shading) had the whole band baked in,
  and `arm-*-cuff` drew it again (R 5364 px / L 6459 px double-drawn, skinned differently → ghost in
  wave). The cuff owns the band now; the sleeve crops lose every pixel under it (6px seam kept along
  the cuff's top cut). Double-drawn px: R 5364→832, L 6459→969 (remaining = the seam rows).
- **Fist**: the single skinned hand (R9) tore when fingers closed (the soft weight band between finger
  and palm is sheared into strings). The hand is now **palm + 5 finger pieces** cut from the same
  hand crop (`hand-<side>-{palm,thumb,index,middle,ring,little}.png`), each skinned only to its own
  bones; a finger piece carries a 1.5px ring so the hinge/edge overlap hides the seam at rest. Hand
  skin overdraw 1.0× → ~1.3× (ring overlap only). New `fist` trigger / `full.fist` clip
  (72f) validates the extreme curl; `fist` is also in `RIVE_NATIVE_MOTIONS`.

Pipeline: `scripts/rive-complete/round10_build.sh` (pinned to `754f4a0`):
`round10_layers.py` → `round10_scene.py` → `round10_hand_scene.py` → `round10_fist.py`.
Checks: `round10_overdraw.py` (per-pixel layer overlap), `round10_fist_shots.py`, `round10_regress.py`;
skinning preview used to pick the fist angles: `round10_hand.py`, `fistsim_view.py`, `fistsim_eval.py`.
Screenshots in scratch `v10/`.
