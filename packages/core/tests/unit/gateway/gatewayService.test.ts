jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import {
  allowTagOf,
  setCatalogOverlay,
  type detect,
  type GatewayConfig,
  type WorkerInbound,
  type WorkerOutbound,
} from '@nomi-ai/gateway';

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
  o: {
    routeListening?: boolean;
    legacyNomi?: unknown;
    detectImpl?: typeof detect;
    port?: number;
  } = {},
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
    ...(o.port !== undefined ? { port: o.port } : {}),
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

  it('privacy mode is on by default, the key survives restarts, and can be turned off', () => {
    const t = setup();
    t.svc.init();
    const first = t.lastConfig().privacy!;
    expect(first.enabled).toBe(true);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(t.svc.state().privacyMode).toBe(true);
    const file = path.join(t.root, 'gateway', 'store.json');
    // 存储里只有加密后的密钥，没有 privacyMode 字段（默认开）
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.privacyMode).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain(first.key);

    expect(t.svc.setOptions({ privacyMode: false }).privacyMode).toBe(false);
    expect(t.lastConfig().privacy).toEqual({ enabled: false, key: first.key });
    t.svc.setOptions({ privacyMode: 'no' });
    expect(t.lastConfig().privacy!.enabled).toBe(false);
    t.svc.setOptions({ privacyMode: true });
    expect(t.lastConfig().privacy!.enabled).toBe(true);
    expect(
      (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).privacyMode,
    ).toBeUndefined();

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
    expect(again.runtimeConfig().privacy!.key).toBe(first.key);
  });

  it('privacy settings: per-kind actions, custom secrets and the never-mask list reach the snapshot', () => {
    const t = setup();
    t.svc.init();
    const file = path.join(t.root, 'gateway', 'store.json');

    t.svc.setPrivacyAction('PRIVATE_KEY', 'block');
    t.svc.setPrivacyAction('API_KEY', 'warn');
    t.svc.setPrivacyAction('API_KEY', 'mask');
    expect(t.lastConfig().privacy!.actions).toEqual({ PRIVATE_KEY: 'block' });
    expect(() => t.svc.setPrivacyAction('EMAIL', 'block')).toThrow();
    expect(() => t.svc.setPrivacyAction('TOKEN', 'drop')).toThrow();

    const v = t.svc.addPrivacySecret({ name: '公司内网', value: 'corp-internal-token-42' });
    expect(v.privacy.secrets).toEqual([
      { id: expect.any(String), name: '公司内网', masked: expect.any(String) },
    ]);
    expect(t.lastConfig().privacy!.known).toEqual([
      { kind: 'CUSTOM', value: 'corp-internal-token-42' },
    ]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('corp-internal-token-42');
    expect(() => t.svc.addPrivacySecret({ name: 'x', value: 'short' })).toThrow();
    expect(() =>
      t.svc.addPrivacySecret({ name: 'again', value: 'corp-internal-token-42' }),
    ).toThrow();

    // 手动放行给原文：只存标记
    const key = t.lastConfig().privacy!.key;
    t.svc.addPrivacyAllow({ value: 'sk-test-not-a-real-key-123456' });
    t.svc.addPrivacyAllow({ tag: 'abcdefgh', kind: 'API_KEY', len: 40, head: 'sk-p' });
    t.svc.addPrivacyAllow({ tag: 'abcdefgh', kind: 'API_KEY', len: 40, head: 'sk-p' });
    expect(t.lastConfig().privacy!.allow).toEqual([
      allowTagOf(key, 'sk-test-not-a-real-key-123456'),
      'abcdefgh',
    ]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-test-not-a-real-key-123456');
    expect(() => t.svc.addPrivacyAllow({ tag: 'NOT-A-TAG' })).toThrow();

    const id = t.svc.state().privacy.secrets[0]!.id;
    t.svc.removePrivacySecret(id);
    t.svc.removePrivacyAllow('abcdefgh');
    t.svc.setPrivacyAction('PRIVATE_KEY', 'mask');
    const p = t.lastConfig().privacy!;
    expect(p.known).toBeUndefined();
    expect(p.actions).toBeUndefined();
    expect(p.allow).toHaveLength(1);
  });

  it('privacy sub-switches (strict / local / shape) default off and reach the snapshot', () => {
    const t = setup();
    t.svc.init();
    const p0 = t.lastConfig().privacy!;
    expect([p0.strict, p0.local, p0.shape]).toEqual([undefined, undefined, undefined]);
    expect(t.svc.state().privacy).toMatchObject({ strict: false, local: false, shape: false });
    t.svc.setOptions({ privacyStrict: true, privacyLocal: true, privacyShape: true });
    expect(t.lastConfig().privacy).toMatchObject({ strict: true, local: true, shape: true });
    t.svc.setOptions({ privacyShape: false, privacyLocal: 'yes' });
    expect(t.lastConfig().privacy).toMatchObject({ strict: true, local: true });
    expect(t.lastConfig().privacy!.shape).toBeUndefined();
  });

  it('privacy preview uses the current settings and known secrets without touching the gateway', () => {
    const t = setup();
    t.svc.init();
    t.svc.addPrivacySecret({ name: 'db', value: 'corp-internal-token-42' });
    t.svc.setPrivacyAction('CUSTOM', 'warn');
    const r = t.svc.previewPrivacy(
      'k sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv and corp-internal-token-42',
    );
    expect(r.text).not.toContain('sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv');
    expect(r.text).toContain('corp-internal-token-42');
    expect(r.hits.map((h) => [h.kind, h.action])).toEqual([
      ['API_KEY', 'mask'],
      ['CUSTOM', 'warn'],
    ]);
    expect(t.svc.previewPrivacy(42).text).toBe('');
  });

  it('privacy log aggregates hits from usage events by placeholder', () => {
    const t = setup();
    t.svc.init();
    const hit = {
      kind: 'API_KEY',
      placeholder: '{{API_KEY_abcdefgh}}',
      action: 'mask' as const,
      len: 40,
      head: 'sk-p',
      masked: 1,
      restored: 1,
      allowTag: 'zzzzzzzz',
    };
    t.svc.notePrivacy({ client: 'claude', redactions: [hit] } as never);
    t.svc.notePrivacy({ client: 'nomi', redactions: [{ ...hit, restored: 0 }] } as never);
    t.svc.notePrivacy({ client: 'nomi' } as never);
    expect(t.svc.privacyLogEntries()).toEqual([
      expect.objectContaining({
        placeholder: '{{API_KEY_abcdefgh}}',
        requests: 2,
        masked: 2,
        restored: 1,
        clients: ['claude', 'nomi'],
      }),
    ]);
  });

  it('uses a temporary port while the legacy route still holds the port', () => {
    const t = setup({ routeListening: true });
    t.svc.init();
    expect(t.lastConfig().port).toBe(0);
  });

  it('a host port override applies to this run only and is not written back', () => {
    const t = setup({ port: 0 });
    t.svc.init();
    expect(t.lastConfig().port).toBe(0);
    const stored = JSON.parse(fs.readFileSync(path.join(t.root, 'gateway', 'store.json'), 'utf8'));
    expect(stored.port).toBe(18721);
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
    expect(t.broadcasts).toContain('gateway.changed');
    t.svc.removeProvider('relay');
    expect(t.lastConfig().providers).toEqual([]);
  });

  it('merges URL patches, places new keys among saved keys and detects both kinds', async () => {
    const probe = jest.fn(async () => ({ wires: {}, byKey: {}, models: [], urls: {} }));
    const t = setup({ detectImpl: probe });
    t.svc.init();
    const p = t.svc.upsertProvider({
      name: 'Relay',
      urls: { chat: 'https://relay.example/v1', messages: 'https://relay.example/anthropic' },
      newKeys: [{ value: 'sk-a' }, { value: 'sk-b' }],
    });
    t.svc.upsertProvider({
      id: p.id,
      name: p.name,
      urls: { chat: ' https://new.example/v1 ' },
      keys: [
        { id: p.keys[1]!.id, enabled: true },
        { id: p.keys[0]!.id, enabled: false },
      ],
      newKeys: [{ value: 'sk-new', position: 0 }],
    });
    expect(t.lastConfig().providers[0]!.urls).toEqual({
      chat: 'https://new.example/v1',
      messages: 'https://relay.example/anthropic',
    });
    expect(
      t.svc.store.providers()[0]!.keys.map((k) => t.svc.store.decrypt(k.enc, k.encryption)),
    ).toEqual(['sk-new', 'sk-b', 'sk-a']);
    await t.svc.detect({ providerId: p.id, savedKeyIds: [p.keys[1]!.id], keys: [' sk-draft '] });
    expect(probe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keys: [
          { id: p.keys[1]!.id, value: 'sk-b' },
          { id: 'new-0', value: 'sk-draft' },
        ],
      }),
    );
    t.svc.upsertProvider({ id: p.id, name: p.name, urls: { messages: '' } });
    expect(t.lastConfig().providers[0]!.urls).toEqual({ chat: 'https://new.example/v1' });
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

  it('helperRoute：编程助手的辅助档 → Haiku 档 → 标签模型 → 主模型，取第一个能路由的', async () => {
    const t = setup();
    t.svc.init();
    t.svc.upsertProvider({
      name: 'DS',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-d' }],
      models: [
        { id: 'deepseek-v4-flash', enabled: true },
        { id: 'deepseek-v4-pro', enabled: true },
      ],
    });
    expect(t.svc.helperRoute('claude', 'ds/deepseek-v4-pro')).toBeNull(); // 网关还没就绪
    t.children[0]!.say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
    await t.svc.whenReady(100);
    // 客户端什么都没设：用标签选的模型
    expect(t.svc.helperRoute('claude', 'ds/deepseek-v4-pro')).toEqual({
      model: 'ds/deepseek-v4-pro',
      receiver: { id: 'ds', name: 'DS', local: false },
    });
    // 设了 Haiku 档：优先用它（更便宜）；路由不了的引用跳过
    t.svc.setAssignment('claude', {
      models: { main: 'ds/deepseek-v4-pro', tiers: { haiku: 'ds/deepseek-v4-flash' } },
    });
    expect(t.svc.helperRoute('claude', 'nope/x')!.model).toBe('ds/deepseek-v4-flash');
    expect(t.svc.helperRoute('codex', null)).toBeNull();
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

  it('credentials skip keys restricted to another wire (#95)', () => {
    const t = setup();
    t.svc.init();
    const urls = { chat: 'https://c.example/v1', messages: 'https://m.example' };
    t.svc.upsertProvider({
      name: 'Mix',
      urls,
      newKeys: [
        { value: 'sk-msg', wire: 'messages' },
        { value: 'sk-chat', wire: 'chat' },
      ],
    });
    expect(t.svc.credentials('mix')?.apiKey).toBe('sk-chat');
    t.svc.upsertProvider({
      name: 'MsgOnly',
      urls,
      newKeys: [{ value: 'sk-msg', wire: 'messages' }],
    });
    expect(t.svc.credentials('msgonly')).toEqual({
      id: 'msgonly',
      name: 'MsgOnly',
      baseURL: 'https://c.example/v1',
    });
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

  it('a wire probe that finishes late does not revive cleared state or drop newer learning (#96)', async () => {
    const pending: Array<() => void> = [];
    const t = setup({
      detectImpl: (async () => {
        await new Promise<void>((r) => pending.push(r));
        return { wires: { chat: { ok: false } }, byKey: {}, models: [], urls: {} };
      }) as never,
    });
    t.svc.init();
    const input = {
      name: 'R',
      urls: { chat: 'https://r.example/v1' },
      newKeys: [{ value: 'sk-r' }],
      models: [{ id: 'glm-5', enabled: true }],
    };
    t.svc.upsertProvider(input);
    const suspect = { type: 'wire-suspect', providerId: 'r', wire: 'chat', reason: 'x' } as const;
    const learned = () => t.svc.state().providers.find((p) => p.id === 'r')!.learned;
    const settle = async (run: Promise<void>) => {
      while (!pending.length) await new Promise((r) => setTimeout(r, 1));
      pending.shift()!();
      await run;
    };

    // 1) 探测中清除学习：回来后不复活
    await t.svc.learn({ type: 'dropped-param', providerId: 'r', wire: 'chat', param: 'a' });
    let run = t.svc.learn(suspect);
    t.svc.clearLearned('r');
    await settle(run);
    expect(learned()).toBeUndefined();

    // 2) 探测中别的学习写进来：回来后保留
    run = t.svc.learn(suspect);
    await t.svc.learn({ type: 'dropped-param', providerId: 'r', wire: 'chat', param: 'b' });
    await settle(run);
    expect(learned()).toMatchObject({
      droppedParams: { chat: ['b'] },
      wireDown: { chat: { reason: 'x' } },
    });

    // 3) 探测中改了地址：旧地址的结论不写
    t.svc.clearLearned('r');
    run = t.svc.learn(suspect);
    t.svc.upsertProvider({ ...input, id: 'r', urls: { chat: 'https://r2.example/v1' } } as never);
    await settle(run);
    expect(learned()?.wireDown).toBeUndefined();
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

  it('model metadata (§12.7.2): user > preset > listed > built-in catalog > default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-meta-'));
    const svc = new GatewayService({
      root,
      cipher,
      logger: { info() {}, warn() {} },
      process: new GatewayProcess({
        logger: { info() {}, warn() {} },
        fork: () => new FakeChild() as never,
      }),
      presetModels: (id) =>
        id === 'zhipu' ? [{ id: 'glm-5.3', ctx: 777_000, maxOutput: 99_000 }] : undefined,
    });
    svc.init();
    // 中转（模型 id 带厂商前缀）、旧版本迁移来的「user」来源却没有值：按内置目录取
    svc.upsertProvider({
      name: 'Relay',
      urls: { chat: 'https://relay/v1' },
      models: [
        { id: 'openai/gpt-6-astra', enabled: true, metaSource: 'user' },
        { id: 'acme/unknown-model', enabled: true },
        { id: 'acme/listed-model', enabled: true, ctx: 300_000, metaSource: 'listed' },
        { id: 'openai/gpt-5.5', enabled: true, ctx: 64_000, metaSource: 'user' },
      ],
    });
    // 预设按去掉前缀后的 id 匹配，优先于目录
    svc.upsertProvider({
      name: 'ZP',
      presetId: 'zhipu',
      urls: { chat: 'https://zp/v1' },
      models: [{ id: 'z-ai/glm-5.3', enabled: true }],
    });
    const ref = (m: string) => svc.modelMetaOf(m)!;
    // 按长度分档计价的模型默认按标准窗口
    expect(ref('relay/openai/gpt-6-astra')).toMatchObject({ ctx: 272_000, source: 'catalog' });
    expect(ref('relay/acme/unknown-model')).toMatchObject({
      ctx: 128_000,
      maxOutput: 32_000,
      source: 'default',
    });
    expect(ref('relay/acme/listed-model')).toMatchObject({ ctx: 300_000, source: 'listed' });
    expect(ref('relay/openai/gpt-5.5')).toMatchObject({ ctx: 64_000, source: 'user' });
    expect(ref('zhipu/z-ai/glm-5.3')).toMatchObject({
      ctx: 777_000,
      maxOutput: 99_000,
      source: 'preset',
    });
    // 编程助手启动注入用同一份结果
    expect(svc.agentMeta('relay/openai/gpt-6-astra')).toMatchObject({
      ctx: 272_000,
      maxOutput: 128_000,
      reasoning: true,
      provider: 'Relay',
    });
    // 标签开启长上下文：注入最大输入
    expect(svc.agentMeta('relay/openai/gpt-6-astra', { longContext: true })!.ctx).toBe(922_000);

    // 网关快照：用户 / 预设 / 模型列表的值写进去，只来自目录的不写（网关自己读目录）
    const cfg = svc.runtimeConfig();
    const relay = cfg.providers.find((p) => p.id === 'relay')!;
    expect(relay.models.find((m) => m.id === 'openai/gpt-6-astra')!.ctx).toBeUndefined();
    expect(relay.models.find((m) => m.id === 'acme/listed-model')!.ctx).toBe(300_000);
    const zp = cfg.providers.find((p) => p.id === 'zhipu')!;
    expect(zp.models[0]).toMatchObject({ ctx: 777_000, maxOutput: 99_000 });

    // 「模型」页拿到生效值；回传保存时生效值不落盘
    const view = svc.state().providers.find((p) => p.id === 'relay')!;
    const astra = view.models.find((m) => m.id === 'openai/gpt-6-astra')!;
    expect(astra.effective).toMatchObject({
      ctx: 272_000,
      source: 'catalog',
      longContext: { standard: 272_000, full: 922_000, on: false },
    });
    svc.upsertProvider({ id: 'relay', name: 'Relay', urls: {}, models: view.models });
    const saved = svc.store.providers().find((p) => p.id === 'relay')!;
    expect(saved.models.some((m) => 'effective' in m)).toBe(false);
    expect(svc.cliModels().find((m) => m.ref === 'relay/openai/gpt-6-astra')!.ctx).toBe(272_000);
    // 模型默认开启长上下文（「模型」页的开关）会保存下来
    svc.upsertProvider({
      id: 'relay',
      name: 'Relay',
      urls: {},
      models: view.models.map((m) =>
        m.id === 'openai/gpt-6-astra' ? { ...m, longContext: true } : m,
      ),
    });
    expect(svc.modelMetaOf('relay/openai/gpt-6-astra')!.ctx).toBe(922_000);
  });

  it('models data sync (§12.7.2): synced catalog overlays the built-in one, survives a restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-catalog-'));
    const make = () => {
      const svc = new GatewayService({
        root,
        cipher,
        logger: { info() {}, warn() {} },
        process: new GatewayProcess({
          logger: { info() {}, warn() {} },
          fork: () => new FakeChild() as never,
        }),
      });
      svc.init();
      return svc;
    };
    const api = (n: number) => ({
      openai: {
        models: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `sync-model-${i}`,
            { id: `sync-model-${i}`, limit: { context: 333_000, output: 9_000 }, tool_call: true },
          ]),
        ),
      },
    });
    const svc = make();
    svc.upsertProvider({
      name: 'Relay',
      urls: { chat: 'https://relay/v1' },
      models: [{ id: 'acme/sync-model-7', enabled: true }],
    });
    expect(svc.hasCatalogSync()).toBe(false);
    expect(svc.modelMetaOf('relay/acme/sync-model-7')).toMatchObject({ source: 'default' });
    // 条目明显过少：视为异常响应，不采用
    await svc.applyModelsData(api(5));
    expect(svc.hasCatalogSync()).toBe(false);
    await svc.applyModelsData(api(150));
    expect(svc.hasCatalogSync()).toBe(true);
    expect(svc.modelMetaOf('relay/acme/sync-model-7')).toMatchObject({
      ctx: 333_000,
      source: 'catalog',
    });
    // 网关进程按文件路径自己读；内置目录里的模型仍查得到
    expect(svc.runtimeConfig().catalogFile).toBe(path.join(root, 'catalog-sync.json'));
    expect(svc.state().catalog).toMatchObject({ synced: true });
    expect(svc.modelMetaOf('relay/openai/gpt-5.2')?.ctx).toBe(272_000);
    // 重启后从文件恢复
    setCatalogOverlay(null);
    const again = make();
    expect(again.modelMetaOf('relay/acme/sync-model-7')?.ctx).toBe(333_000);
    setCatalogOverlay(null);
  });

  it('releaseAgent: removes the tab dir but does not follow symlinks into the user CLI home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-release-'));
    const svc = new GatewayService({
      root,
      cipher,
      logger: { info() {}, warn() {} },
      process: new GatewayProcess({
        logger: { info() {}, warn() {} },
        fork: () => new FakeChild() as never,
      }),
    });
    // 模拟 grok 私有 GROK_HOME：配置文件 + 指向用户 ~/.grok 条目的软链
    const agentDir = path.join(root, 'agents', 'grok', 'tab-1');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.toml'), 'x');
    const sentinel = path.join(root, 'user-real-file');
    fs.writeFileSync(sentinel, 'keep me');
    fs.symlinkSync(sentinel, path.join(agentDir, 'sessions-link'));

    svc.releaseAgent('grok', 'tab-1');

    expect(fs.existsSync(agentDir)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep me');
  });

  it('servedSession: reads the gateway session table for Claude sessions only (#90)', () => {
    const t = setup();
    fs.mkdirSync(path.join(t.root, 'gateway'), { recursive: true });
    fs.writeFileSync(
      path.join(t.root, 'gateway', 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [['claude:cc:s1', { providerId: 'p', keyId: 'k', wire: 'messages', at: 1 }]],
      }),
    );
    expect(t.svc.servedSession('claude', 's1')).toBe(true);
    expect(t.svc.servedSession('claude', 's2')).toBe(false);
    expect(t.svc.servedSession('codex', 's1')).toBe(false);
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
