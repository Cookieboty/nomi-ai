jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SecretCipher } from '@nomi-ai/ai-runtime';
import {
  hashTabToken,
  isTabToken,
  type BindingMessage,
  type GatewayConfig,
  type WorkerInbound,
  type WorkerOutbound,
} from '@nomi-ai/gateway';

import { GatewayProcess } from '../../../src/gateway/GatewayProcess';
import { GatewayService } from '../../../src/gateway/GatewayService';
import { TabTokens } from '../../../src/gateway/TabTokens';

const logger = { info() {}, warn() {} };

describe('TabTokens（§6.7 先登记、后启动）', () => {
  function mk(
    o: {
      up?: boolean;
      timeoutMs?: number;
      logger?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
    } = {},
  ) {
    const sent: BindingMessage[] = [];
    const tabs = new TabTokens({
      send: (m) => {
        if (o.up === false) return false;
        sent.push(m);
        return true;
      },
      logger: o.logger ?? logger,
      timeoutMs: o.timeoutMs ?? 200,
    });
    const ackLast = (ok = true) => {
      const m = sent.at(-1)!;
      tabs.onAck(
        ok ? { type: 'binding:ok', id: m.id } : { type: 'binding:error', id: m.id, message: 'bad' },
      );
    };
    return { tabs, sent, ackLast };
  }

  it('签 nomi-tab- 令牌，只把哈希发给网关；网关确认后才返回', async () => {
    const t = mk();
    let done = false;
    const p = t.tabs
      .register({ client: 'claude', tabId: 't1', models: { main: 'zp/glm' } })
      .then((r) => {
        done = true;
        return r;
      });
    await Promise.resolve();
    expect(done).toBe(false);
    const add = t.sent[0]!;
    expect(add.type).toBe('binding:add');
    t.ackLast();
    const r = await p;
    expect(isTabToken(r.token)).toBe(true);
    expect(r.generation).toBe(1);
    expect(add).toMatchObject({
      binding: { tokenHash: hashTabToken(r.token), client: 'claude', tabId: 't1', generation: 1 },
    });
    expect(JSON.stringify(t.sent)).not.toContain(r.token);
  });

  it('同一标签再登记是新代次，旧令牌随之作废；update 只改绑定；remove 作废', async () => {
    const t = mk();
    const p1 = t.tabs.register({ client: 'codex', tabId: 't', models: { main: 'a/b' } });
    t.ackLast();
    const r1 = await p1;
    const p2 = t.tabs.register({ client: 'codex', tabId: 't', models: { main: 'a/c' } });
    t.ackLast();
    const r2 = await p2;
    expect(r2.generation).toBe(2);
    expect(r2.token).not.toBe(r1.token);
    expect(t.sent.at(-1)).toMatchObject({ type: 'binding:remove', tokenHash: r1.tokenHash });
    const u = t.tabs.update({
      client: 'codex',
      tabId: 't',
      models: { main: 'a/d' },
      effort: 'high',
    });
    t.ackLast();
    await expect(u).resolves.toBe(true);
    expect(t.sent.at(-1)).toMatchObject({
      type: 'binding:update',
      binding: { tokenHash: r2.tokenHash, models: { main: 'a/d' }, effort: 'high' },
    });
    t.tabs.remove('codex', 't');
    expect(t.sent.at(-1)).toMatchObject({ type: 'binding:remove', tokenHash: r2.tokenHash });
    expect(t.tabs.has('codex', 't')).toBe(false);
    await expect(t.tabs.update({ client: 'codex', tabId: 't', models: {} })).resolves.toBe(false);
  });

  it('进程退出按代次作废：旧代次晚到的退出（新代次已登记、等确认中）不作废新令牌', async () => {
    const t = mk();
    const p1 = t.tabs.register({ client: 'grok', tabId: 't', models: { main: 'a/b' } });
    t.ackLast();
    await p1;
    // 回收后马上发下一条：第 2 代已在等网关确认，这时第 1 代的进程才退出
    const p2 = t.tabs.register({ client: 'grok', tabId: 't', models: { main: 'a/b' } });
    const before = t.sent.length;
    t.tabs.remove('grok', 't', 1);
    expect(t.sent.length).toBe(before);
    expect(t.tabs.has('grok', 't')).toBe(true);
    t.ackLast();
    const r2 = await p2;
    t.tabs.remove('grok', 't', 1);
    expect(t.tabs.has('grok', 't')).toBe(true);
    t.tabs.remove('grok', 't', r2.generation);
    expect(t.tabs.has('grok', 't')).toBe(false);
  });

  it('网关拒绝 / 超时 / 没在运行：reject，且不留下有效绑定', async () => {
    const t = mk();
    const p = t.tabs.register({ client: 'grok', tabId: 'x', models: {} });
    t.ackLast(false);
    await expect(p).rejects.toThrow();
    expect(t.tabs.has('grok', 'x')).toBe(false);
    await expect(
      mk({ timeoutMs: 10 }).tabs.register({ client: 'grok', tabId: 'x', models: {} }),
    ).rejects.toThrow();
    await expect(
      mk({ up: false }).tabs.register({ client: 'grok', tabId: 'x', models: {} }),
    ).rejects.toThrow();
  });

  it('网关进程重启后重新登记还活着的绑定，并等待 binding:ok', async () => {
    const t = mk();
    const p = t.tabs.register({ client: 'claude', tabId: 'a', models: {} });
    t.ackLast();
    await p;
    const before = t.sent.length;
    const replayed = t.tabs.replay();
    expect(t.sent.slice(before)).toEqual([expect.objectContaining({ type: 'binding:add' })]);
    t.ackLast();
    await expect(replayed).resolves.toBeUndefined();
  });

  it('replay 部分失败：allSettled 后仍 resolve，并记 warn', async () => {
    const warns: unknown[] = [];
    const t = mk({
      timeoutMs: 20,
      logger: {
        info() {},
        warn(m: string, d?: unknown) {
          warns.push([m, d]);
        },
      },
    });
    const p = t.tabs.register({ client: 'claude', tabId: 'a', models: {} });
    t.ackLast();
    await p;
    await expect(t.tabs.replay()).resolves.toBeUndefined();
    expect(warns.some((w) => String((w as unknown[])[0]).includes('partial failure'))).toBe(true);
  });
});

/* ------------------------------ GatewayService ------------------------------ */

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
  die(code = 1) {
    this.emit('exit', code);
  }
}

function service(env: NodeJS.ProcessEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tabs-'));
  const children: FakeChild[] = [];
  const proc = new GatewayProcess({
    logger,
    backoffMs: () => 1,
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c as never;
    },
  });
  const svc = new GatewayService({ root, cipher, logger, process: proc, env });
  svc.init();
  const child = () => children.at(-1)!;
  child().say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
  const lastConfig = () =>
    (
      child()
        .sent.filter((m) => m.type === 'config')
        .at(-1) as { config: GatewayConfig }
    ).config;
  return { svc, root, children, child, lastConfig };
}

describe('GatewayService：标签令牌、预设、Key 限流、严格模式、学习', () => {
  it('cliLaunchForTab：先登记绑定再给出启动注入，环境里是标签令牌而不是共享的客户端令牌', async () => {
    const t = service();
    t.svc.upsertProvider({
      name: 'ZP',
      urls: { chat: 'https://open.bigmodel.cn/api/paas/v4' },
      newKeys: [{ value: 'sk-zp-1234567890' }],
      models: [{ id: 'glm-5', enabled: true }],
    });
    const shared = t.svc.endpoint('claude')!.token;
    const p = t.svc.cliLaunchForTab('claude', 'tab-1', 'zp/glm-5', 'high');
    await new Promise((r) => setImmediate(r));
    const add = t.child().sent.find((m) => m.type === 'binding:add') as Extract<
      BindingMessage,
      { type: 'binding:add' }
    >;
    expect(add.binding).toMatchObject({
      client: 'claude',
      tabId: 'tab-1',
      generation: 1,
      effort: 'high',
      models: { main: 'zp/glm-5' },
    });
    t.child().say({ type: 'binding:ok', id: add.id });
    const launch = (await p)!;
    const token = launch.env.ANTHROPIC_AUTH_TOKEN!;
    expect(isTabToken(token)).toBe(true);
    expect(hashTabToken(token)).toBe(add.binding.tokenHash);
    expect(JSON.stringify(launch)).not.toContain(shared);
    // 网关进程重启：绑定重新登记
    t.child().die();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.children).toHaveLength(2);
    expect(t.child().sent.map((m) => m.type)).toEqual(['config', 'binding:add']);
    t.svc.releaseTab('claude', 'tab-1');
    expect(t.child().sent.at(-1)).toMatchObject({ type: 'binding:remove' });
  });

  it('Grok 按标签令牌启动：同步与异步两条路径都写占位模型名，后写的不会把真实模型名覆盖回来', async () => {
    const t = service();
    t.svc.upsertProvider({
      name: 'DS',
      urls: { responses: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-ds-1234567890' }],
      models: [{ id: 'deepseek-v4.1-flash', enabled: true }],
    });
    const cfg = () =>
      fs.readFileSync(path.join(t.root, 'agents', 'grok', 'tab-g', 'config.toml'), 'utf8');
    const p = t.svc.cliLaunchForTab('grok', 'tab-g', 'ds/deepseek-v4.1-flash');
    await new Promise((r) => setImmediate(r));
    const add = t.child().sent.find((m) => m.type === 'binding:add') as { id: string };
    t.child().say({ type: 'binding:ok', id: add.id });
    expect((await p)!.modelInConfig).toBe(false);
    expect(cfg()).toContain('model = "nomi"');
    // 编排器随后用同步路径重算复用键（按标签令牌启动的标签带 tabBound）：配置保持占位名
    expect(
      t.svc.cliLaunch('grok', 'tab-g', 'ds/deepseek-v4.1-flash', { tabBound: true })!.modelInConfig,
    ).toBe(false);
    expect(cfg()).toContain('model = "nomi"');
    expect(cfg()).not.toContain('deepseek-v4.1-flash');
    // 不按标签令牌启动（终端命令等共享令牌）：仍写真实模型名
    t.svc.cliLaunch('grok', 'tab-g', 'ds/deepseek-v4.1-flash');
    expect(cfg()).toContain('model = "ds/deepseek-v4.1-flash"');
  });

  it('运行时快照带预设 id、Key 的并发 / 每分钟请求数、严格模式；路由计划默认 active，可用环境变量回滚 shadow', () => {
    const t = service();
    const v = t.svc.upsertProvider({
      name: 'DeepSeek',
      presetId: 'deepseek',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-ds-1234567890', maxConcurrency: 2, rpm: 60 }],
    });
    let p = t.lastConfig().providers.find((x) => x.id === v.id)!;
    expect(p.preset).toBe('deepseek');
    expect(p.keys[0]).toMatchObject({ maxConcurrency: 2, rpm: 60 });
    expect(t.lastConfig().routePlan).toBe('active');
    expect(service({ NOMI_ROUTE_PLAN: 'shadow' }).lastConfig().routePlan).toBe('shadow');
    expect(t.lastConfig().strictParams).toBeUndefined();
    // 清掉限流（null / 非法值）
    t.svc.upsertProvider({
      id: v.id,
      name: 'DeepSeek',
      urls: v.urls,
      keys: [{ id: v.keys[0]!.id, enabled: true, maxConcurrency: null, rpm: -1 }],
    });
    p = t.lastConfig().providers.find((x) => x.id === v.id)!;
    expect(p.keys[0]!.maxConcurrency).toBeUndefined();
    expect(p.keys[0]!.rpm).toBeUndefined();
    expect(t.svc.setOptions({ strictParams: true }).strictParams).toBe(true);
    expect(t.lastConfig().strictParams).toBe(true);
    expect(t.svc.setOptions({ strictParams: false }).strictParams).toBe(false);
    expect(t.lastConfig().strictParams).toBeUndefined();
  });

  it('学到的思考档位写进 learned.models 并随快照带回；不认识的学习类型被忽略', async () => {
    const t = service();
    const v = t.svc.upsertProvider({ name: 'K', urls: { chat: 'https://k.example/v1' } });
    await t.svc.learn({
      type: 'model-efforts',
      providerId: v.id,
      model: 'kimi-k3',
      efforts: ['low', 'high', 'bogus' as never],
      at: 123,
      catalogVersion: '2026-10-01',
    });
    expect(t.lastConfig().learned?.[v.id]?.models?.['kimi-k3']).toEqual({
      at: 123,
      catalogVersion: '2026-10-01',
      efforts: ['low', 'high'],
    });
    expect(t.svc.state().providers.find((x) => x.id === v.id)?.learned).toBeTruthy();
    const before = JSON.stringify(t.lastConfig().learned);
    await t.svc.learn({ type: 'something-new', providerId: v.id } as never);
    expect(JSON.stringify(t.lastConfig().learned)).toBe(before);
  });
});
