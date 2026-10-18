import fs from 'node:fs';

const path = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const removeTrack = (block, objectId) => {
  const re = new RegExp(`            <KeyedObject objectId="0:${objectId}">[\\s\\S]*?            </KeyedObject>\\n`, 'g');
  return block.replace(re, '');
};
const retarget = (block, fromId, toId) => block.replaceAll(`objectId="0:${fromId}"`, `objectId="0:${toId}"`);
scene = scene.replace(/        <LinearAnimation[\s\S]*?        <\/LinearAnimation>/g, (block) => {
  let next = block;
  next = retarget(next, 9213, 9378);
  next = retarget(next, 9219, 9379);
  for (const id of [9215, 9217, 9221, 9223]) next = removeTrack(next, id);
  return next;
});
fs.writeFileSync(path, scene);
