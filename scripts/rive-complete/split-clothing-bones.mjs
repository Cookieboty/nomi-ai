import fs from 'node:fs';

const project = new URL('../../rive/nomi-complete/', import.meta.url);
const scenePath = new URL('scene.rml', project);
const metaPath = new URL('reference/svg-rig/rig-meta.json', project);
let scene = fs.readFileSync(scenePath, 'utf8');

if (!scene.includes('name="full.sleeve-l.upper" x="0"')) {
  const left = `                <RootBone name="full.arm-l.upper" x="317.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9213">
                    <Image name="full.arm-l.shoulder-skin.image" assetId="0:9201" x="-4.2" y="-59.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9214"/>
                    <RootBone name="full.coat-l.shoulder" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9360">
                        <Image name="full.coat-l.shoulder.image" assetId="0:9322" x="-29.6" y="-16.9" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9318"/>
                    </RootBone>
                    <RootBone name="full.sleeve-l.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9361">
                        <Image name="full.sleeve-l.upper.image" assetId="0:9323" x="-76.2" y="38.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9340"/>
                    </RootBone>
                    <RootBone name="full.arm-l.fore" x="-25.4" y="215.5" rotation="0" length="1" scaleX="1" id="0:9215">
                        <RootBone name="full.sleeve-l.lower" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9362">
                            <Image name="full.sleeve-l.lower.image" assetId="0:9324" x="-71.9" y="-75.8" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9216"/>
                            <RootBone name="full.sleeve-l.cuff" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9363">
                                <Image name="full.arm-l.cuff.image" assetId="0:9204" x="-63.5" y="76.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9319"/>
                            </RootBone>
                        </RootBone>
                        <RootBone name="full.arm-l.hand" x="-17" y="174.3" rotation="0" length="1" scaleX="1" id="0:9217">`;
  const right = `                <RootBone name="full.arm-r.upper" x="642.8" y="270.8" rotation="0" length="1" scaleX="1" id="0:9219">
                    <Image name="full.arm-r.shoulder-skin.image" assetId="0:9310" x="-127" y="-59.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9220"/>
                    <RootBone name="full.coat-r.shoulder" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9364">
                        <Image name="full.coat-r.shoulder.image" assetId="0:9331" x="-110.6" y="-16.9" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9320"/>
                    </RootBone>
                    <RootBone name="full.sleeve-r.upper" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9365">
                        <Image name="full.sleeve-r.upper.image" assetId="0:9332" x="-85.9" y="38.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9346"/>
                    </RootBone>
                    <RootBone name="full.arm-r.fore" x="25.4" y="215.5" rotation="0" length="1" scaleX="1" id="0:9221">
                        <RootBone name="full.sleeve-r.lower" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9366">
                            <Image name="full.sleeve-r.lower.image" assetId="0:9333" x="-105.8" y="-75.8" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9222"/>
                            <RootBone name="full.sleeve-r.cuff" x="0" y="0" rotation="0" length="1" scaleX="1" id="0:9367">
                                <Image name="full.arm-r.cuff.image" assetId="0:9313" x="-84.6" y="76.2" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" id="0:9321"/>
                            </RootBone>
                        </RootBone>
                        <RootBone name="full.arm-r.hand" x="17" y="174.3" rotation="0" length="1" scaleX="1" id="0:9223">`;

  const leftStart = scene.indexOf('                <RootBone name="full.arm-l.upper"');
  const leftEnd = scene.indexOf('                            <Image name="full.hand-l.palm.image"', leftStart);
  if (leftStart < 0 || leftEnd < 0) throw new Error('left arm block not found');
  scene = scene.slice(0, leftStart) + left + '\n' + scene.slice(leftEnd);

  const rightStart = scene.indexOf('                <RootBone name="full.arm-r.upper"');
  const rightEnd = scene.indexOf('                            <Image name="full.hand-r.palm.image"', rightStart);
  if (rightStart < 0 || rightEnd < 0) throw new Error('right arm block not found');
  scene = scene.slice(0, rightStart) + right + '\n' + scene.slice(rightEnd);
  fs.writeFileSync(scenePath, scene);
}

const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const names = [
  'full.coat-l.shoulder', 'full.sleeve-l.upper', 'full.sleeve-l.lower', 'full.sleeve-l.cuff',
  'full.coat-r.shoulder', 'full.sleeve-r.upper', 'full.sleeve-r.lower', 'full.sleeve-r.cuff',
];
metadata.bones = [...new Set(metadata.bones.flatMap((name) => {
  if (name === 'full.arm-l.upper') return ['full.arm-l.upper', ...names.slice(0, 4)];
  if (name === 'full.arm-r.upper') return ['full.arm-r.upper', ...names.slice(4)];
  return [name];
}))];
metadata.skeleton.visualBones = [...new Set([
  ...metadata.skeleton.visualBones,
  ...names,
])];
metadata.materialLayers['full.arm-l'].bone = 'full.arm-l.upper/full.coat-l.shoulder/full.sleeve-l.upper>full.arm-l.fore/full.sleeve-l.lower/full.sleeve-l.cuff>full.arm-l.hand/full.arm-l.thumb|index|middle|ring|little';
metadata.materialLayers['full.arm-r'].bone = 'full.arm-r.upper/full.coat-r.shoulder/full.sleeve-r.upper>full.arm-r.fore/full.sleeve-r.lower/full.sleeve-r.cuff>full.arm-r.hand/full.arm-r.thumb|index|middle|ring|little';
metadata.materialLayers['full.clothing'] = {
  asset: 'reference/svg-rig/coat-l-shoulder.png,coat-r-shoulder.png,sleeve-l-upper.png,sleeve-l-lower.png,arm-l-cuff.png,sleeve-r-upper.png,sleeve-r-lower.png,arm-r-cuff.png',
  bone: names.join('/'),
  source: 'source-nomi-master.png',
  kind: 'mother-derived-independent-clothing-bones',
};
fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
