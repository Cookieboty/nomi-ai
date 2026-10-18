/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
const env = JSON.parse(window.__env || '{}');
const dir = env.model;
const { rig, imgs } = await loadModel(dir);
const out = {};
const N = env.frames || 8,
  sc = env.scale || 0.27;
const crop = env.crop || [40, 0, 920, 1000];
const cw = Math.round((crop[2] - crop[0]) * sc),
  ch = Math.round((crop[3] - crop[1]) * sc);
const base = { expression: 'neutral', mouth: 0, talking: false, blink: 0, lookX: 0, lookY: 0 };
for (const id of env.actions) {
  const a = new H.RigAnimator(11);
  let t = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) {
    a.step(dt, t, { ...base, reducedMotion: false });
    t += dt;
  }
  const def = a.actions.def(id);
  if (!def) {
    console.log('missing', id);
    continue;
  }
  const total = Math.min(def.dur + (env.tail ?? 0.4), 9);
  const cols = env.cols || N;
  const rows = Math.ceil(N / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cw * cols;
  sheet.height = ch * rows + 14;
  const g = sheet.getContext('2d');
  g.fillStyle = '#f6efe8';
  g.fillRect(0, 0, sheet.width, sheet.height);
  let first = true,
    k = 0;
  const nFrames = Math.round(total / dt);
  const times = env.times
    ? env.times.map((x) => Math.round(x / dt))
    : [...Array(N)].map((_, i) => Math.round(((i + 0.5) / N) * nFrames));
  for (let f = 0; f <= nFrames; f++) {
    const p = a.step(dt, t, {
      ...base,
      reducedMotion: false,
      gesture: first ? { name: id, id: 1 } : undefined,
    });
    first = false;
    t += dt;
    const idx = times.indexOf(f);
    if (idx >= 0) {
      const c = renderPose(rig, imgs, p, 1, '#f6efe8');
      const cx = (idx % cols) * cw,
        cy = Math.floor(idx / cols) * ch + 14;
      g.drawImage(c, crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1], cx, cy, cw, ch);
      g.fillStyle = '#555';
      g.font = '11px sans-serif';
      g.fillText("R (char's right)", cx + 4, cy + ch - 4);
      {
        const t = "L (char's left)";
        g.fillText(t, cx + cw - g.measureText(t).width - 4, cy + ch - 16);
      }
      if (idx % cols === 0 && idx < cols) g.fillText(id + '  ' + def.dur + 's', 4, 10);
      g.fillText((f * dt).toFixed(2) + 's', cx + cw - 40, cy + ch - 4);
    }
  }
  out[(env.prefix || '') + id] = sheet.toDataURL('image/png');
}
return out;
