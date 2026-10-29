/**
 * Proxy fixtures: drive the real upstream fetch (undici EnvHttpProxyAgent) with
 * different proxy env vars against a recording fake proxy and a fake direct
 * server, and record which path each request took and what the proxy saw.
 */
import net from 'node:net';

export const proxyEnvs = [
  {},
  { HTTP_PROXY: 'http://{PROXY}' },
  { http_proxy: '', HTTP_PROXY: 'http://{PROXY}' },
  { HTTPS_PROXY: 'http://{PROXY}' },
  { https_proxy: 'http://{PROXY}', HTTPS_PROXY: 'http://127.0.0.1:1' },
  { ALL_PROXY: 'http://{PROXY}' },
  { all_proxy: 'socks5://{PROXY}' },
  { HTTP_PROXY: 'http://user:pa%40ss@{PROXY}' },
  { HTTP_PROXY: 'http://user@{PROXY}' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'api.example.com' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: '.example.com' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: '*.example.com' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: '*' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'example.com:{DIRECT}' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'example.com:1' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'foo, other.com' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'xample.com' },
  { HTTP_PROXY: 'http://{PROXY}', no_proxy: '', NO_PROXY: '*' },
  { HTTP_PROXY: 'http://{PROXY}', NO_PROXY: 'API.EXAMPLE.COM' },
];
export const proxyTargets = ['http://api.example.com:{DIRECT}/v1', 'https://api.example.com:{DIRECT}/v1'];
const KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

function recorder() {
  const seen = [];
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        seen.push(buf.slice(0, i).split('\r\n'));
        sock.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      }
    });
    sock.on('error', () => {});
    seen.push('connect');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, port: srv.address().port })));
}

export async function recordProxy({ gw }) {
  const { createUpstreamFetch } = await gw('src/net/upstreamFetch.ts');
  const out = [];
  for (const envT of proxyEnvs) {
    for (const tT of proxyTargets) {
      const proxy = await recorder();
      const direct = await recorder();
      const sub = (s) => s.replaceAll('{PROXY}', `127.0.0.1:${proxy.port}`).replaceAll('{DIRECT}', String(direct.port));
      const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      for (const k of KEYS) delete process.env[k];
      for (const [k, v] of Object.entries(envT)) process.env[k] = sub(v);
      const target = sub(tT);
      const host = new URL(target).host;
      const f = createUpstreamFetch({
        env: process.env,
        getGuard: () => ({ allowedPrivateHosts: [host], lookupAll: async () => [{ address: '127.0.0.1', family: 4 }] }),
      });
      try {
        await f(target, { signal: AbortSignal.timeout(3000) });
      } catch {
        /* expected: fake servers never answer properly */
      }
      for (const k of KEYS) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      const unsub = (x) =>
        JSON.parse(JSON.stringify(x).replaceAll(`127.0.0.1:${proxy.port}`, '{PROXY}').replaceAll(String(direct.port), '{DIRECT}'));
      out.push({
        env: envT,
        target: tT,
        via: proxy.seen.length ? 'proxy' : direct.seen.length ? 'direct' : 'none',
        proxySaw: unsub(proxy.seen.filter((x) => x !== 'connect')),
      });
      proxy.srv.close();
      direct.srv.close();
    }
  }
  return { cases: out };
}
