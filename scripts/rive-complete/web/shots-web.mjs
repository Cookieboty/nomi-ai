/* eslint-disable -- harness: node shots-web.mjs <action> <out_dir> t1,t2,...   (screenshots of the standalone Rive page at given seconds after the trigger) */
import { chromium } from '/workspace/nomi-2d-polish/node_modules/playwright-core/index.mjs';
import { serve } from './serve.mjs';
import fs from 'node:fs';
const [, , action, out, times] = process.argv;
const srv = serve(0);
const port = srv.address().port;
const b = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const p = await (await b.newContext({ viewport: { width: 480, height: 560 } })).newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`http://localhost:${port}/index.html`);
await p.waitForFunction('window.ready===true');
await p.waitForTimeout(500);
fs.mkdirSync(out, { recursive: true });
await p.evaluate(`window.fire('${action}')`);
const t0 = Date.now();
for (const t of times.split(',').map(Number)) {
  const wait = t * 1000 - (Date.now() - t0);
  if (wait > 0) await p.waitForTimeout(wait);
  await p.screenshot({ path: `${out}/${action}-${t.toFixed(2)}s.png` });
}
await b.close();
srv.close();
