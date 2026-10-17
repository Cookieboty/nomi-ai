# Rive Nomi production scene

The production Rive scene keeps the approved half-body mother at
`rive/nomi-complete/reference/approved-halfbody.png` and uses the supplied
full-body mother at `rive/nomi-complete/source-nomi-master.png`. The full-body
mother is embedded byte-for-byte in
`reference/svg-rig/nomi-fullbody-mother.svg`; Rive CLI bundles that SVG as the
source asset while the runtime uses the same pixels for its raster draw. The
`Nomi-full` artboard and its root/torso/head/upper-arm/forearm/hand bones share
one 960×1300 coordinate system, so fit and zoom scale the complete hierarchy.

## Build and verify

```powershell
& "$env:USERPROFILE/.rive/bin/rive.exe" doctor
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" scripts/rive-complete/build-complete.py
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

The `Nomi-full` artboard is the supplied full-body mother preview with a
CLI-embedded SVG source and an authored skeleton. The half-body `Nomi` artboard
continues to use its approved mother and deterministic cutouts.

## Skeleton and animation surface

The view model exposes idle breathing/blink/hair loops, wave, hello, cheer,
celebrate, nod, flinch, poke, shake, clap, think, work, expression clips and
mouth/talking clips. Actions are sampled from the existing canvas rig and
transition through timed state-machine blends. The torso and neck anchors stay
fixed while arm bones move. The visible sleeves are parented to shoulder pivots
in the same artboard space; action offsets are added to their authored absolute
coordinates, so changing Rive fit or zoom scales the complete hierarchy rather
than separating the hands, cuffs or shoulders.

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
