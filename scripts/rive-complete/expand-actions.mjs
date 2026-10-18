import fs from 'node:fs';

const scenePath = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(scenePath, 'utf8').replace(/\r\n/g, '\n');

const actions = [
  'fist_pump', 'typing', 'bow', 'salute', 'prayer', 'ok', 'explain', 'eureka',
  'puzzled', 'look_around', 'look_lr', 'peek', 'heart', 'blow_kiss', 'shy',
  'apology', 'surprise', 'inhale', 'smug', 'aggrieved', 'tears', 'angry',
  'cold_sweat', 'daze', 'thumbs_up', 'peace', 'hop', 'blink', 'tongue', 'yawn',
  'stretch',
];
const propertyStart = 260;
const animationStart = 300;
const stateStart = 400;
const ease = '                        <CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>';
const frameLines = (values) => values.map(([frame, value]) =>
  `                    <KeyFrameDouble value="${value}" frame="${frame}" interpolationType="cubic">\n${ease}\n                    </KeyFrameDouble>`
).join('\n');
const track = (objectId, property, values) =>
  `            <KeyedObject objectId="0:${objectId}">\n                <KeyedProperty property="${property}">\n${frameLines(values)}\n                </KeyedProperty>\n            </KeyedObject>`;
const oscillate = (objectId, property, amount, duration = 72) => track(objectId, property, [[0, 0], [18, amount], [36, -amount * 0.7], [54, amount * 0.35], [duration, 0]]);
const pulse = (objectId, property, amount, duration = 72) => track(objectId, property, [[0, 1], [18, amount], [38, amount * 0.5 + 0.5], [54, 1], [duration, 1]]);
const clipTracks = (name) => {
  switch (name) {
    case 'fist_pump': return [track(9219, 'rotation', [[0, 0], [18, 0.12], [36, 0.24], [54, 0.12], [72, 0]]), track(9221, 'rotation', [[0, 0], [18, -0.12], [36, -0.2], [54, -0.08], [72, 0]]), track(9223, 'rotation', [[0, 0], [36, 0.16], [54, 0.08], [72, 0]])];
    case 'typing': return [oscillate(9215, 'rotation', 0.15), oscillate(9221, 'rotation', -0.15), oscillate(9217, 'rotation', 0.06), oscillate(9223, 'rotation', -0.06), oscillate(190, 'rotation', 0.012)];
    case 'bow': return [oscillate(9230, 'rotation', 0.12), oscillate(9212, 'rotation', 0.07), oscillate(9211, 'rotation', 0.05)];
    case 'salute': return [track(9219, 'rotation', [[0, 0], [20, 0.12], [38, 0.2], [56, 0.1], [72, 0]]), track(9221, 'rotation', [[0, 0], [20, 0.08], [38, 0.16], [56, 0.08], [72, 0]]), oscillate(9223, 'rotation', 0.1)];
    case 'prayer': return [track(9213, 'rotation', [[0, 0], [22, -0.12], [40, -0.2], [58, -0.1], [72, 0]]), track(9219, 'rotation', [[0, 0], [22, 0.12], [40, 0.2], [58, 0.1], [72, 0]]), oscillate(9217, 'rotation', -0.08), oscillate(9223, 'rotation', 0.08)];
    case 'ok': return [oscillate(9223, 'rotation', 0.16), oscillate(9248, 'rotation', 0.12), oscillate(9249, 'rotation', -0.16)];
    case 'explain': return [oscillate(9213, 'rotation', 0.12), oscillate(9219, 'rotation', -0.12), oscillate(9217, 'rotation', 0.08), oscillate(9223, 'rotation', -0.08)];
    case 'eureka': return [oscillate(9213, 'rotation', -0.16), oscillate(9219, 'rotation', 0.16), pulse(190, 'scaleY', 1.025)];
    case 'puzzled': return [oscillate(9230, 'rotation', 0.16), oscillate(9212, 'rotation', -0.08)];
    case 'look_around': return [oscillate(9230, 'rotation', 0.2), oscillate(9212, 'rotation', 0.08)];
    case 'look_lr': return [track(9230, 'rotation', [[0, 0], [18, -0.16], [36, 0.16], [54, -0.12], [72, 0]]), track(9212, 'rotation', [[0, 0], [18, -0.08], [36, 0.08], [54, -0.06], [72, 0]])];
    case 'peek': return [oscillate(190, 'x', -8), oscillate(9230, 'rotation', -0.1)];
    case 'heart': return [track(9213, 'rotation', [[0, 0], [18, -0.12], [36, -0.2], [54, -0.1], [72, 0]]), track(9219, 'rotation', [[0, 0], [18, 0.12], [36, 0.2], [54, 0.1], [72, 0]]), oscillate(9217, 'rotation', -0.08), oscillate(9223, 'rotation', 0.08)];
    case 'blow_kiss': return [oscillate(9230, 'rotation', -0.08), oscillate(9223, 'rotation', 0.12), oscillate(9219, 'rotation', 0.1)];
    case 'shy': return [oscillate(9230, 'rotation', -0.12), oscillate(9212, 'rotation', -0.05), pulse(190, 'scaleX', 0.985)];
    case 'apology': return [oscillate(9230, 'rotation', 0.09), oscillate(9212, 'rotation', 0.05)];
    case 'surprise': return [pulse(190, 'scaleY', 1.025), oscillate(9230, 'rotation', -0.06)];
    case 'inhale': return [track(190, 'scaleY', [[0, 1], [28, 1.025], [54, 1.012], [72, 1]])];
    case 'smug': return [oscillate(9230, 'rotation', -0.07), oscillate(190, 'rotation', -0.035)];
    case 'aggrieved': return [track(9230, 'rotation', [[0, 0], [12, -0.12], [24, 0.12], [36, -0.1], [48, 0.08], [72, 0]])];
    case 'tears': return [oscillate(9230, 'rotation', 0.08), track(190, 'scaleY', [[0, 1], [30, 0.99], [54, 1.012], [72, 1]])];
    case 'angry': return [oscillate(9230, 'rotation', -0.1), oscillate(9212, 'rotation', -0.06), oscillate(190, 'rotation', -0.022)];
    case 'cold_sweat': return [oscillate(9230, 'rotation', 0.12), oscillate(190, 'rotation', 0.018)];
    case 'daze': return [oscillate(9230, 'rotation', 0.15), oscillate(9212, 'rotation', 0.08), oscillate(190, 'rotation', 0.018)];
    case 'thumbs_up': return [oscillate(9223, 'rotation', 0.14), oscillate(9248, 'rotation', 0.18)];
    case 'peace': return [oscillate(9223, 'rotation', -0.12), oscillate(9249, 'rotation', 0.12), oscillate(9250, 'rotation', 0.14)];
    case 'hop': return [track(190, 'y', [[0, 0], [18, -12], [36, 0], [54, -7], [72, 0]]), track(190, 'scaleY', [[0, 1], [18, 1.03], [36, 1], [54, 1.02], [72, 1]])];
    case 'blink': return [oscillate(9212, 'rotation', 0.025)];
    case 'tongue': return [oscillate(9212, 'rotation', 0.04), oscillate(9230, 'rotation', -0.04)];
    case 'yawn': return [track(190, 'scaleY', [[0, 1], [24, 1.018], [48, 1.01], [72, 1]]), oscillate(9230, 'rotation', 0.06)];
    case 'stretch': return [track(9213, 'rotation', [[0, 0], [20, -0.14], [40, -0.22], [60, -0.12], [72, 0]]), track(9219, 'rotation', [[0, 0], [20, 0.14], [40, 0.22], [60, 0.12], [72, 0]]), oscillate(190, 'scaleY', 1.018)];
    default: return [oscillate(9230, 'rotation', 0.05)];
  }
};
const animations = actions.map((name, index) => `        <LinearAnimation name="full.${name}" loopValue="oneShot" duration="72" fps="60" id="0:${animationStart + index}">\n${clipTracks(name).join('\n')}\n        </LinearAnimation>`).join('\n');

if (!scene.includes('ViewModelPropertyTrigger name="fist_pump"')) {
  const vmAnchor = '        <ViewModelPropertyTrigger name="smile" id="0:250"/>\n';
  const vmTriggers = actions.map((name, index) => `        <ViewModelPropertyTrigger name="${name}" id="0:${propertyStart + index}"/>`).join('\n') + '\n';
  scene = scene.replace(vmAnchor, vmAnchor + vmTriggers);
  const instanceAnchor = '            <ViewModelInstanceTrigger viewModelPropertyId="0:250"/>\n';
  const instanceTriggers = actions.map((_, index) => `            <ViewModelInstanceTrigger viewModelPropertyId="0:${propertyStart + index}"/>`).join('\n') + '\n';
  scene = scene.replace(instanceAnchor, instanceAnchor + instanceTriggers);

  const transition = actions.map((name, index) => `                    <StateTransition stateToId="0:${stateStart + index}" duration="80">\n                        <TransitionViewModelCondition>\n                            <TransitionPropertyViewModelComparator>\n                                <BindablePropertyTrigger>\n                                    <DataBindContext sourcePathIds="0:9100-0:${propertyStart + index}" propertyKey="686"/>\n                                </BindablePropertyTrigger>\n                            </TransitionPropertyViewModelComparator>\n                            <TransitionValueTriggerComparator/>\n                        </TransitionViewModelCondition>\n                    </StateTransition>`).join('\n');
  const transitionAnchor = '                </AnimationState>\n                <AnimationState x="520" y="-160" animationId="0:196" id="0:223">';
  if (!scene.includes(transitionAnchor)) throw new Error('action transition anchor not found');
  scene = scene.replace(transitionAnchor, `${transition}\n${transitionAnchor}`);

  const states = actions.map((name, index) => `                <AnimationState x="720" y="${index * 60}" animationId="0:${animationStart + index}" id="0:${stateStart + index}">\n                    <StateTransition stateToId="0:222" duration="100" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>\n                </AnimationState>`).join('\n');
  const stateAnchor = '                <AnimationState x="520" y="940" animationId="0:234" id="0:240">\n                    <StateTransition stateToId="0:222" duration="100" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>\n                </AnimationState>\n';
  if (!scene.includes(stateAnchor)) throw new Error('action state anchor not found');
  scene = scene.replace(stateAnchor, stateAnchor + states + '\n');
  const animationAnchor = '        <LinearAnimation name="full.smile"';
  const animationIndex = scene.indexOf(animationAnchor);
  const stateMachineIndex = scene.indexOf('        <StateMachine name="NomiFull"');
  if (animationIndex < 0 || stateMachineIndex < 0) throw new Error('animation insertion anchor not found');
  scene = scene.slice(0, stateMachineIndex) + animations + '\n' + scene.slice(stateMachineIndex);
  fs.writeFileSync(scenePath, scene);
}
