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
`packages/renderer/public/assets/models/rive/nomi-complete.riv` by the release
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
