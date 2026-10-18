/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
// canvas-rig frames at exact 60 Hz frame indices of a gesture (same timeline as the Rive rows): env {model, action, frames:[..], scale}
const env = JSON.parse(window.__env || '{}');
const { rig, imgs } = await loadModel(env.model);
const out = {};
const id = env.action, sc = env.scale || 1, want = new Set(env.frames);
const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
const a = new H.RigAnimator(11);
let t = 0; const dt = 1 / 60;
for (let i = 0; i < 90; i++) { a.step(dt, t, { ...base, reducedMotion: false }); t += dt; }
const nF = Math.max(...env.frames);
for (let f = 0; f <= nF; f++) {
  const p = a.step(dt, t, { ...base, reducedMotion: false, gesture: f === 0 ? { name: id, id: 1 } : undefined });
  t += dt;
  if (want.has(f)) { const c = renderPose(rig, imgs, p, sc, '#f6efe8'); out['f' + String(f).padStart(3, '0')] = c.toDataURL('image/png'); }
}
return out;
