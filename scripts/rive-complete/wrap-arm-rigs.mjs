import fs from 'node:fs';

const scenePath = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(scenePath, 'utf8').replace(/\r\n/g, '\n');
if (!scene.includes('name="full.arm-l.rig"')) {
  const leftStart = scene.indexOf('                <RootBone name="full.arm-l.upper"');
  const rightStart = scene.indexOf('                <RootBone name="full.arm-r.upper"');
  if (leftStart < 0 || rightStart < 0) throw new Error('arm roots not found');
  const leftOpen = '                <RootBone name="full.arm-l.upper" x="317.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9213">';
  const leftInner = '                    <RootBone name="full.arm-l.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9213">';
  const leftWrap = '                <RootBone name="full.arm-l.rig" x="317.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9378">';
  let leftBlock = scene.slice(leftStart, rightStart);
  if (!leftBlock.startsWith(leftOpen)) throw new Error('left opening mismatch');
  leftBlock = leftWrap + '\n' + leftBlock.replace(leftOpen, leftInner) + '                </RootBone>\n';
  scene = scene.slice(0, leftStart) + leftBlock + scene.slice(rightStart);

  const rightStart2 = scene.indexOf('                <RootBone name="full.arm-r.upper"');
  const rootEnd = scene.indexOf('            </RootBone>\n        </Node>', rightStart2);
  if (rightStart2 < 0 || rootEnd < 0) throw new Error('right block end not found');
  const rightOpen = '                <RootBone name="full.arm-r.upper" x="642.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9219">';
  const rightInner = '                    <RootBone name="full.arm-r.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9219">';
  const rightWrap = '                <RootBone name="full.arm-r.rig" x="642.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9379">';
  const rightBlock = scene.slice(rightStart2, rootEnd);
  if (!rightBlock.startsWith(rightOpen)) throw new Error('right opening mismatch');
  scene = scene.slice(0, rightStart2) + rightWrap + '\n' + rightBlock.replace(rightOpen, rightInner) + '                </RootBone>\n' + scene.slice(rootEnd);
  fs.writeFileSync(scenePath, scene);
}

const metaPath = new URL('../../rive/nomi-complete/reference/svg-rig/rig-meta.json', import.meta.url);
const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
metadata.bones = [...new Set(metadata.bones.flatMap((name) => {
  if (name === 'full.arm-l.upper') return ['full.arm-l.rig', name];
  if (name === 'full.arm-r.upper') return ['full.arm-r.rig', name];
  return [name];
}))];
metadata.skeleton.visualBones = [...new Set(['full.arm-l.rig', 'full.arm-r.rig', ...metadata.skeleton.visualBones])];
metadata.materialLayers['full.arm-l'].bone = 'full.arm-l.rig>full.arm-l.upper/full.coat-l.shoulder/full.sleeve-l.upper>full.arm-l.fore/full.sleeve-l.lower/full.sleeve-l.cuff>full.arm-l.hand/full.arm-l.thumb|index|middle|ring|little';
metadata.materialLayers['full.arm-r'].bone = 'full.arm-r.rig>full.arm-r.upper/full.coat-r.shoulder/full.sleeve-r.upper>full.arm-r.fore/full.sleeve-r.lower/full.sleeve-r.cuff>full.arm-r.hand/full.arm-r.thumb|index|middle|ring|little';
fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
