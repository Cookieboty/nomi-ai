import fs from 'node:fs';

const path = new URL('../../rive/nomi-complete/scene.rml', import.meta.url);
let scene = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const retarget = (block, fromId, toId) =>
  block.replaceAll(`objectId="0:${fromId}"`, `objectId="0:${toId}"`);
scene = scene.replace(/ {8}<LinearAnimation[\s\S]*? {8}<\/LinearAnimation>/g, (block) => {
  let next = block;
  next = retarget(next, 9213, 9378);
  next = retarget(next, 9219, 9379);
  // The rig wrapper owns only the shoulder pivot.  Forearm and hand tracks
  // remain on their original child bones so elbows, wrists and fingers keep
  // their authored arcs instead of collapsing into a rigid arm plate.
  return next;
});
fs.writeFileSync(path, scene);
