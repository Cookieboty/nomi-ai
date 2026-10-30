/**
 * 钉 IP 的上游 fetch：lookup 只解析一次，二次解析变私网也不能连过去。
 */
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createPinnedLookup, createUpstreamFetch, proxyEnvActive } from '../src/net/upstreamFetch';
import { resolveUpstreamAddresses } from '../src/net/upstreamGuard';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { port, base: `http://127.0.0.1:${port}` };
}

describe('upstreamFetch DNS pin', () => {
  it('resolveUpstreamAddresses uses a single lookup; pinned lookup never re-resolves', async () => {
    let calls = 0;
    const lookupAll = async (): Promise<LookupAddress[]> => {
      calls += 1;
      return [{ address: '203.0.113.10', family: 4 }];
    };
    const { addresses } = await resolveUpstreamAddresses('https://api.example.com/v1', {
      lookupAll,
    });
    expect(calls).toBe(1);
    expect(addresses[0]!.address).toBe('203.0.113.10');

    const pinnedLookup = createPinnedLookup(() => ({ lookupAll }));
    await new Promise<void>((resolve, reject) => {
      pinnedLookup('api.example.com', { all: true }, (err, addrs) => {
        if (err) reject(err);
        else {
          expect(addrs).toEqual([{ address: '203.0.113.10', family: 4 }]);
          resolve();
        }
      });
    });
    expect(calls).toBe(2);
  });

  it('rebinding: second DNS returning private must not be used after pin', async () => {
    const hits: string[] = [];
    const { port } = await listen((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    let n = 0;
    const lookupAll = async (): Promise<LookupAddress[]> => {
      n += 1;
      if (n === 1) return [{ address: '127.0.0.1', family: 4 }];
      return [{ address: '10.0.0.1', family: 4 }];
    };

    const host = 'pin-rebind.test';
    const fetchImpl = createUpstreamFetch({
      getGuard: () => ({
        lookupAll,
        allowedPrivateHosts: [`${host}:${port}`],
      }),
    });

    const res = await fetchImpl(`http://${host}:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(hits).toEqual(['/chat']);
    // resolve 只查一次；Agent connect.lookup 用钉住的 127.0.0.1，不会拿到 10.0.0.1
    expect(n).toBe(1);
  });

  it('fake-ip 198.18/15 is still allowed for domain names', async () => {
    const { addresses } = await resolveUpstreamAddresses('https://api.example.com/v1', {
      lookupAll: async () => [{ address: '198.18.0.1', family: 4 }],
    });
    expect(addresses[0]!.address).toBe('198.18.0.1');
  });

  it('proxyEnvActive detects HTTP(S)_PROXY', () => {
    expect(proxyEnvActive({})).toBe(false);
    expect(proxyEnvActive({ HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBe(true);
    expect(proxyEnvActive({ http_proxy: 'http://127.0.0.1:7890' })).toBe(true);
  });
});
