# Nomi high-fidelity Rive target

This branch turns the supplied Nomi character sheet into a buildable Rive scene. The target is a desktop mascot that keeps the supplied raster artwork intact while adding the motion that a conversation needs:

- the front three-quarter/upper-body composition is the primary artboard, with the official hair, face, eyes, mouth, jacket, badge, ribbon and N logo layers kept as separate assets;
- wave, hello, cheer and celebrate use baked arm meshes sampled from the existing canvas rig, so the elbow, cuff and hand preserve the reference proportions;
- neutral, happy, angry, sad, relaxed and surprised are state-machine triggers using the official mouth plates, head tilt and blink timing;
- talking and mouth-open/mouth-close triggers provide a lip-sync fallback for the renderer's RMS stream;
- the scene always has an idle breath, hair sway and natural blink layer underneath conversation actions.

## Build and preview

From the repository root, use the bundled Rive CLI:

```powershell
rive rive/nomi-complete --verify
rive rive/nomi-complete --once
rive rive/nomi-complete
```

The last command opens the live preview and watches `rive/nomi-complete/`. A successful build writes `rive/nomi-complete/build/nomi-complete.riv`; the renderer copy is `packages/renderer/public/assets/models/rive/nomi-complete.riv`.

The renderer keeps the Rive path behind `?rive=1` or `localStorage.setItem('nomi.experimental.rive', '1')` until the remaining full-body artboard work is reviewed. The high-fidelity scene is still the default Rive asset, so the same flag exercises the production build rather than the earlier PoC.

## Acceptance target

Every change to the scene must pass `rive . --verify` and `rive inspect . --summary`. A visual review should check the neutral, happy, surprised and talking states at 1x and 2x scale, then wave and cheer for sleeve continuity, shoulder overlap, cuff/hand contact and the absence of transparent holes. Official brand layers remain byte-identical; generated pose-state textures stay listed in `parts/DETAIL_LICENSE.json`.

The supplied sheet contains full-body reference views as well as the upper-body animation source. `Nomi-full` is a separate full-body artboard built from the authorized high-resolution neutral, wave and cheer plates. Use `?rive=full` to preview it; its `NomiFull` state machine exposes neutral idle, wave/hello and cheer/celebrate transitions while the conversation-focused `Nomi` artboard remains available with `?rive=1`.
