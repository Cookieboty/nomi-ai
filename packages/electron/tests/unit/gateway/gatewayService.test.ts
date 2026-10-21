jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import type { GatewayConfig, WorkerInbound, WorkerOutbound } from '@nomi-ai/gateway';

import { GatewayProcess } from '../../../src/gateway/GatewayProcess';
import { GatewayService } from '../../../src/gateway/GatewayService';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const cipher: SecretCipher = {
  kind: 'none',
  encrypt: b64,
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};

class FakeChild extends EventEmitter {
  sent: WorkerInbound[] = [];
  postMessage(m: WorkerInbound) {
    this.sent.push(m);
  }
  kill() {
    return true;
  }
  say(m: WorkerOutbound) {
    this.emit('message', m);
  }
}

function setup(o: { routeListening?: boolean; legacyNomi?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-svc-'));
  const nomiFile = path.join(root, 'ai-providers.json');
  if (o.legacyNomi) fs.writeFileSync(nomiFile, JSON.stringify(o.legacyNomi));
  const children: FakeChild[] = [];
  const broadcasts: string[] = [];
  const proc = new GatewayProcess({
    logger: { info() {}, warn() {} },
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c as never;
    },
  });
  const svc = new GatewayService({
    root: path.join(root, 'gateway'),
    cipher,
    logger: { info() {}, warn() {} },
    process: proc,
    legacy: {
      nomiFile,
      cliRoot: path.join(root, 'cli-providers'),
      cliDecrypt: (e) => Buffer.from(e, 'base64').toString('utf8'),
      normalizeNomi: (raw) => raw as unknown as ProviderStoreData,
      token: () => 'nomi-route-legacy',
      routeListening: () => Boolean(o.routeListening),
    },
    broadcast: (ch) => broadcasts.push(ch),
  });
  const lastConfig = () =>
    (
      children
        .at(-1)!
        .sent.filter((m) => m.type === 'config')
        .at(-1) as { config: GatewayConfig }
    ).config;
  return { root, svc, children, broadcasts, lastConfig };
}

describe('GatewayService', () => {
  it('migrates once on first start, creates client tokens and pushes the snapshot', () => {
    const t = setup({
      legacyNomi: {
        version: 2,
        activeProviderId: 'p1',
        routes: {},
        usage: {},
        providers: [
          {
            id: 'p1',
            presetId: 'deepseek',
            name: 'DeepSeek',
            protocol: 'openai-chat',
            baseURL: 'https://api.deepseek.com/v1',
            fullUrl: false,
            defaultModel: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro'],
            enabled: true,
            keys: [{ id: 'k', secret: b64('sk-1'), encryption: 'none', masked: '', createdAt: 1 }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    t.svc.init();
    const cfg = t.lastConfig();
    expect(cfg.providers.map((p) => p.id)).toEqual(['deepseek']);
    expect(cfg.clients.nomi).toMatchObject({ models: { main: 'deepseek/deepseek-v4-pro' } });
    expect(cfg.legacyToken).toBe('nomi-route-legacy');
    expect(cfg.port).toBe(18721);
    // 第二次启动不再迁移
    const again = new GatewayService({
      root: path.join(t.root, 'gateway'),
      cipher,
      logger: { info() {}, warn() {} },
      process: new GatewayProcess({
        logger: { info() {}, warn() {} },
        fork: () => new FakeChild() as never,
      }),
    });
    again.init();
    expect(again.state().providers).toHaveLength(1);
  });

  it('uses a temporary port while the legacy route still holds the port', () => {
    const t = setup({ routeListening: true });
    t.svc.init();
    expect(t.lastConfig().port).toBe(0);
  });

  it('state never exposes key material or tokens', () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'Kimi',
      presetId: 'kimi',
      urls: { messages: 'https://api.moonshot.cn/anthropic' },
      newKeys: [{ value: 'sk-secret-kimi-123456' }],
    });
    const view = JSON.stringify(t.svc.state());
    expect(view).not.toContain('sk-secret-kimi-123456');
    expect(view).not.toContain(b64('sk-secret-kimi-123456'));
    expect(view).not.toMatch(/nomi-gw-/);
    expect(t.svc.state().providers[0]!.keys[0]).toMatchObject({
      masked: 'sk-…3456',
      decryptable: true,
      name: '主 Key',
    });
  });

  it('upserts providers (new keys, reorder, delete), pushes configs and broadcasts', () => {
    const t = setup();
    t.svc.init();
    const p = t.svc.upsertProvider({
      name: 'Relay',
      urls: { chat: 'https://relay.example.com/v1', responses: '' },
      newKeys: [{ value: 'sk-a' }, { value: 'sk-b' }],
      models: [{ id: 'glm-5', enabled: true }],
    });
    expect(p.id).toBe('relay');
    expect(p.urls).toEqual({ chat: 'https://relay.example.com/v1' });
    expect(t.lastConfig().providers[0]!.keys.map((k) => k.value)).toEqual(['sk-a', 'sk-b']);
    // 调换顺序并删掉一个
    const [a, b] = p.keys;
    t.svc.upsertProvider({
      id: 'relay',
      name: 'Relay',
      urls: p.urls,
      keys: [{ id: b!.id, enabled: true }],
      newKeys: [{ value: 'sk-c' }],
    });
    expect(t.lastConfig().providers[0]!.keys.map((k) => k.value)).toEqual(['sk-b', 'sk-c']);
    expect(a).toBeDefined();
    expect(t.broadcasts).toContain('ai:gateway:changed');
    t.svc.removeProvider('relay');
    expect(t.lastConfig().providers).toEqual([]);
  });

  it('assignments, token reset and the endpoint for in-process callers', async () => {
    const t = setup();
    t.svc.init();
    t.svc.setAssignment('claude', { models: { main: 'zp/glm-5' }, newTabSource: 'thirdParty' });
    expect(t.svc.state().clients.claude).toEqual({
      models: { main: 'zp/glm-5' },
      newTabSource: 'thirdParty',
    });
    const before = t.lastConfig().clients.claude!.token;
    t.svc.resetToken('claude');
    expect(t.lastConfig().clients.claude!.token).not.toBe(before);
    expect(t.svc.endpoint('nomi')).toBeNull();
    t.children[0]!.say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
    await expect(t.svc.whenReady(100)).resolves.toBe(true);
    expect(t.svc.endpoint('nomi')).toMatchObject({
      url: 'http://127.0.0.1:18721',
      token: expect.stringMatching(/^nomi-gw-nomi-/),
    });
    expect(() => t.svc.confirmPrivateHost('not a host')).toThrow();
    t.svc.confirmPrivateHost('127.0.0.1:11434');
    expect(t.lastConfig().allowedPrivateHosts).toEqual(['127.0.0.1:11434']);
  });
});
