/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
// dumps per-frame (60 fps, from the gesture start) arm/body params of the canvas rig for wave and cheer
const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
const { rig, imgs } = await loadModel(
  '/nomi-2d-polish/packages/renderer/public/assets/models/sprite/nomi',
);
const out = {};
for (const id of ['wave', 'cheer', 'celebrate', 'wave_both']) {
  const a = new H.RigAnimator(11);
  let t = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) {
    a.step(dt, t, { ...base, reducedMotion: false });
    t += dt;
  }
  const def = a.actions.def(id);
  const total = Math.min(def.dur + 0.4, 9);
  const nF = Math.round(total / dt);
  const rows = [];
  for (let f = 0; f <= nF; f++) {
    const p = a.step(dt, t, {
      ...base,
      reducedMotion: false,
      gesture: f === 0 ? { name: id, id: 1 } : undefined,
    });
    t += dt;
    const v = (p.ext && p.ext.v) || {};
    const g = (k) => v[H.IDX[k]] || 0;
    renderPose(rig, imgs, p, 1, '#f6efe8');
    const af = H.armFrame;
    const hand = { hx: af.hx, hy: af.hy, hPsi: af.hPsi };
    rows.push({
      f,
      hand,
      rOn: g('rOn'),
      rA: g('rA'),
      rE: g('rE'),
      rW: g('rW'),
      rHand: g('rHand'),
      rZ: g('rZ'),
      rMix: g('rMix'),
      lOn: g('lOn'),
      lA: g('lA'),
      lE: g('lE'),
      lW: g('lW'),
      lHand: g('lHand'),
      lZ: g('lZ'),
      lMix: g('lMix'),
      bodyY: p.bodyY,
      torsoX: p.torsoX,
      torsoRot: p.torsoRot,
      headRot: p.headRot,
      headX: p.headX,
      headY: p.headY,
      shoulderL: p.shoulderL,
      shoulderR: p.shoulderR,
      armRotL: p.armRotL,
      armRotR: p.armRotR,
      spine: p.spine,
    });
  }
  out[id] = { dur: def.dur, rows };
}
return out;
