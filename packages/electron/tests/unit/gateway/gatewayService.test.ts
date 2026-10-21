jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import type { detect, GatewayConfig, WorkerInbound, WorkerOutbound } from '@nomi-ai/gateway';

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

function setup(
  o: { routeListening?: boolean; legacyNomi?: unknown; detectImpl?: typeof detect } = {},
) {
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
    detectImpl: o.detectImpl,
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
    });
    expect(t.svc.state().providers[0]!.keys[0]!.name).toBeUndefined();
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

  it("routes Nomi chat roles through the gateway with each model's own wire", async () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'Relay',
      urls: { chat: 'https://r.example.com/v1', messages: 'https://r.example.com' },
      newKeys: [{ value: 'sk-r' }],
      models: [
        { id: 'claude-opus-5', enabled: true },
        { id: 'glm-5', enabled: true },
      ],
    });
    t.svc.upsertProvider({
      name: 'DS',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-d' }],
      models: [{ id: 'deepseek-v4-flash', enabled: true }],
    });
    t.svc.setAssignment('nomi', {
      models: { main: 'relay/claude-opus-5', summary: 'ds/deepseek-v4-flash' },
    });
    expect(t.svc.nomiRoute('chat')).toBeNull(); // 网关还没就绪
    t.children[0]!.say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
    await t.svc.whenReady(100);
    expect(t.svc.nomiRoute('chat')).toMatchObject({
      baseURL: 'http://127.0.0.1:18721',
      protocol: 'anthropic',
      model: 'relay/claude-opus-5',
      token: expect.stringMatching(/^nomi-gw-nomi-/),
    });
    expect(t.svc.nomiRoute('summary')).toMatchObject({
      baseURL: 'http://127.0.0.1:18721/v1',
      protocol: 'openai-chat',
      model: 'ds/deepseek-v4-flash',
    });
    // tools 没设：跟随 main
    expect(t.svc.nomiRoute('agent-tools')!.model).toBe('relay/claude-opus-5');
    t.svc.setAssignment('nomi', { models: { main: 'relay/glm-5' } });
    expect(t.svc.nomiRoute('chat')).toMatchObject({
      protocol: 'openai-chat',
      model: 'relay/glm-5',
      // 工具结果的接收者是真正的上游
      receiver: { id: 'relay', baseURL: 'https://r.example.com/v1' },
    });
    // 「跟随对话」：null 清除
    t.svc.setAssignment('nomi', { models: { summary: null as unknown as string } });
    expect(t.svc.state().clients.nomi!.models).toEqual({ main: 'relay/glm-5' });
  });

  it('reports the real upstream for privacy checks, cloud wins over local fallbacks', () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'Cloud',
      urls: { chat: 'https://api.cloud.example/v1' },
      newKeys: [{ value: 'sk-c' }],
      models: [{ id: 'm', enabled: true }],
    });
    t.svc.confirmPrivateHost('127.0.0.1:11434');
    t.svc.upsertProvider({
      name: 'Ollama',
      presetId: 'ollama',
      urls: { chat: 'http://127.0.0.1:11434/v1' },
      models: [{ id: 'qwen3', enabled: true }],
      fallback: ['cloud/m'],
    });
    // 网关还没就绪也能回答「现在用的是谁」
    t.svc.setAssignment('nomi', { models: { main: 'cloud/m' } });
    expect(t.svc.nomiProvider('chat')).toEqual({
      id: 'cloud',
      name: 'Cloud',
      baseURL: 'https://api.cloud.example/v1',
      model: 'm',
    });
    // 首选是本机，但回退到云端：按云端算
    t.svc.setAssignment('nomi', { models: { main: 'ollama/qwen3' } });
    expect(t.svc.nomiProvider('chat')).toMatchObject({
      id: 'ollama',
      model: 'qwen3',
      baseURL: 'https://api.cloud.example/v1',
    });
    expect(t.svc.providerInfo('ollama')).toEqual({
      id: 'ollama',
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
    });
    expect(t.svc.providerInfo('nope')).toBeNull();
    // 没有 Key 的本地服务在快照里有一个空 Key（否则路由找不到候选）
    expect(t.lastConfig().providers.find((p) => p.id === 'ollama')!.keys).toEqual([
      { id: 'none', value: '', enabled: true },
    ]);
  });

  it('credentials for embeddings / ASR come from the Chat address, keys never leave the main process', () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'DS',
      urls: { chat: 'https://api.deepseek.com/v1', messages: 'https://api.deepseek.com/anthropic' },
      newKeys: [{ value: 'sk-ds' }],
    });
    t.svc.upsertProvider({ name: 'OnlyMsg', urls: { messages: 'https://m.example' } });
    expect(t.svc.listOpenAiCompatible()).toEqual([
      { id: 'ds', name: 'DS', baseURL: 'https://api.deepseek.com/v1' },
    ]);
    expect(t.svc.credentials('ds')).toEqual({
      id: 'ds',
      name: 'DS',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    });
    expect(t.svc.credentials('onlymsg')).toBeNull();
  });

  it('notifies in-process listeners on changes', () => {
    const t = setup();
    t.svc.init();
    const fn = jest.fn();
    const off = t.svc.onChange(fn);
    t.svc.upsertProvider({ name: 'X', urls: { chat: 'https://x.example/v1' } });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    t.svc.removeProvider('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('persists what the gateway learns; a suspect wire is confirmed by a probe first', async () => {
    let probeOk = true;
    const probes: unknown[] = [];
    const t = setup({
      detectImpl: (async (o: unknown) => {
        probes.push(o);
        return { wires: { chat: { ok: probeOk } }, byKey: {}, models: [], urls: {} };
      }) as never,
    });
    t.svc.init();
    t.svc.upsertProvider({
      name: 'R',
      urls: {
        chat: 'https://r.example/v1',
        responses: 'https://r.example/v1',
        messages: 'https://r.example',
      },
      newKeys: [{ value: 'sk-r' }],
      models: [{ id: 'glm-5', enabled: true }],
    });
    await t.svc.learn({ type: 'dropped-param', providerId: 'r', wire: 'chat', param: 'store' });
    await t.svc.learn({ type: 'dropped-param', providerId: 'r', wire: 'chat', param: 'store' });
    await t.svc.learn({
      type: 'model-wire',
      providerId: 'r',
      model: 'glm-5',
      exclude: 'responses',
    });
    expect(t.lastConfig().learned!.r).toEqual({
      droppedParams: { chat: ['store'] },
      modelWire: { 'glm-5': ['chat', 'messages'] },
    });
    // 探测还能通：不写 wireDown
    await t.svc.learn({ type: 'wire-suspect', providerId: 'r', wire: 'chat', reason: 'x' });
    expect(probes[0]).toMatchObject({
      bases: { chat: 'https://r.example/v1' },
      keys: [{ value: 'sk-r' }],
    });
    expect(t.lastConfig().learned!.r!.wireDown).toBeUndefined();
    probeOk = false;
    await t.svc.learn({
      type: 'wire-suspect',
      providerId: 'r',
      wire: 'chat',
      reason: '3 次接口不存在',
    });
    expect(t.lastConfig().learned!.r!.wireDown!.chat).toMatchObject({ reason: '3 次接口不存在' });
    // 界面能看到，并且可以清除
    expect(t.svc.state().providers[0]!.learned).toBeDefined();
    t.svc.clearLearned('r');
    expect(t.svc.state().providers[0]!.learned).toBeUndefined();
  });

  it('records key status from the gateway on the key, clears it on recovery', () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'R',
      urls: { chat: 'https://r/v1' },
      newKeys: [{ value: 'sk-1' }],
    });
    const key = t.svc.state().providers[0]!.keys[0]!;
    const pushes = t.children[0]!.sent.length;
    t.svc.keyStatus({
      providerId: 'r',
      keyId: key.id,
      wire: 'chat',
      status: 'auth',
      error: 'invalid key',
    });
    expect(t.svc.state().providers[0]!.keys[0]!.lastError).toBe('Chat 鉴权失败：invalid key');
    // 只落盘、通知界面，不重推配置
    expect(t.children[0]!.sent.length).toBe(pushes);
    t.svc.keyStatus({ providerId: 'r', keyId: key.id, wire: 'chat', status: 'ok' });
    expect(t.svc.state().providers[0]!.keys[0]!.lastError).toBeUndefined();
  });

  it('fills preset quirks into the runtime snapshot; saved quirks win', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-quirks-'));
    const svc = new GatewayService({
      root,
      cipher,
      logger: { info() {}, warn() {} },
      process: new GatewayProcess({
        logger: { info() {}, warn() {} },
        fork: () => new FakeChild() as never,
      }),
      presetQuirks: (id) =>
        id === 'minimax'
          ? { extraBody: { chat: { reasoning_split: true } }, dropParams: ['a'] }
          : undefined,
    });
    svc.init();
    svc.upsertProvider({
      name: 'MM',
      presetId: 'minimax',
      urls: { chat: 'https://m/v1' },
      quirks: { dropParams: ['b'] },
    });
    const p = svc.runtimeConfig().providers[0]!;
    expect(p.quirks).toEqual({ extraBody: { chat: { reasoning_split: true } }, dropParams: ['b'] });
  });

  it('env providers: read-only in state, in the snapshot, default for Nomi chat, local URLs allowed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-env-'));
    const children: FakeChild[] = [];
    const svc = new GatewayService({
      root,
      cipher,
      logger: { info() {}, warn() {} },
      process: new GatewayProcess({
        logger: { info() {}, warn() {} },
        fork: () => {
          const c = new FakeChild();
          children.push(c);
          return c as never;
        },
      }),
      envProviders: () => [
        {
          id: 'deepseek',
          name: 'DeepSeek（环境变量）',
          wire: 'chat',
          url: 'https://api.deepseek.com/v1',
          key: 'sk-env-secret-1234',
          keyEnv: 'DEEPSEEK_API_KEY',
          model: 'deepseek-v4-pro',
        },
        {
          id: 'ollama',
          name: 'Ollama（环境变量）',
          wire: 'chat',
          url: 'http://127.0.0.1:11434/v1',
          model: 'qwen3',
        },
      ],
    });
    svc.init();
    const view = svc.state();
    const env = view.providers.find((p) => p.id === 'env-deepseek')!;
    expect(env).toMatchObject({
      source: 'env',
      keys: [{ masked: 'sk-…1234', name: 'DEEPSEEK_API_KEY' }],
    });
    expect(JSON.stringify(view)).not.toContain('sk-env-secret-1234');
    const cfg = (children[0]!.sent.at(-1) as { config: GatewayConfig }).config;
    expect(cfg.providers.map((p) => p.id)).toEqual(['env-deepseek', 'env-ollama']);
    expect(cfg.providers[0]!.keys[0]!.value).toBe('sk-env-secret-1234');
    expect(cfg.allowedPrivateHosts).toContain('127.0.0.1:11434');
    // 没给 Nomi 对话分配模型：用第一个环境变量供应商
    expect(svc.nomiProvider('chat')).toMatchObject({
      id: 'env-deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(svc.cliModels().map((m) => m.ref)).toEqual([
      'env-deepseek/deepseek-v4-pro',
      'env-ollama/qwen3',
    ]);
  });
});
