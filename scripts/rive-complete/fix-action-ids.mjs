import fs from 'node:fs';

const path = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
for (let index = 0; index < 31; index += 1) {
  const animationId = 300 + index;
  const stateId = 400 + index;
  scene = scene.replaceAll(`animationId="0:${animationId}" id="0:${animationId}"`, `animationId="0:${animationId}" id="0:${stateId}"`);
  scene = scene.replaceAll(`stateToId="0:${animationId}" duration="80"`, `stateToId="0:${stateId}" duration="80"`);
}
fs.writeFileSync(path, scene);
