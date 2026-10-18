/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
// box-specific playwright harness for the CANVAS rig (reads the polish worktree read-only through /workspace)
const { chromium } = await import(process.env.PW_CORE || '/workspace/nomi-2d-polish/node_modules/playwright-core/index.mjs');
import http from 'http';
import fs from 'fs';
import path from 'path';
const srv = http
  .createServer((q, r) => {
    const p = '/workspace' + decodeURIComponent(q.url.split('?')[0]);
    fs.readFile(p, (e, d) => {
      if (e) {
        r.writeHead(404);
        r.end();
        return;
      }
      r.writeHead(200, {
        'content-type': p.endsWith('.html')
          ? 'text/html'
          : p.endsWith('.js')
            ? 'text/javascript'
            : p.endsWith('.json')
              ? 'application/json'
              : 'image/png',
      });
      r.end(d);
    });
  })
  .listen(0);
const port = srv.address().port;
const b = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
const pg = await b.newPage({ viewport: { width: 900, height: 1000 } });
pg.on('console', (m) => console.log('console:', m.text()));
pg.on('pageerror', (e) => console.log('ERR', e.message));
await pg.goto(`http://localhost:${port}/work/h2d/index.html`);
await pg.addScriptTag({ content: fs.readFileSync('/workspace/work/h2d/lib.js', 'utf8') });
await pg.evaluate(`window.__env=${JSON.stringify(process.env.ENV || '{}')}`);
const out = await pg.evaluate(`(async()=>{${fs.readFileSync(process.argv[2], 'utf8')}})()`);
const od = process.argv[3] || '/workspace/scratch/rc/out';
fs.mkdirSync(od, { recursive: true });
for (const [k, v] of Object.entries(out || {})) {
  if (typeof v === 'string' && v.startsWith('data:image'))
    fs.writeFileSync(path.join(od, k + '.png'), Buffer.from(v.split(',')[1], 'base64'));
  else if (process.env.JSONOUT) fs.writeFileSync(path.join(od, k + '.json'), JSON.stringify(v));
  else console.log(k, JSON.stringify(v));
}
console.log('done');
await b.close();
srv.close();
