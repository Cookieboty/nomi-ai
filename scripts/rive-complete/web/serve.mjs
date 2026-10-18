/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
/* Static server for the standalone Rive test page: /rt -> @rive-app/canvas-lite, /riv -> built .riv, / -> this dir */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
export const MOUNTS = {
  '/rt/': path.join(root, 'node_modules/@rive-app/canvas-lite/'),
  '/riv/': path.join(root, 'rive/nomi-complete/build/'),
  '/': here + '/',
  ...(process.env.EXTRA_MOUNTS ? JSON.parse(process.env.EXTRA_MOUNTS) : {}),
};
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.riv': 'application/octet-stream',
};
export function serve(port = 0) {
  const srv = http
    .createServer((q, s) => {
      const u = decodeURIComponent(q.url.split('?')[0]);
      for (const [pre, dir] of Object.entries(MOUNTS).sort((a, b) => b[0].length - a[0].length)) {
        if (!u.startsWith(pre)) continue;
        const f = path.join(dir, u === pre ? 'index.html' : u.slice(pre.length));
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
          s.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
          return fs.createReadStream(f).pipe(s);
        }
      }
      s.statusCode = 404;
      s.end();
    })
    .listen(port);
  return srv;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  serve(8123);
  console.log('http://localhost:8123/');
}
