# Rive Nomi production scene

The production Rive scene is generated from the approved half-body mother image
at `rive/nomi-complete/reference/approved-halfbody.png`. The two character
sheets beside it are reference-only guides for proportions and future cuts. The
default `Nomi` artboard uses one deterministic source of truth: `base.png`,
`arm-l.png` and `arm-r.png` are alpha cutouts from that mother image, all placed
in the same 960×1300 artboard coordinate system. The old experimental layer
stack is isolated under `legacy.rig` and cannot affect the rendered silhouette.

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

The optional `Nomi-full` artboard is a stable preview of the supplied mother
reference. It remains a separate full-body plate until the source is split into
head, torso, arms and legs; the interactive default remains the high-fidelity
half-body rig.

## Skeleton and animation surface

The view model exposes idle breathing/blink/hair loops, wave, hello, cheer,
celebrate, nod, flinch, poke, shake, clap, think, work, expression clips and
mouth/talking clips. Actions are sampled from the existing canvas rig and
transition through timed state-machine blends. The torso and neck anchors stay
fixed while arm bones move. The visible sleeves are parented to shoulder pivots
in the same artboard space; action offsets are added to their authored absolute
coordinates, so changing Rive fit or zoom scales the complete hierarchy rather
than separating the hands, cuffs or shoulders.

The production source is deliberately raster for the fabric and face texture.
Rive meshes and bones are used where deformation is needed; SVG is reserved for
future geometry-only details. New actions must reuse the three source cutouts or
their bone-bound derivatives instead of importing a separately generated pose
plate, which would break the source lock and introduce costume drift.

## Visual QA

Capture neutral and wave frames with the same viewport and inspect the shoulder,
elbow, wrist, hand and neck anchors. Also test a pointer drag after changing
zoom. `brand-check.py` must report zero stale generated references and zero
license problems before committing.
