import fs from 'node:fs';

const path = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
for (const objectId of ['9212', '9230']) {
  const re = new RegExp(`            <KeyedObject objectId="0:${objectId}">[\\s\\S]*?            </KeyedObject>\\n`, 'g');
  scene = scene.replace(re, '');
}
fs.writeFileSync(path, scene);
