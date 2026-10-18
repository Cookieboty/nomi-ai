import fs from 'node:fs';

const scenePath = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(scenePath, 'utf8').replace(/\r\n/g, '\n');
if (!scene.includes('full.body.backfill')) {
  const assetAnchor = '    <ImageAsset name="fullbody-base-no-head-arms" file="reference/svg-rig/fullbody-base-no-head-arms.png" id="0:9200"/>\n';
  if (!scene.includes(assetAnchor)) throw new Error('asset anchor not found');
  scene = scene.replace(assetAnchor, assetAnchor + '    <ImageAsset name="fullbody-body-backfill" file="reference/svg-rig/body-backfill.png" id="0:9376"/>\n');
  const imageAnchor = '            <Image name="full.neutral" assetId="0:9200" x="46.93333" y="0" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" opacity="1" id="0:192"/>\n';
  if (!scene.includes(imageAnchor)) throw new Error('image anchor not found');
  scene = scene.replace(imageAnchor, imageAnchor + '            <Image name="full.body.backfill" assetId="0:9376" x="46.93333" y="0" originX="0" originY="0" scaleX="0.846354" scaleY="0.846354" opacity="1" id="0:9377"/>\n');
  fs.writeFileSync(scenePath, scene);
}
