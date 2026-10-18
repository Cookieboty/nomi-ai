import fs from 'node:fs';

const scenePath = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(scenePath, 'utf8').replace(/\r\n/g, '\n');

const actions = [
  'fist_pump',
  'typing',
  'bow',
  'salute',
  'prayer',
  'ok',
  'explain',
  'eureka',
  'puzzled',
  'look_around',
  'look_lr',
  'peek',
  'heart',
  'blow_kiss',
  'shy',
  'apology',
  'surprise',
  'inhale',
  'smug',
  'aggrieved',
  'tears',
  'angry',
  'cold_sweat',
  'daze',
  'thumbs_up',
  'peace',
  'hop',
  'blink',
  'tongue',
  'yawn',
  'stretch',
];
const propertyStart = 260;
const animationStart = 300;
const stateStart = 400;
const ease = '                        <CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>';
const frameLines = (values) =>
  values
    .map(
      ([frame, value]) =>
        `                    <KeyFrameDouble value="${value}" frame="${frame}" interpolationType="cubic">\n${ease}\n                    </KeyFrameDouble>`,
    )
    .join('\n');
const track = (objectId, property, values) =>
  `            <KeyedObject objectId="0:${objectId}">\n                <KeyedProperty property="${property}">\n${frameLines(values)}\n                </KeyedProperty>\n            </KeyedObject>`;
const oscillate = (objectId, property, amount, duration = 72) =>
  track(objectId, property, [
    [0, 0],
    [18, amount],
    [36, -amount * 0.7],
    [54, amount * 0.35],
    [duration, 0],
  ]);
const pulse = (objectId, property, amount, duration = 72) =>
  track(objectId, property, [
    [0, 1],
    [18, amount],
    [38, amount * 0.5 + 0.5],
    [54, 1],
    [duration, 1],
  ]);
const clipTracks = (name) => {
  switch (name) {
    case 'fist_pump':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.38],
          [36, 0.62],
          [54, 0.34],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.16],
          [36, 0.32],
          [54, 0.12],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.22],
          [54, -0.12],
          [72, 0],
        ]),
        track(190, 'y', [
          [0, 0],
          [36, -8],
          [54, 0],
          [72, 0],
        ]),
      ];
    case 'typing':
      return [
        track(9215, 'rotation', [
          [0, 0],
          [18, 0.32],
          [36, -0.24],
          [54, 0.28],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, -0.32],
          [36, 0.24],
          [54, -0.28],
          [72, 0],
        ]),
        track(9217, 'rotation', [
          [0, 0],
          [18, -0.18],
          [36, 0.16],
          [54, -0.14],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [18, 0.18],
          [36, -0.16],
          [54, 0.14],
          [72, 0],
        ]),
        track(190, 'rotation', [
          [0, 0],
          [18, -0.025],
          [36, 0.02],
          [54, -0.018],
          [72, 0],
        ]),
      ];
    case 'bow':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.12],
          [36, 0.22],
          [54, 0.16],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, 0.08],
          [36, 0.16],
          [54, 0.1],
          [72, 0],
        ]),
        track(9211, 'rotation', [
          [0, 0],
          [18, 0.06],
          [36, 0.1],
          [54, 0.05],
          [72, 0],
        ]),
        track(190, 'y', [
          [0, 0],
          [36, 10],
          [54, 4],
          [72, 0],
        ]),
      ];
    case 'salute':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.44],
          [36, 0.72],
          [54, 0.48],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.16],
          [36, 0.32],
          [54, 0.18],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.2],
          [54, -0.1],
          [72, 0],
        ]),
      ];
    case 'prayer':
      return [
        track(9213, 'rotation', [
          [0, 0],
          [18, -0.42],
          [36, -0.72],
          [54, -0.44],
          [72, 0],
        ]),
        track(9215, 'rotation', [
          [0, 0],
          [18, -0.16],
          [36, -0.3],
          [54, -0.18],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.42],
          [36, 0.72],
          [54, 0.44],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.16],
          [36, 0.3],
          [54, 0.18],
          [72, 0],
        ]),
        track(9217, 'rotation', [
          [0, 0],
          [36, -0.12],
          [54, 0.08],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, 0.12],
          [54, -0.08],
          [72, 0],
        ]),
      ];
    case 'ok':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.26],
          [36, 0.46],
          [54, 0.25],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.1],
          [36, 0.2],
          [54, 0.08],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.18],
          [54, -0.1],
          [72, 0],
        ]),
        track(9248, 'rotation', [
          [0, 0],
          [36, -0.25],
          [54, -0.12],
          [72, 0],
        ]),
        track(9249, 'rotation', [
          [0, 0],
          [36, 0.18],
          [54, 0.08],
          [72, 0],
        ]),
      ];
    case 'explain':
      return [
        track(9217, 'rotation', [
          [0, 0],
          [18, -0.12],
          [36, 0.18],
          [54, -0.1],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [18, 0.12],
          [36, -0.18],
          [54, 0.1],
          [72, 0],
        ]),
        track(9244, 'rotation', [
          [0, 0],
          [36, -0.12],
          [54, 0.06],
          [72, 0],
        ]),
        track(9249, 'rotation', [
          [0, 0],
          [36, 0.12],
          [54, -0.06],
          [72, 0],
        ]),
        track(190, 'rotation', [
          [0, 0],
          [18, -0.025],
          [36, 0.035],
          [54, -0.02],
          [72, 0],
        ]),
      ];
    case 'eureka':
      return [
        track(9213, 'rotation', [
          [0, 0],
          [18, -0.28],
          [36, -0.4],
          [54, -0.3],
          [72, 0],
        ]),
        track(9215, 'rotation', [
          [0, 0],
          [18, -0.1],
          [36, -0.16],
          [54, -0.12],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.28],
          [36, 0.4],
          [54, 0.3],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.1],
          [36, 0.16],
          [54, 0.12],
          [72, 0],
        ]),
        pulse(190, 'scaleY', 1.025),
      ];
    case 'puzzled':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.14],
          [36, 0.22],
          [54, 0.1],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, -0.1],
          [36, -0.18],
          [54, -0.08],
          [72, 0],
        ]),
        track(9267, 'rotation', [
          [0, 0],
          [36, -0.1],
          [54, -0.04],
          [72, 0],
        ]),
      ];
    case 'look_around':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.2],
          [36, 0.2],
          [54, -0.16],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, -0.1],
          [36, 0.1],
          [54, -0.08],
          [72, 0],
        ]),
      ];
    case 'look_lr':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.24],
          [36, 0.24],
          [54, -0.18],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, -0.12],
          [36, 0.12],
          [54, -0.08],
          [72, 0],
        ]),
      ];
    case 'peek':
      return [
        track(190, 'x', [
          [0, 0],
          [18, -14],
          [36, -18],
          [54, -8],
          [72, 0],
        ]),
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.12],
          [36, -0.18],
          [54, -0.08],
          [72, 0],
        ]),
      ];
    case 'heart':
      return [
        track(9213, 'rotation', [
          [0, 0],
          [18, -0.44],
          [36, -0.7],
          [54, -0.42],
          [72, 0],
        ]),
        track(9215, 'rotation', [
          [0, 0],
          [18, -0.14],
          [36, -0.26],
          [54, -0.16],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.44],
          [36, 0.7],
          [54, 0.42],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.14],
          [36, 0.26],
          [54, 0.16],
          [72, 0],
        ]),
        track(9217, 'rotation', [
          [0, 0],
          [36, -0.14],
          [54, 0.08],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, 0.14],
          [54, -0.08],
          [72, 0],
        ]),
      ];
    case 'blow_kiss':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.36],
          [36, 0.58],
          [54, 0.34],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.16],
          [36, 0.32],
          [54, 0.14],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.28],
          [54, -0.16],
          [72, 0],
        ]),
        track(9230, 'rotation', [
          [0, 0],
          [36, -0.1],
          [54, -0.05],
          [72, 0],
        ]),
      ];
    case 'shy':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.14],
          [36, -0.22],
          [54, -0.1],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, -0.08],
          [36, -0.14],
          [54, -0.06],
          [72, 0],
        ]),
        track(9213, 'rotation', [
          [0, 0],
          [36, 0.18],
          [54, 0.1],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [36, -0.18],
          [54, -0.1],
          [72, 0],
        ]),
        pulse(190, 'scaleX', 0.985),
      ];
    case 'apology':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.1],
          [36, 0.16],
          [54, 0.08],
          [72, 0],
        ]),
        track(9211, 'rotation', [
          [0, 0],
          [18, 0.05],
          [36, 0.08],
          [54, 0.04],
          [72, 0],
        ]),
        track(190, 'y', [
          [0, 0],
          [36, 8],
          [54, 4],
          [72, 0],
        ]),
      ];
    case 'surprise':
      return [
        track(9213, 'rotation', [
          [0, 0],
          [18, -0.22],
          [36, -0.36],
          [54, -0.18],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.22],
          [36, 0.36],
          [54, 0.18],
          [72, 0],
        ]),
        pulse(190, 'scaleY', 1.03),
        track(9230, 'rotation', [
          [0, 0],
          [36, -0.08],
          [54, 0],
          [72, 0],
        ]),
      ];
    case 'inhale':
      return [
        track(190, 'scaleY', [
          [0, 1],
          [20, 1.02],
          [36, 1.035],
          [54, 1.012],
          [72, 1],
        ]),
        track(9213, 'rotation', [
          [0, 0],
          [36, -0.16],
          [54, 0],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [36, 0.16],
          [54, 0],
          [72, 0],
        ]),
      ];
    case 'smug':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.08],
          [36, -0.14],
          [54, -0.06],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, -0.05],
          [36, -0.1],
          [54, -0.04],
          [72, 0],
        ]),
        track(190, 'rotation', [
          [0, 0],
          [36, -0.04],
          [54, -0.02],
          [72, 0],
        ]),
      ];
    case 'aggrieved':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [12, -0.18],
          [24, 0.18],
          [36, -0.14],
          [48, 0.12],
          [72, 0],
        ]),
        track(9213, 'rotation', [
          [0, 0],
          [24, 0.18],
          [48, -0.14],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [24, -0.18],
          [48, 0.14],
          [72, 0],
        ]),
      ];
    case 'tears':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.1],
          [36, 0.16],
          [54, 0.08],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, 0.05],
          [36, 0.1],
          [54, 0.04],
          [72, 0],
        ]),
        track(190, 'scaleY', [
          [0, 1],
          [30, 0.99],
          [54, 1.012],
          [72, 1],
        ]),
      ];
    case 'angry':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [12, -0.14],
          [24, 0.12],
          [36, -0.1],
          [48, 0.08],
          [72, 0],
        ]),
        track(9211, 'rotation', [
          [0, 0],
          [18, -0.04],
          [36, 0.04],
          [54, -0.03],
          [72, 0],
        ]),
        track(9213, 'rotation', [
          [0, 0],
          [24, -0.2],
          [48, 0.16],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [24, 0.2],
          [48, -0.16],
          [72, 0],
        ]),
      ];
    case 'cold_sweat':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.16],
          [36, -0.16],
          [54, 0.12],
          [72, 0],
        ]),
        track(190, 'rotation', [
          [0, 0],
          [18, 0.03],
          [36, -0.03],
          [54, 0.02],
          [72, 0],
        ]),
        track(190, 'scaleY', [
          [0, 1],
          [36, 1.015],
          [54, 1],
          [72, 1],
        ]),
      ];
    case 'daze':
      return [
        track(9230, 'rotation', [
          [0, 0],
          [18, 0.2],
          [36, -0.2],
          [54, 0.14],
          [72, 0],
        ]),
        track(9212, 'rotation', [
          [0, 0],
          [18, 0.1],
          [36, -0.1],
          [54, 0.08],
          [72, 0],
        ]),
        track(190, 'rotation', [
          [0, 0],
          [18, 0.03],
          [36, -0.03],
          [54, 0.02],
          [72, 0],
        ]),
      ];
    case 'thumbs_up':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.3],
          [36, 0.5],
          [54, 0.28],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.12],
          [36, 0.24],
          [54, 0.1],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.2],
          [54, -0.1],
          [72, 0],
        ]),
        track(9248, 'rotation', [
          [0, 0],
          [36, -0.3],
          [54, -0.14],
          [72, 0],
        ]),
      ];
    case 'peace':
      return [
        track(9219, 'rotation', [
          [0, 0],
          [18, 0.34],
          [36, 0.56],
          [54, 0.32],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [18, 0.14],
          [36, 0.3],
          [54, 0.12],
          [72, 0],
        ]),
        track(9223, 'rotation', [
          [0, 0],
          [36, -0.22],
          [54, -0.12],
          [72, 0],
        ]),
        track(9249, 'rotation', [
          [0, 0],
          [36, -0.26],
          [54, -0.12],
          [72, 0],
        ]),
        track(9250, 'rotation', [
          [0, 0],
          [36, -0.22],
          [54, -0.1],
          [72, 0],
        ]),
      ];
    case 'hop':
      return [
        track(190, 'y', [
          [0, 0],
          [18, -18],
          [36, 0],
          [54, -10],
          [72, 0],
        ]),
        track(190, 'scaleY', [
          [0, 1],
          [18, 1.035],
          [36, 0.995],
          [54, 1.025],
          [72, 1],
        ]),
        track(9211, 'rotation', [
          [0, 0],
          [18, -0.03],
          [36, 0.02],
          [54, -0.02],
          [72, 0],
        ]),
      ];
    case 'blink':
      return [
        track(9212, 'scaleY', [
          [0, 1],
          [18, 0.08],
          [28, 1],
          [72, 1],
        ]),
      ];
    case 'tongue':
      return [
        track(9212, 'rotation', [
          [0, 0],
          [18, 0.08],
          [36, 0.14],
          [54, 0.06],
          [72, 0],
        ]),
        track(9230, 'rotation', [
          [0, 0],
          [18, -0.06],
          [36, -0.1],
          [54, -0.04],
          [72, 0],
        ]),
      ];
    case 'yawn':
      return [
        track(190, 'scaleY', [
          [0, 1],
          [24, 1.02],
          [48, 1.04],
          [66, 1.01],
          [72, 1],
        ]),
        track(9230, 'rotation', [
          [0, 0],
          [24, 0.08],
          [48, 0.14],
          [66, 0.05],
          [72, 0],
        ]),
        track(9213, 'rotation', [
          [0, 0],
          [36, -0.26],
          [54, 0],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [36, 0.26],
          [54, 0],
          [72, 0],
        ]),
      ];
    case 'stretch':
      return [
        track(9213, 'rotation', [
          [0, 0],
          [20, -0.18],
          [40, -0.25],
          [60, -0.16],
          [72, 0],
        ]),
        track(9219, 'rotation', [
          [0, 0],
          [20, 0.18],
          [40, 0.25],
          [60, 0.16],
          [72, 0],
        ]),
        track(9215, 'rotation', [
          [0, 0],
          [20, -0.08],
          [40, -0.12],
          [60, -0.07],
          [72, 0],
        ]),
        track(9221, 'rotation', [
          [0, 0],
          [20, 0.08],
          [40, 0.12],
          [60, 0.07],
          [72, 0],
        ]),
        track(190, 'scaleY', [
          [0, 1],
          [40, 1.018],
          [60, 1.008],
          [72, 1],
        ]),
      ];
    default:
      return [oscillate(9230, 'rotation', 0.05)];
  }
};
const animations = actions
  .map(
    (name, index) =>
      `        <LinearAnimation name="full.${name}" loopValue="oneShot" duration="72" fps="60" id="0:${animationStart + index}">\n${clipTracks(name).join('\n')}\n        </LinearAnimation>`,
  )
  .join('\n');

if (!scene.includes('ViewModelPropertyTrigger name="fist_pump"')) {
  const vmAnchor = '        <ViewModelPropertyTrigger name="smile" id="0:250"/>\n';
  const vmTriggers =
    actions
      .map(
        (name, index) =>
          `        <ViewModelPropertyTrigger name="${name}" id="0:${propertyStart + index}"/>`,
      )
      .join('\n') + '\n';
  scene = scene.replace(vmAnchor, vmAnchor + vmTriggers);
  const instanceAnchor = '            <ViewModelInstanceTrigger viewModelPropertyId="0:250"/>\n';
  const instanceTriggers =
    actions
      .map(
        (_, index) =>
          `            <ViewModelInstanceTrigger viewModelPropertyId="0:${propertyStart + index}"/>`,
      )
      .join('\n') + '\n';
  scene = scene.replace(instanceAnchor, instanceAnchor + instanceTriggers);

  const transition = actions
    .map(
      (name, index) =>
        `                    <StateTransition stateToId="0:${stateStart + index}" duration="12">\n                        <TransitionViewModelCondition>\n                            <TransitionPropertyViewModelComparator>\n                                <BindablePropertyTrigger>\n                                    <DataBindContext sourcePathIds="0:9100-0:${propertyStart + index}" propertyKey="686"/>\n                                </BindablePropertyTrigger>\n                            </TransitionPropertyViewModelComparator>\n                            <TransitionValueTriggerComparator/>\n                        </TransitionViewModelCondition>\n                    </StateTransition>`,
    )
    .join('\n');
  const transitionAnchor =
    '                </AnimationState>\n                <AnimationState x="520" y="-160" animationId="0:196" id="0:223">';
  if (!scene.includes(transitionAnchor)) throw new Error('action transition anchor not found');
  scene = scene.replace(transitionAnchor, `${transition}\n${transitionAnchor}`);

  const states = actions
    .map(
      (name, index) =>
        `                <AnimationState x="720" y="${index * 60}" animationId="0:${animationStart + index}" id="0:${stateStart + index}">\n                    <StateTransition stateToId="0:222" duration="18" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>\n                </AnimationState>`,
    )
    .join('\n');
  const stateAnchor =
    '                <AnimationState x="520" y="940" animationId="0:234" id="0:240">\n                    <StateTransition stateToId="0:222" duration="18" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>\n                </AnimationState>\n';
  if (!scene.includes(stateAnchor)) throw new Error('action state anchor not found');
  scene = scene.replace(stateAnchor, stateAnchor + states + '\n');
  const animationAnchor = '        <LinearAnimation name="full.smile"';
  const animationIndex = scene.indexOf(animationAnchor);
  const stateMachineIndex = scene.indexOf('        <StateMachine name="NomiFull"');
  if (animationIndex < 0 || stateMachineIndex < 0)
    throw new Error('animation insertion anchor not found');
  scene = scene.slice(0, stateMachineIndex) + animations + '\n' + scene.slice(stateMachineIndex);
  fs.writeFileSync(scenePath, scene);
}

// Re-running this script after the first expansion refreshes the authored
// animation blocks in place.  This keeps the action library editable instead
// of leaving stale, tiny placeholder motions in scene.rml.
if (scene.includes('ViewModelPropertyTrigger name="fist_pump"')) {
  for (const [index, name] of actions.entries()) {
    const replacement = `        <LinearAnimation name="full.${name}" loopValue="oneShot" duration="72" fps="60" id="0:${animationStart + index}">\n${clipTracks(name).join('\n')}\n        </LinearAnimation>`;
    const re = new RegExp(
      `        <LinearAnimation name="full\\.${name}"[\\s\\S]*?        </LinearAnimation>`,
    );
    if (!re.test(scene)) throw new Error(`expanded animation not found: ${name}`);
    scene = scene.replace(re, replacement);
  }
  fs.writeFileSync(scenePath, scene);
}
