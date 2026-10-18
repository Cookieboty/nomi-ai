/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
const a = new H.RigAnimator(11);
let t = 0;
const dt = 1 / 60;
for (let i = 0; i < 90; i++) {
  a.step(dt, t, { ...base, reducedMotion: false });
  t += dt;
}
const out = {};
for (const id of ['wave', 'cheer']) {
  const d = a.actions.def(id);
  out[id + '_def'] = d ? { dur: d.dur, keys: Object.keys(d) } : null;
}
const p = a.step(dt, t, { ...base, reducedMotion: false, gesture: { name: 'wave', id: 1 } });
out.pkeys = Object.keys(p);
out.p = JSON.stringify(p).slice(0, 1500);
out.IDX = JSON.stringify(H.IDX).slice(0, 1500);
return out;
