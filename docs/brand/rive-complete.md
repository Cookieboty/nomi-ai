# Rive Nomi production scene

The production Rive scene is generated from the approved half-body mother image
at `rive/nomi-complete/reference/approved-halfbody.png`. The two character
sheets beside it are reference-only guides for proportions and future cuts. The
default `Nomi` artboard keeps the approved mother pixels intact while the
legacy experimental layer stack is isolated from the render path.

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
reference. It remains separate from the half-body bone rig until the source is
split into head, torso, arms and legs.

## Animation surface

The view model exposes idle breathing/blink/hair loops, wave, hello, cheer,
celebrate, nod, flinch, poke, shake, clap, think, work, expression clips and
mouth/talking clips. Actions are sampled from the existing canvas rig and
transition through timed state-machine blends. The torso and neck anchors stay
fixed while arm bones move.

## Visual QA

Capture neutral and wave frames with the same viewport and inspect the shoulder,
elbow, wrist, hand and neck anchors. Also test a pointer drag after changing
zoom. `brand-check.py` must report zero stale generated references and zero
license problems before committing.
