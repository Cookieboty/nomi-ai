# Nomi high-fidelity Rive target

This branch turns the supplied full-body Nomi mother into a buildable Rive scene. The target is a desktop mascot that keeps the supplied raster artwork intact while adding the motion that a conversation needs:

- the supplied full-body mother is the only production artboard and is embedded byte-for-byte in an SVG source asset;
- wave, hello, cheer and celebrate use baked arm meshes sampled from the existing canvas rig, so the elbow, cuff and hand preserve the reference proportions;
- the full-body root, torso, head, upper-arm, forearm and hand bones stay in one artboard coordinate system;
- neutral idle, wave, hello, cheer and celebrate are authored in the sole `NomiFull` state machine;
- zooming and fit changes scale the same hierarchy without swapping or detaching body parts.

## Build and preview

From the repository root, use the bundled Rive CLI:

```powershell
rive rive/nomi-complete --verify
rive rive/nomi-complete --once
rive rive/nomi-complete
```

The last command opens the live preview and watches `rive/nomi-complete/`. A successful build writes `rive/nomi-complete/build/nomi-complete.riv`; the shipped copy is `characters/nomi/rive/character.riv`.

The renderer always loads the full-body `Nomi-full` artboard. The previous
half-body artboard and the experiment flag path were removed.

## Acceptance target

Every change to the scene must pass `rive . --verify` and `rive inspect . --summary`. A visual review should check the neutral, happy, surprised and talking states at 1x and 2x scale, then wave and cheer for sleeve continuity, shoulder overlap, cuff/hand contact and the absence of transparent holes. Official brand layers remain byte-identical; generated pose-state textures stay listed in `parts/DETAIL_LICENSE.json`.

`Nomi-full` exposes the neutral idle, wave/hello and cheer/celebrate
transitions through the sole `NomiFull` state machine.
