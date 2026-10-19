import fs from 'node:fs';

const path = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(path, 'utf8');

const ease = '                        <CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>';
const frames = (values) =>
  values
    .map(
      ([frame, value]) =>
        `                    <KeyFrameDouble value="${value}" frame="${frame}" interpolationType="cubic">\n${ease}\n                    </KeyFrameDouble>`,
    )
    .join('\n');
const track = (objectId, property, values) =>
  `            <KeyedObject objectId="0:${objectId}">\n                <KeyedProperty property="${property}">\n${frames(values)}\n                </KeyedProperty>\n            </KeyedObject>`;
const idFrames = (values) =>
  values
    .map(
      ([frame, value]) =>
        `                    <KeyFrameId value="${value}" frame="${frame}" interpolationType="hold"/>`,
    )
    .join('\n');
const idTrack = (objectId, property, values) =>
  `            <KeyedObject objectId="0:${objectId}">\n                <KeyedProperty property="${property}">\n${idFrames(values)}\n                </KeyedProperty>\n            </KeyedObject>`;

const anim = (name, id, duration, tracks) =>
  `        <LinearAnimation name="full.${name}" loopValue="oneShot" duration="${duration}" fps="60" id="0:${id}">\n${tracks.join('\n')}\n        </LinearAnimation>`;

const clips = {
  // The sleeve and cuff bones inherit the arm chain.  They are intentionally
  // left unkeyed here: a second rotation on a raster sleeve is what produced
  // the black slivers and detached cuffs in the earlier build.
  // ROUND5: raised side-wave toward the viewer (canvas wave intent).
  // Relative deltas on arm-r (character left / screen right): NEGATIVE lifts the
  // arm outward/up so the hand reaches head height with a bent elbow; wrist
  // oscillates palm-toward-camera. Previous +0.26/+0.55 read as a dangling sway.
  wave: anim('wave', 196, 108, [
    idTrack(9821, 'activeComponentId', [
      [0, '0:9823'],
      [108, '0:9823'],
    ]),
    // upper: modest outward lift (stump/collar stay covering the socket)
    track(9219, 'rotation', [
      [0, 0],
      [10, -0.28],
      [22, -0.48],
      [32, -0.58],
      [42, -0.54],
      [52, -0.62],
      [62, -0.56],
      [72, -0.6],
      [84, -0.32],
      [98, -0.08],
      [108, 0],
    ]),
    // forearm: deep bend so hand still reaches cheek/head height
    track(9221, 'rotation', [
      [0, 0],
      [10, -0.85],
      [22, -1.55],
      [32, -2.0],
      [42, -1.8],
      [52, -2.1],
      [62, -1.85],
      [72, -2.05],
      [84, -1.05],
      [98, -0.28],
      [108, 0],
    ]),
    // wrist: palm-facing osc while arm is raised (visible wave amplitude)
    track(9223, 'rotation', [
      [0, 0],
      [22, 0.45],
      [32, 0.7],
      [42, -0.6],
      [52, 0.75],
      [62, -0.65],
      [72, 0.55],
      [84, 0.2],
      [98, 0],
      [108, 0],
    ]),
    // soft head tip toward the waving side
    track(190, 'y', [
      [0, 0],
      [28, -4],
      [72, -3],
      [100, 0],
      [108, 0],
    ]),
  ]),
  cheer: anim('cheer', 197, 96, [
    track(9213, 'rotation', [
      [0, 0],
      [16, -0.35],
      [36, -0.65],
      [56, -0.5],
      [78, -0.2],
      [96, 0],
    ]),
    track(9215, 'rotation', [
      [0, 0],
      [16, -0.55],
      [36, -0.9],
      [56, -0.7],
      [78, -0.3],
      [96, 0],
    ]),
    track(9219, 'rotation', [
      [0, 0],
      [16, 0.35],
      [36, 0.65],
      [56, 0.5],
      [78, 0.2],
      [96, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [16, 0.55],
      [36, 0.9],
      [56, 0.7],
      [78, 0.3],
      [96, 0],
    ]),
    track(190, 'y', [
      [0, 0],
      [36, -10],
      [56, -4],
      [78, 0],
      [96, 0],
    ]),
  ]),
  hello: anim('hello', 198, 96, [
    track(9219, 'rotation', [
      [0, 0],
      [16, 0.3],
      [32, 0.64],
      [48, 0.54],
      [70, 0.22],
      [88, 0],
      [96, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [16, 0.08],
      [32, 0.28],
      [48, 0.18],
      [70, 0.08],
      [88, 0],
      [96, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [32, -0.2],
      [48, 0.18],
      [64, -0.16],
      [82, 0],
      [96, 0],
    ]),
    track(9248, 'rotation', [
      [0, 0],
      [32, -0.18],
      [48, 0.12],
      [64, -0.18],
      [82, 0],
      [96, 0],
    ]),
    track(9249, 'rotation', [
      [0, 0],
      [32, 0.14],
      [48, -0.1],
      [64, 0.14],
      [82, 0],
      [96, 0],
    ]),
    track(9250, 'rotation', [
      [0, 0],
      [32, 0.18],
      [48, -0.14],
      [64, 0.18],
      [82, 0],
      [96, 0],
    ]),
  ]),
  celebrate: anim('celebrate', 199, 120, [
    track(9213, 'rotation', [
      [0, 0],
      [20, -0.38],
      [44, -0.72],
      [68, -0.58],
      [96, 0],
      [120, 0],
    ]),
    track(9215, 'rotation', [
      [0, 0],
      [20, -0.12],
      [44, -0.3],
      [68, -0.18],
      [96, 0],
      [120, 0],
    ]),
    track(9219, 'rotation', [
      [0, 0],
      [20, 0.38],
      [44, 0.72],
      [68, 0.58],
      [96, 0],
      [120, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [20, 0.12],
      [44, 0.3],
      [68, 0.18],
      [96, 0],
      [120, 0],
    ]),
    track(9217, 'rotation', [
      [0, 0],
      [44, -0.18],
      [68, 0.16],
      [96, 0],
      [120, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [44, 0.18],
      [68, -0.16],
      [96, 0],
      [120, 0],
    ]),
    track(190, 'y', [
      [0, 0],
      [44, -12],
      [68, -7],
      [96, 0],
      [120, 0],
    ]),
    track(190, 'scaleY', [
      [0, 1],
      [44, 1.025],
      [68, 1.01],
      [96, 1],
      [120, 1],
    ]),
  ]),
  nod: anim('nod', 200, 72, [
    track(9230, 'rotation', [
      [0, 0],
      [14, 0.1],
      [28, -0.08],
      [42, 0.06],
      [58, 0],
      [72, 0],
    ]),
    track(9212, 'rotation', [
      [0, 0],
      [14, 0.06],
      [28, -0.05],
      [42, 0.04],
      [58, 0],
      [72, 0],
    ]),
    track(9211, 'rotation', [
      [0, 0],
      [18, 0.025],
      [36, -0.02],
      [54, 0.015],
      [72, 0],
    ]),
    track(190, 'scaleY', [
      [0, 1],
      [18, 0.995],
      [36, 1.008],
      [54, 0.998],
      [72, 1],
    ]),
  ]),
  flinch: anim('flinch', 201, 84, [
    track(9213, 'rotation', [
      [0, 0],
      [14, -0.3],
      [30, -0.62],
      [48, -0.4],
      [68, 0],
      [84, 0],
    ]),
    track(9215, 'rotation', [
      [0, 0],
      [14, 0.3],
      [30, 0.68],
      [48, 0.42],
      [68, 0],
      [84, 0],
    ]),
    track(9219, 'rotation', [
      [0, 0],
      [14, 0.3],
      [30, 0.62],
      [48, 0.4],
      [68, 0],
      [84, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [14, -0.3],
      [30, -0.68],
      [48, -0.42],
      [68, 0],
      [84, 0],
    ]),
    track(9217, 'rotation', [
      [0, 0],
      [30, 0.22],
      [48, -0.12],
      [68, 0],
      [84, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [30, -0.22],
      [48, 0.12],
      [68, 0],
      [84, 0],
    ]),
    track(190, 'scaleX', [
      [0, 1],
      [14, 0.978],
      [30, 0.99],
      [48, 1],
      [84, 1],
    ]),
    track(190, 'scaleY', [
      [0, 1],
      [14, 1.02],
      [30, 1.012],
      [48, 1],
      [84, 1],
    ]),
  ]),
  poke: anim('poke', 202, 78, [
    track(9219, 'rotation', [
      [0, 0],
      [14, 0.18],
      [30, 0.38],
      [46, 0.28],
      [62, 0],
      [78, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [14, -0.18],
      [30, -0.62],
      [46, -0.42],
      [62, 0],
      [78, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [30, -0.24],
      [46, -0.34],
      [62, 0],
      [78, 0],
    ]),
    track(9249, 'rotation', [
      [0, 0],
      [30, -0.34],
      [46, -0.22],
      [62, 0],
      [78, 0],
    ]),
    track(190, 'x', [
      [0, 0],
      [30, -6],
      [46, 3],
      [62, 0],
      [78, 0],
    ]),
  ]),
  shake: anim('shake', 203, 72, [
    track(9230, 'rotation', [
      [0, 0],
      [10, -0.16],
      [20, 0.16],
      [30, -0.14],
      [40, 0.12],
      [54, 0],
      [72, 0],
    ]),
    track(9212, 'rotation', [
      [0, 0],
      [10, -0.08],
      [20, 0.08],
      [30, -0.07],
      [40, 0.06],
      [54, 0],
      [72, 0],
    ]),
    track(9211, 'rotation', [
      [0, 0],
      [12, -0.025],
      [24, 0.025],
      [36, -0.02],
      [48, 0.015],
      [72, 0],
    ]),
  ]),
  clap: anim('clap', 204, 96, [
    // ROUND3: less arm.rig chest pull (reduces jacket tear); Solo bent sleeves at peak.
    // hang Solo children: 0:9822 / 0:9823; bent: 0:9824 / 0:9825.
    // ROUND3: keep hang continuous sleeve (bent Solo child reserved; warp art still tears).
    idTrack(9820, 'activeComponentId', [
      [0, '0:9822'],
      [96, '0:9822'],
    ]),
    idTrack(9821, 'activeComponentId', [
      [0, '0:9823'],
      [96, '0:9823'],
    ]),
    // ROUND4: further cut arm.rig chest pull; orange collar is torso-static.
    track(9378, 'x', [
      [0, 317.8],
      [28, 326],
      [40, 325],
      [52, 326],
      [82, 317.8],
      [96, 317.8],
    ]),
    track(9379, 'x', [
      [0, 642.8],
      [28, 634],
      [40, 635],
      [52, 634],
      [82, 642.8],
      [96, 642.8],
    ]),
    track(9213, 'rotation', [
      [0, 0],
      [28, -0.55],
      [52, -0.55],
      [96, 0],
    ]),
    track(9215, 'rotation', [
      [0, 0],
      [14, -0.55],
      [28, -1.05],
      [40, -0.88],
      [52, -1.05],
      [66, -0.55],
      [82, 0],
      [96, 0],
    ]),
    track(9219, 'rotation', [
      [0, 0],
      [28, 0.58],
      [52, 0.58],
      [96, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [14, 0.55],
      [28, 1.08],
      [40, 0.9],
      [52, 1.08],
      [66, 0.55],
      [82, 0],
      [96, 0],
    ]),
    track(9217, 'rotation', [
      [0, 0],
      [28, 0.55],
      [52, 0.55],
      [96, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [28, -0.55],
      [52, -0.55],
      [96, 0],
    ]),
    track(9243, 'rotation', [
      [0, 0],
      [28, 0.35],
      [52, 0.35],
      [96, 0],
    ]),
    track(9248, 'rotation', [
      [0, 0],
      [28, -0.35],
      [52, -0.35],
      [96, 0],
    ]),
  ]),
  think: anim('think', 205, 90, [
    track(9219, 'rotation', [
      [0, 0],
      [18, 0.3],
      [38, 0.6],
      [58, 0.42],
      [76, 0],
      [90, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [18, 0.18],
      [38, -0.18],
      [58, -0.05],
      [76, 0],
      [90, 0],
    ]),
    track(9223, 'rotation', [
      [0, 0],
      [38, -0.2],
      [58, -0.12],
      [76, 0],
      [90, 0],
    ]),
    track(9230, 'rotation', [
      [0, 0],
      [38, -0.08],
      [58, -0.04],
      [76, 0],
      [90, 0],
    ]),
    track(9211, 'rotation', [
      [0, 0],
      [38, -0.03],
      [58, -0.02],
      [90, 0],
    ]),
  ]),
  work: anim('work', 206, 90, [
    track(9213, 'rotation', [
      [0, 0],
      [18, -0.24],
      [36, 0.16],
      [54, -0.2],
      [72, 0.12],
      [90, 0],
    ]),
    track(9215, 'rotation', [
      [0, 0],
      [18, 0.38],
      [36, -0.25],
      [54, 0.32],
      [72, -0.2],
      [90, 0],
    ]),
    track(9219, 'rotation', [
      [0, 0],
      [18, 0.24],
      [36, -0.16],
      [54, 0.2],
      [72, -0.12],
      [90, 0],
    ]),
    track(9221, 'rotation', [
      [0, 0],
      [18, -0.38],
      [36, 0.25],
      [54, -0.32],
      [72, 0.2],
      [90, 0],
    ]),
    track(9211, 'rotation', [
      [0, 0],
      [22, -0.025],
      [44, 0.02],
      [66, -0.018],
      [90, 0],
    ]),
  ]),
};

for (const [name, replacement] of Object.entries(clips)) {
  const re = new RegExp(
    '[ \t]*<LinearAnimation name="full\\.' + name + '"[\\s\\S]*?<\\/LinearAnimation>',
  );
  if (!re.test(scene)) throw new Error('animation not found: ' + name);
  scene = scene.replace(re, replacement.trimEnd());
}

fs.writeFileSync(path, scene);
