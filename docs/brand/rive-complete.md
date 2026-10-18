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

### Mesh+Skin follow-up

A 4-row Image Mesh with identity Tendons was prototyped (`scripts/rive-complete/add-arm-meshes.py`)
but **not** left enabled: on the current `length=1` / `scaleX=1` bones it shattered
sleeves during bends (parented meshes double-transform; root-level meshes still
tore at the elbow with strip weights). The proven continuous-arm pattern lives on
`feat/mascot-rive-complete-parts` (length-encoded bones + Tendon rotation/scale
matrices). Port that bind model onto these mother crops before re-enabling meshes.
