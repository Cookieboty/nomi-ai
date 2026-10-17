jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

jest.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
}));

import {
  CliRouteService,
  isAllowedHostHeader,
  isLoopbackHost,
} from '../../../../src/cli/routing/CliRouteService';

const quiet = { info: () => undefined, warn: () => undefined };

async function freePort(): Promise<number> {
  const probe = http.createServer();
  const port = await new Promise<number>((r) =>
    probe.listen(0, '127.0.0.1', () => r((probe.address() as AddressInfo).port)),
  );
  await new Promise((r) => probe.close(r));
  return port;
}

async function mkRoute(extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-route-sec-'));
  const port = await freePort();
  fs.writeFileSync(
    path.join(root, 'routing.json'),
    JSON.stringify({ enabled: true, host: '127.0.0.1', port, claude: true, codex: true, ...extra }),
  );
  const svc = new CliRouteService({
    root,
    logger: quiet,
    resolveUpstream: () => null,
  });
  return { svc, root, port };
}

function rawRequest(
  port: number,
  headers: Record<string, string>,
  opts: { method?: string; path?: string; agent?: http.Agent } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/v1/messages',
        headers,
        agent: opts.agent,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('CliRouteService 安全', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    while (stops.length) stops.pop()!();
  });

  it('setSettings 拒绝 0.0.0.0 / 局域网 / 外网 host', async () => {
    const { svc } = await mkRoute({ enabled: false });
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '10.0.0.1']) {
      expect(() => svc.setSettings({ host })).toThrow(/127\.0\.0\.1/);
    }
    expect(svc.getSettings().host).toBe('127.0.0.1');
    expect(() => svc.setSettings({ host: 'localhost' })).not.toThrow();
    expect(() => svc.setSettings({ host: '::1' })).not.toThrow();
    svc.stop();
  });

  it('历史配置里的非回环 host 加载时回退到 127.0.0.1', async () => {
    const { svc } = await mkRoute({ host: '0.0.0.0', enabled: false });
    expect(svc.getSettings().host).toBe('127.0.0.1');
  });

  it('isLoopbackHost / isAllowedHostHeader', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:18721', 18721)).toBe(true);
    expect(isAllowedHostHeader('localhost:18721', 18721)).toBe(true);
    expect(isAllowedHostHeader('[::1]:18721', 18721)).toBe(true);
    expect(isAllowedHostHeader('evil.example:18721', 18721)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:9999', 18721)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1.evil.example:18721', 18721)).toBe(false);
    expect(isAllowedHostHeader(undefined, 18721)).toBe(false);
  });

  it('Host 头不是回环名（DNS 重绑定）→ 421，即使带了正确令牌', async () => {
    const { svc, port } = await mkRoute();
    await svc.start();
    stops.push(() => svc.stop());
    const r = await rawRequest(port, {
      Host: `evil.example:${port}`,
      'x-api-key': svc.authToken(),
    });
    expect(r.status).toBe(421);
  });

  it('缺少 / 错误令牌 → 401；Bearer 与 x-api-key 两种携带方式都被接受', async () => {
    const { svc, port } = await mkRoute();
    await svc.start();
    stops.push(() => svc.stop());
    expect((await rawRequest(port, {})).status).toBe(401);
    expect((await rawRequest(port, { 'x-api-key': 'nomi-route' })).status).toBe(401);
    expect((await rawRequest(port, { Authorization: 'Bearer wrong' })).status).toBe(401);
    // 令牌正确后才进入路由逻辑（这里没有上游 → 502 而不是 401）
    expect((await rawRequest(port, { 'x-api-key': svc.authToken() })).status).toBe(502);
    expect((await rawRequest(port, { Authorization: `Bearer ${svc.authToken()}` })).status).toBe(
      502,
    );
  });

  it('令牌随机、落盘（0600）并在重启后复用', async () => {
    const { svc, root } = await mkRoute({ enabled: false });
    expect(svc.authToken()).toMatch(/^nomi-route-[0-9a-f]{48}$/);
    const again = new CliRouteService({ root, logger: quiet, resolveUpstream: () => null });
    expect(again.authToken()).toBe(svc.authToken());
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, 'routing.token')).mode & 0o777).toBe(0o600);
    }
    const other = (await mkRoute({ enabled: false })).svc;
    expect(other.authToken()).not.toBe(svc.authToken());
  });

  it('stop() 会断开 keep-alive 空闲连接', async () => {
    const { svc, port } = await mkRoute();
    await svc.start();
    const agent = new http.Agent({ keepAlive: true });
    const r = await rawRequest(
      port,
      { 'x-api-key': svc.authToken() },
      { method: 'GET', path: '/health', agent },
    );
    expect(r.status).toBe(200);
    const sockets = Object.values(agent.freeSockets).flat();
    expect(sockets.length).toBeGreaterThan(0);
    const closed = Promise.all(
      sockets.map((s) => new Promise<void>((res) => s!.once('close', () => res()))),
    );
    svc.stop();
    await closed; // 若 keep-alive 连接没被销毁，这里会一直挂起直到 jest 超时
    agent.destroy();
  });
});
