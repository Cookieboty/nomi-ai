/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
// canvas-rig frame dump for GIFs (runs inside shot.mjs): every `step` 60Hz frames of one action, cream bg, scale env.scale
const env = JSON.parse(window.__env || '{}');
const { rig, imgs } = await loadModel(env.model);
const out = {};
const id = env.action,
  step = env.step || 2,
  sc = env.scale || 0.5;
const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
const a = new H.RigAnimator(11);
let t = 0;
const dt = 1 / 60;
for (let i = 0; i < 90; i++) {
  a.step(dt, t, { ...base, reducedMotion: false });
  t += dt;
}
const total = Math.min(a.actions.def(id).dur + 0.3, 9);
const n = Math.round(total / dt);
for (let f = 0; f <= n; f++) {
  const p = a.step(dt, t, {
    ...base,
    reducedMotion: false,
    gesture: f === 0 ? { name: id, id: 1 } : undefined,
  });
  t += dt;
  if (f % step === 0) {
    const c = renderPose(rig, imgs, p, sc, '#f6efe8');
    out['f' + String(f).padStart(4, '0')] = c.toDataURL('image/png');
  }
}
return out;
