#!/usr/bin/env node
/**
 * accept-encoding / 响应解码 golden（D-B4d-2 消除）：用真实 createUpstreamFetch（undici 7）
 * 请求一个按字节回放的假上游，记录上游收到的 accept-encoding 行、客户端看到的状态 / 头 / 解码后的体（或失败）。
 * 用法：node scripts/parity/encoding.mjs → apps/desktop-go/internal/gateway/testdata/parity/encoding.json
 */
import net from 'node:net';
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createUpstreamFetch } = await import(pathToFileURL(join(root, 'packages/gateway/src/net/upstreamFetch.ts')).href);

const text = Buffer.from('{"ok":true,"msg":"你好 hello"}');
const gz = zlib.gzipSync(text);
const enc = {
  identity: text,
  gzip: gz,
  zlib: zlib.deflateSync(text),
  raw: zlib.deflateRawSync(text),
  br: zlib.brotliCompressSync(text),
  gzbr: zlib.brotliCompressSync(gz), // content-encoding: gzip, br
  gz2: zlib.gzipSync(gz),
  trunc: gz.subarray(0, gz.length - 6),
  bad: Buffer.from('not gzip at all'),
  empty: Buffer.alloc(0),
  multi: Buffer.concat([zlib.gzipSync(Buffer.from('a')), zlib.gzipSync(Buffer.from('b'))]),
};
const cases = [
  { name: 'plain', ce: null, body: 'identity' },
  { name: 'gzip', ce: 'gzip', body: 'gzip' },
  { name: 'x-gzip', ce: 'x-gzip', body: 'gzip' },
  { name: 'GZIP upper', ce: 'GZIP', body: 'gzip' },
  { name: 'deflate zlib', ce: 'deflate', body: 'zlib' },
  { name: 'deflate raw', ce: 'deflate', body: 'raw' },
  { name: 'br', ce: 'br', body: 'br' },
  { name: 'gzip, br', ce: 'gzip, br', body: 'gzbr' },
  { name: 'gzip,gzip', ce: 'gzip,gzip', body: 'gz2' },
  { name: 'unknown', ce: 'compress', body: 'gzip' },
  { name: 'gzip, unknown', ce: 'gzip, foo', body: 'gzip' },
  { name: 'identity token', ce: 'identity', body: 'identity' },
  { name: 'too many', ce: 'gzip, gzip, gzip, gzip, gzip, gzip', body: 'gzip' },
  { name: 'truncated', ce: 'gzip', body: 'trunc' },
  { name: 'corrupt', ce: 'gzip', body: 'bad' },
  { name: 'empty gzip', ce: 'gzip', body: 'empty' },
  { name: 'multi-member', ce: 'gzip', body: 'multi' },
  { name: '204', ce: 'gzip', body: 'empty', status: 204 },
  { name: '304', ce: 'gzip', body: 'empty', status: 304 },
  { name: 'HEAD', ce: 'gzip', body: 'gzip', method: 'HEAD' },
  { name: '302 manual', ce: 'gzip', body: 'gzip', status: 302, location: '/x' },
  { name: '500 gzip', ce: 'gzip', body: 'gzip', status: 500 },
  { name: 'caller AE', ce: 'gzip', body: 'gzip', reqHeaders: { 'accept-encoding': 'identity' } },
  { name: 'caller Range', ce: null, body: 'identity', reqHeaders: { range: 'bytes=0-' } },
  { name: 'caller Range+AE', ce: null, body: 'identity', reqHeaders: { range: 'bytes=0-', 'Accept-Encoding': 'br' } },
  { name: 'POST gzip', ce: 'gzip', body: 'gzip', method: 'POST', reqBody: '{"a":1}', reqHeaders: { 'content-type': 'application/json' } },
];

function serve(c) {
  const seen = [];
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0 || seen.length) return;
      seen.push(...buf.slice(0, i).split('\r\n').slice(1).filter((l) => /^(accept-encoding|range):/i.test(l)));
      const body = c.status === 204 || c.status === 304 || c.method === 'HEAD' ? Buffer.alloc(0) : enc[c.body];
      const status = c.status ?? 200;
      const head = [`HTTP/1.1 ${status} X`, 'content-type: application/json'];
      if (c.ce) head.push(`content-encoding: ${c.ce}`);
      if (c.location) head.push(`location: ${c.location}`);
      if (status !== 204 && status !== 304) head.push(`content-length: ${c.method === 'HEAD' ? enc[c.body].length : body.length}`);
      head.push('connection: close');
      sock.end(Buffer.concat([Buffer.from(head.join('\r\n') + '\r\n\r\n', 'latin1'), body]));
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, port: srv.address().port })));
}

const out = [];
for (const c of cases) {
  const s = await serve(c);
  const host = `127.0.0.1:${s.port}`;
  const f = createUpstreamFetch({ env: {}, getGuard: () => ({ allowedPrivateHosts: [host] }) });
  const rec = { ...c, res: null, error: null, bodyError: null };
  try {
    const res = await f(`http://${host}/v1`, { method: c.method ?? 'GET', headers: c.reqHeaders, body: c.reqBody });
    rec.res = {
      status: res.status,
      contentEncoding: res.headers.get('content-encoding'),
      contentLength: res.headers.get('content-length'),
    };
    try {
      rec.res.body = Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) {
      rec.bodyError = true;
    }
  } catch (e) {
    rec.error = true;
  }
  rec.seen = s.seen;
  s.srv.close();
  out.push(rec);
}
const bodies = Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, v.toString('base64')]));
writeFileSync(join(root, 'apps/desktop-go/internal/gateway/testdata/parity/encoding.json'), JSON.stringify({ bodies, cases: out }, null, 1));
console.log('encoding cases', out.length);
