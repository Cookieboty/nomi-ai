/* eslint-disable -- evaluation harness. Usage: node perf.mjs <rive|canvas> <wave|cheer|celebrate> <cpuThrottle> [secs]
   Measures requestAnimationFrame rate + main-thread time per frame in headless Chromium (software GL). */
const { chromium } = await import(process.env.PW_CORE || '/workspace/nomi-2d-polish/node_modules/playwright-core/index.mjs');

const [, , kind, action, thr = '4', secs = '10'] = process.argv;
process.env.EXTRA_MOUNTS = JSON.stringify({
  '/h2d/': '/workspace/work/h2d/',
  '/nomi-2d-polish/': '/workspace/nomi-2d-polish/',
});
const { serve: s2 } = await import('./serve.mjs?x');
const srv = s2(0);
const port = srv.address().port;
const b = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const ctx = await b.newContext({ viewport: { width: 480, height: 560 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message));
const cdp = await ctx.newCDPSession(p);
await cdp.send('Performance.enable');
await p.goto(`http://localhost:${port}/${kind === 'rive' ? 'index.html' : 'perf-canvas.html'}`);
await p.waitForFunction('window.ready===true', null, { timeout: 30000 });
const names = action === 'both' ? ['wave', action === 'both' ? 'cheer' : action] : [action];
const cn = (n) => (kind === 'canvas' && n === 'cheer' ? 'celebrate' : n);
if (kind === 'rive')
  await p.evaluate(
    `window.fire('${names[0]}'); window._i = setInterval(()=>{ window.__k=(window.__k||0)+1; window.fire(${JSON.stringify(names)}[window.__k%${names.length}]) }, 2800)`,
  );
else await p.evaluate(`window.loopActions(${JSON.stringify(names.map(cn))}, 2800)`);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +thr });
await p.waitForTimeout(2000);
const m = async () =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
  );
const m0 = await m();
const f0 = await p.evaluate('window.frames');
const d0 = await p.evaluate('[window.drawMs||0, window.drawn||0]');
const t0 = Date.now();
await p.waitForTimeout(+secs * 1000);
const m1 = await m();
const f1 = await p.evaluate('window.frames');
const d1 = await p.evaluate('[window.drawMs||0, window.drawn||0]');
const dt = (Date.now() - t0) / 1000,
  fr = f1 - f0;
console.log(
  JSON.stringify({
    kind,
    action,
    cpuThrottle: +thr,
    secs: +dt.toFixed(1),
    rafFrames: fr,
    fps: +(fr / dt).toFixed(1),
    mainThreadMsPerFrame: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / fr).toFixed(2),
    drawMsPerFrame: kind === 'canvas' ? +((d1[0] - d0[0]) / (d1[1] - d0[1])).toFixed(2) : undefined,
    jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
  }),
);
await b.close();
srv.close();
