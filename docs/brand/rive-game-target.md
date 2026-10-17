# Rive mascot game target

The production target for the Nomi Rive mascot is a small game character, not a
sequence of swapped screenshots. Every visible reaction must preserve the same
head, neck, torso and shoulder anchors while the body parts move through a
shared rig.

## Acceptance target

- The default `Nomi` artboard uses the supplied transparent layers for the
  head, face, torso, jacket and hands.
- Shoulder, elbow and wrist are independently addressable for both arms.
- Wave, hello, cheer and celebrate are sampled from the existing canvas rig and
  drive those bones with a continuous transition. The hand remains visible at
  the end of the motion.
- Nod, flinch, poke, shake, clap, think and work are real Rive clips and return
  to the rest pose through a timed transition.
- Expressions and mouth clips are separate from body clips, so a reply can
  talk, blink and gesture at the same time.
- Pointer hit testing uses the current scaled canvas geometry. A click, double
  click, pat and drag can coexist with Electron click-through mode, and toolbar
  controls stay clickable.
- The Rive asset is verified and copied to the renderer public asset path in the
  same build step.

## Layer rule

The default artboard never changes a complete character plate during a gesture.
Every arm pose reuses the same official arm texture and changes only the
shoulder, elbow and wrist bones. Generated pose plates, AI arm images and
shoulder patches are excluded from the production scene.

The optional `Nomi-full` artboard is a stable preview of the supplied mother
reference. It is kept separate from the production half-body rig until the
full-body source has been split into head, torso, arms and legs.

## Vector and texture policy

Rive-native vector shapes are preferred for flat, interactive elements such as
the Nomi mark, eye masks, badges and simple UI accents. Painterly hair,
highlights, fabric folds and hands stay as transparent source textures and are
deformed by Rive bones or meshes. Automatic PNG-to-SVG tracing is excluded
because it creates jagged silhouettes and loses the reference shading.

## Verification

Run the following before shipping a mascot change:

```powershell
python scripts/rive-complete/build-complete.py
rive/nomi-complete --verify
rive/nomi-complete --once
node scripts/rive-complete/brand-check.py
node scripts/run-bin.mjs tsc -p packages/renderer/tsconfig.json --noEmit
```

The visual check should include neutral, wave and cheer frames at the same
viewport and a pointer drag after zooming the mascot.
