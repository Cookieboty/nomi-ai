jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';

import { GatewayStore } from '../../../src/gateway/GatewayStore';
import { legacyBase, migrateLegacy } from '../../../src/gateway/migrate';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const plaintextCipher: SecretCipher = {
  kind: 'none',
  encrypt: b64,
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};
// 测试数据已经是 v2，直接用
const normalizeNomi = (raw: Record<string, unknown>) => raw as unknown as ProviderStoreData;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-migrate-'));
  const nomiFile = path.join(root, 'ai-providers.json');
  const cliRoot = path.join(root, 'cli-providers');
  fs.writeFileSync(
    nomiFile,
    JSON.stringify({
      version: 2,
      activeProviderId: 'p-deepseek-1',
      routes: { summary: { providerId: 'p-kimi-1', model: 'kimi-k3-turbo' } },
      usage: {},
      providers: [
        {
          id: 'p-deepseek-1',
          presetId: 'deepseek',
          name: 'DeepSeek',
          protocol: 'openai-chat',
          baseURL: 'https://api.deepseek.com/v1',
          fullUrl: false,
          defaultModel: 'deepseek-v4-pro',
          models: ['deepseek-v4-pro'],
          fetchedModels: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
          enabled: true,
          keys: [
            { id: 'k1', secret: b64('sk-ds-1'), encryption: 'none', masked: '', createdAt: 1 },
            { id: 'k2', secret: b64('sk-ds-2'), encryption: 'none', masked: '', createdAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'p-kimi-1',
          presetId: 'kimi',
          name: 'Kimi',
          protocol: 'anthropic',
          baseURL: 'https://api.moonshot.cn/anthropic/v1/messages',
          fullUrl: true,
          defaultModel: 'kimi-k3',
          models: ['kimi-k3', 'kimi-k3-turbo'],
          modelMap: [{ from: 'kimi-k3', to: 'kimi-k3-0901' }],
          enabled: true,
          keys: [
            { id: 'k3', secret: b64('sk-kimi'), encryption: 'none', masked: '', createdAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  const cli = (kind: string, profiles: unknown[]) => {
    fs.mkdirSync(path.join(cliRoot, kind), { recursive: true });
    fs.writeFileSync(path.join(cliRoot, kind, 'store.json'), JSON.stringify({ profiles }));
  };
  // 同一个 DeepSeek Key 在 Claude Code 里用的是 Anthropic 入口：应并进同一个供应商
  cli('claude', [
    {
      id: 'c1',
      kind: 'claude',
      name: 'DS for Claude',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      apiFormat: 'anthropic_messages',
      keyEnc: b64('sk-ds-2'),
      active: true,
      presetId: 'deepseek',
    },
  ]);
  cli('codex', [
    {
      id: 'x1',
      kind: 'codex',
      name: 'Relay',
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-6-sol',
      apiFormat: 'openai_responses',
      keyEnc: b64('sk-relay'),
      active: true,
    },
    {
      id: 'x2',
      kind: 'codex',
      name: 'Unused',
      baseUrl: 'https://other.example.com/v1',
      model: 'm',
      apiFormat: 'openai_chat_completions',
      keyEnc: b64('sk-other'),
      active: false,
    },
  ]);
  cli('gemini', [
    {
      id: 'g1',
      kind: 'gemini',
      name: 'G',
      baseUrl: 'https://gem.example.com',
      model: 'gemini-3',
      apiFormat: 'gemini_generate_content',
      keyEnc: b64('sk-gem'),
      active: false,
    },
  ]);
  fs.writeFileSync(
    path.join(cliRoot, 'routing.json'),
    JSON.stringify({ enabled: true, host: '127.0.0.1', port: 18800, claude: true, codex: true }),
  );
  const store = new GatewayStore({
    file: path.join(root, 'gateway', 'store.json'),
    cipher: plaintextCipher,
  });
  const sources = {
    nomiFile,
    cliRoot,
    nomiCipher: plaintextCipher,
    cliDecrypt: (e: string) => Buffer.from(e, 'base64').toString('utf8'),
    normalizeNomi,
  };
  return { root, store, sources, nomiFile };
}

describe('gateway migration (§6.3)', () => {
  it('merges providers by host + key, maps assignments, keeps the old port, and leaves old files alone', () => {
    const t = setup();
    const before = fs.readFileSync(t.nomiFile, 'utf8');
    const r = migrateLegacy(t.store, t.sources);
    expect(r).toMatchObject({ migrated: true, providers: 5, undecryptable: 0 });
    const data = t.store.snapshot();
    const ds = data.providers.find((p) => p.id === 'deepseek')!;
    expect(ds.urls).toEqual({
      chat: 'https://api.deepseek.com/v1',
      messages: 'https://api.deepseek.com/anthropic',
    });
    expect(ds.keys.map((k) => k.masked)).toHaveLength(2);
    expect(ds.models).toEqual([
      { id: 'deepseek-v4-pro', enabled: true, metaSource: 'user' },
      { id: 'deepseek-v4-flash', enabled: false, metaSource: 'listed' },
    ]);
    const kimi = data.providers.find((p) => p.id === 'kimi')!;
    expect(kimi.urls).toEqual({ messages: 'https://api.moonshot.cn/anthropic' });
    expect(kimi.modelMap).toEqual([{ from: 'kimi-k3', to: 'kimi-k3-0901' }]);
    expect(data.providers.find((p) => p.name === 'G')!.urls).toEqual({
      gemini: 'https://gem.example.com/v1beta',
    });

    expect(data.clients.nomi!.models).toEqual({
      main: 'deepseek/deepseek-v4-pro',
      summary: 'kimi/kimi-k3-turbo',
    });
    expect(data.clients.claude).toMatchObject({
      models: { main: 'deepseek/deepseek-v4-pro' },
      newTabSource: 'thirdParty',
    });
    expect(data.clients.codex).toMatchObject({
      models: { main: 'relay/gpt-6-sol' },
      newTabSource: 'thirdParty',
    });
    expect(data.clients.gemini!.newTabSource).toBeUndefined();
    expect(data.port).toBe(18800);
    // 供应商来源：Nomi 的存储 + 有数据的 3 份 CLI 存储（routing.json 只读端口）
    expect(data.migratedFrom!.files).toHaveLength(4);

    // 旧文件只读不改
    expect(fs.readFileSync(t.nomiFile, 'utf8')).toBe(before);
    // 新存储 0600
    if (process.platform !== 'win32') expect(fs.statSync(t.store.file).mode & 0o777).toBe(0o600);
  });

  it('local / LAN addresses from the old config count as confirmed, so chat keeps working', () => {
    const t = setup();
    const raw = JSON.parse(fs.readFileSync(t.nomiFile, 'utf8'));
    raw.providers.push({
      id: 'p-ollama',
      presetId: 'ollama',
      name: 'Ollama（本地）',
      protocol: 'openai-chat',
      baseURL: 'http://localhost:11434/v1',
      fullUrl: false,
      defaultModel: 'qwen3',
      models: ['qwen3'],
      enabled: true,
      keys: [],
      createdAt: 1,
      updatedAt: 1,
    });
    raw.activeProviderId = 'p-ollama';
    fs.writeFileSync(t.nomiFile, JSON.stringify(raw));
    migrateLegacy(t.store, t.sources);
    const data = t.store.snapshot();
    expect(data.allowedPrivateHosts).toEqual(['localhost:11434']);
    expect(data.clients.nomi!.models.main).toBe('ollama/qwen3');
    // 没有 Key 的本地服务在快照里能被路由
    expect(t.store.runtimeConfig().providers.find((p) => p.id === 'ollama')!.keys).toHaveLength(1);
  });

  it('the runtime snapshot carries decrypted keys and a token per client', () => {
    const t = setup();
    migrateLegacy(t.store, t.sources);
    const cfg = t.store.runtimeConfig({ legacyToken: 'nomi-route-old' });
    expect(cfg.port).toBe(18800);
    expect(cfg.providers.find((p) => p.id === 'deepseek')!.keys.map((k) => k.value)).toEqual([
      'sk-ds-1',
      'sk-ds-2',
    ]);
    expect(Object.keys(cfg.clients).sort()).toEqual([
      'claude',
      'codex',
      'dsh',
      'gemini',
      'grok',
      'nomi',
    ]);
    expect(cfg.clients.codex!.token).toMatch(/^nomi-gw-codex-[A-Za-z0-9_-]{43}$/);
    expect(cfg.legacyToken).toBe('nomi-route-old');
  });

  it('reloads from disk and keeps tokens stable; a corrupt store is moved aside', () => {
    const t = setup();
    migrateLegacy(t.store, t.sources);
    const token = t.store.clientToken('claude');
    const again = new GatewayStore({ file: t.store.file, cipher: plaintextCipher });
    expect(again.clientToken('claude')).toBe(token);
    expect(again.snapshot().migratedFrom).toBeDefined();
    fs.writeFileSync(t.store.file, '{not json');
    const broken = new GatewayStore({ file: t.store.file, cipher: plaintextCipher });
    expect(broken.providers()).toEqual([]);
    expect(fs.readdirSync(path.dirname(t.store.file)).some((f) => f.includes('.corrupt-'))).toBe(
      true,
    );
  });

  it('legacy bases follow the gateway URL conventions', () => {
    expect(legacyBase('messages', 'https://api.anthropic.com/v1/')).toBe(
      'https://api.anthropic.com',
    );
    expect(legacyBase('chat', 'https://x/v1/chat/completions', true)).toBe('https://x/v1');
    expect(legacyBase('gemini', 'https://g.example/v1beta')).toBe('https://g.example/v1beta');
    expect(legacyBase('gemini', 'https://g.example')).toBe('https://g.example/v1beta');
  });
});
