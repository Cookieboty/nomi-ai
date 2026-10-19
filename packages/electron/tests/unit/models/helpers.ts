import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'cd-models-'));

export interface MockRoute {
  body: Buffer | string;
  etag?: string;
  status?: number;
  /** 支持 Range 续传（默认 true） */
  ranges?: boolean;
  /** 只发前 n 个字节然后断开（模拟网络中断） */
  cutAfter?: number;
  /** 收到请求后永不响应（模拟卡死的连接） */
  hang?: boolean;
}

export interface MockServer {
  url: string;
  routes: Map<string, MockRoute>;
  hits: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export async function mockServer(): Promise<MockServer> {
  const routes = new Map<string, MockRoute>();
  const hits: MockServer['hits'] = [];
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    hits.push({ path: p, headers: req.headers });
    const r = routes.get(p);
    if (r?.hang) return;
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (r.status && r.status !== 200) {
      res.writeHead(r.status).end();
      return;
    }
    if (r.etag && req.headers['if-none-match'] === r.etag) {
      res.writeHead(304).end();
      return;
    }
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    let start = 0;
    if (range && r.ranges !== false) {
      start = Number(range[1]);
      res.writeHead(206, {
        'content-length': body.length - start,
        ...(r.etag ? { etag: r.etag } : {}),
      });
    } else {
      res.writeHead(200, { 'content-length': body.length, ...(r.etag ? { etag: r.etag } : {}) });
    }
    const chunk = body.subarray(start);
    if (r.cutAfter !== undefined) {
      const n = r.cutAfter;
      delete r.cutAfter; // 只中断一次
      res.write(chunk.subarray(0, n), () => setTimeout(() => res.destroy(), 200));
      return;
    }
    res.end(chunk);
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    routes,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const sock of sockets) sock.destroy(); // 卡死的连接不能挡住关闭
      }),
  };
}
