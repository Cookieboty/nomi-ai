import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatChunk, ChatRequest, LLMProvider } from '@nomi-ai/bundle-ig-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSdkLlmProvider, type AiSdkLlmProviderOptions } from '../src/ai-sdk/AiSdkLlmProvider';
import {
  PROVIDER_PRESETS,
  ProviderService,
  ProviderStore,
  RoutedLLMRegistry,
  TrackedProvider,
  createSafeStorageCipher,
  estimateTokens,
  isKeyError,
  maskSecret,
  plaintextCipher,
  type SecretCipher,
} from '../src/providers';

/** 可逆的假加密：确认落盘的是密文而非明文 */
const fakeCipher: SecretCipher = {
  kind: 'safeStorage',
  encrypt: (s) => `enc:${Buffer.from([...s].reverse().join('')).toString('base64')}`,
  decrypt: (s) => [...Buffer.from(s.slice(4), 'base64').toString()].reverse().join(''),
};

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  reqId: 'r1',
  provider: 'x',
  model: 'default',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
  ...over,
});

function fakeProvider(
  id: string,
  behavior: { fail?: string; text?: string } = {},
  calls: string[] = [],
): LLMProvider {
  return {
    id,
    async chat(r) {
      calls.push(`${id}:chat`);
      if (behavior.fail) throw new Error(behavior.fail);
      return {
        reqId: r.reqId,
        provider: id,
        model: r.model,
        content: behavior.text ?? `from ${id}`,
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      };
    },
    async *stream(): AsyncIterable<ChatChunk> {
      calls.push(`${id}:stream`);
      if (behavior.fail) {
        yield { type: 'error', error: behavior.fail };
        return;
      }
      yield { type: 'delta', content: behavior.text ?? `from ${id}` };
      yield { type: 'usage', usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 } };
      yield { type: 'done', finishReason: 'stop' };
    },
    abort: vi.fn(),
  };
}

describe('secretCipher', () => {
  it('masks without revealing the full key', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-…cdef');
    expect(maskSecret('abcd')).toBe('••cd');
  });

  it('uses safeStorage when available, plaintext fallback otherwise', () => {
    const ss = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`E${s}`),
      decryptString: (b: Buffer) => b.toString().slice(1),
      getSelectedStorageBackend: () => 'gnome_libsecret',
    };
    const c = createSafeStorageCipher(ss);
    expect(c.kind).toBe('safeStorage');
    expect(c.decrypt(c.encrypt('sk-x'))).toBe('sk-x');
    expect(createSafeStorageCipher({ ...ss, isEncryptionAvailable: () => false }).kind).toBe(
      'none',
    );
    // Linux basic_text = 固定口令，视为不可用
    expect(
      createSafeStorageCipher({ ...ss, getSelectedStorageBackend: () => 'basic_text' }).kind,
    ).toBe('none');
    expect(createSafeStorageCipher(undefined)).toBe(plaintextCipher);
  });
});

describe('ProviderStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pstore-'));
    file = join(dir, 'ai-providers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists encrypted keys, never plaintext, and exposes only masked views', () => {
    const store = new ProviderStore({ filePath: file, cipher: fakeCipher });
    const v = store.upsert({ presetId: 'deepseek', apiKey: 'sk-secret-AAAA1111' });
    expect(v.id).toMatch(/^p-deepseek-/);
    expect(v.baseURL).toBe('https://api.deepseek.com');
    expect(v.defaultModel).toBe('');
    expect(v.models).toEqual([]);
    expect(v.keys).toHaveLength(1);
    expect(v.keys[0]!.masked).toBe('sk-…1111');
    expect(JSON.stringify(store.list())).not.toContain('sk-secret-AAAA1111');

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-secret-AAAA1111');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const reopened = new ProviderStore({ filePath: file, cipher: fakeCipher });
    expect(reopened.resolveKeys(v.id)).toEqual(['sk-secret-AAAA1111']);
  });

  it('add / rotate / promote / delete keys keeps fallback order', () => {
    const store = new ProviderStore({ cipher: fakeCipher });
    const { id } = store.upsert({ presetId: 'openai', apiKey: 'key-one-000001' });
    const v2 = store.addKey(id, 'key-two-000002', 'backup');
    const second = v2.keys[1]!;
    expect(store.resolveKeys(id)).toEqual(['key-one-000001', 'key-two-000002']);
    store.promoteKey(id, second.id);
    expect(store.resolveKeys(id)).toEqual(['key-two-000002', 'key-one-000001']);
    store.rotateKey(id, second.id, 'key-two-rotated');
    expect(store.resolveKeys(id)[0]).toBe('key-two-rotated');
    expect(store.list()[0]!.keys[0]!.label).toBe('backup');
    store.removeKey(id, store.list()[0]!.keys[1]!.id);
    expect(store.resolveKeys(id)).toEqual(['key-two-rotated']);
    expect(() => store.addKey(id, 'has space')).toThrow(/空白/);
  });

  it('validates baseURL / headers and cleans up active + routes on remove', () => {
    const store = new ProviderStore({ cipher: fakeCipher });
    expect(() => store.upsert({ presetId: 'custom', baseURL: 'ftp://x' })).toThrow(/http/);
    expect(() => store.upsert({ presetId: 'custom', headers: { 'bad header': 'x' } })).toThrow();
    const { id } = store.upsert({
      presetId: 'custom',
      baseURL: 'http://127.0.0.1:9/v1/',
      headers: { 'X-Org': 'o1' },
    });
    expect(store.list()[0]!.baseURL).toBe('http://127.0.0.1:9/v1');
    store.setActive(id);
    store.setRoute('summary', { providerId: id, model: 'm-small' });
    store.recordUsage(id, { inputTokens: 1, outputTokens: 2 }, true);
    store.remove(id);
    expect(store.activeProviderId()).toBeUndefined();
    expect(store.route('summary')).toBeUndefined();
    expect(store.usage()[id]).toBeUndefined();
  });

  it('plaintext fallback marks keys as unencrypted', () => {
    const store = new ProviderStore({ cipher: plaintextCipher });
    const v = store.upsert({ presetId: 'zhipu', apiKey: 'zp-1234567890' });
    expect(store.encryption).toBe('none');
    expect(v.keys[0]!.encryption).toBe('none');
    expect(store.resolveKeys(v.id)).toEqual(['zp-1234567890']);
  });

  it('ships all required presets', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of [
      'deepseek',
      'openai',
      'anthropic',
      'gemini',
      'ollama',
      'openrouter',
      'siliconflow',
      'amux',
      'qwen',
      'kimi',
      'zhipu',
      'doubao',
      'custom',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('TrackedProvider 调用明细（用量与计费）', () => {
  const sinkOf = () => ({ recordUsage: vi.fn(), recordCall: vi.fn() });

  it('chat：记模型 / 时间 / token / 缓存；有 usage 时不标估算', async () => {
    const sink = sinkOf();
    const p = new TrackedProvider(
      'p1',
      [
        {
          ...fakeProvider('k1'),
          chat: async (r) => ({
            reqId: r.reqId,
            provider: 'k1',
            model: r.model,
            content: 'ok',
            finishReason: 'stop',
            usage: {
              promptTokens: 100,
              completionTokens: 7,
              totalTokens: 107,
              cacheReadTokens: 60,
              cacheWriteTokens: 5,
            },
          }),
        },
      ],
      sink,
    );
    await p.chat(req({ model: 'gpt-4o' }));
    expect(sink.recordCall).toHaveBeenCalledTimes(1);
    expect(sink.recordCall.mock.calls[0]![0]).toMatchObject({
      providerId: 'p1',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      estimated: false,
      reqId: 'r1',
    });
    expect(typeof sink.recordCall.mock.calls[0]![0].at).toBe('number');
  });

  it('上游没返回 usage：按文本估算并标 estimated；模型缺省回落到 provider 默认模型', async () => {
    const sink = sinkOf();
    const noUsage: LLMProvider = {
      ...fakeProvider('k1'),
      chat: async (r) => ({
        reqId: r.reqId,
        provider: 'k1',
        model: '',
        content: '你好，世界！这是一段回复。',
        finishReason: 'stop',
      }),
    };
    const p = new TrackedProvider('p1', [noUsage], sink, 'deepseek-chat');
    await p.chat(req({ model: '', messages: [{ role: 'user', content: 'hello there' }] }));
    const e = sink.recordCall.mock.calls[0]![0];
    expect(e.estimated).toBe(true);
    expect(e.model).toBe('deepseek-chat');
    expect(e.inputTokens).toBe(estimateTokens('hello there'));
    expect(e.outputTokens).toBe(estimateTokens('你好，世界！这是一段回复。'));
    expect(e.outputTokens).toBeGreaterThan(0);
  });

  it('stream：取 usage 末包与模型；失败的调用不记明细；key 回退只记最终成功的一次', async () => {
    const sink = sinkOf();
    const p = new TrackedProvider(
      'p1',
      [fakeProvider('k1', { fail: '401 Unauthorized' }), fakeProvider('k2')],
      sink,
    );
    for await (const c of p.stream(req({ stream: true }))) void c;
    expect(sink.recordCall).toHaveBeenCalledTimes(1);
    expect(sink.recordCall.mock.calls[0]![0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      estimated: false,
    });

    const sink2 = sinkOf();
    const bad = new TrackedProvider('p2', [fakeProvider('k1', { fail: 'model not found' })], sink2);
    await expect(bad.chat(req())).rejects.toThrow();
    expect(sink2.recordCall).not.toHaveBeenCalled();
  });

  it('记账回调抛错不影响对话；ProviderStore.onCall 吞掉回调异常', async () => {
    const sink = {
      recordUsage: vi.fn(),
      recordCall: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const p = new TrackedProvider('p1', [fakeProvider('k1')], sink);
    await expect(p.chat(req())).resolves.toMatchObject({ content: 'from k1' });

    const seen: string[] = [];
    const store = new ProviderStore({
      cipher: plaintextCipher,
      onCall: (e) => {
        seen.push(e.model);
        throw new Error('x');
      },
    });
    expect(() =>
      store.recordCall({
        providerId: 'p',
        model: 'm',
        at: 1,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: false,
      }),
    ).not.toThrow();
    expect(seen).toEqual(['m']);
  });
});

describe('estimateTokens', () => {
  it('英文约 4 字符 / token，中文约 1.5 字 / token，空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好世界你好')).toBe(4);
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('TrackedProvider key fallback + usage', () => {
  it('falls back to the next key on auth errors and records usage', async () => {
    const calls: string[] = [];
    const sink = { recordUsage: vi.fn(), markKey: vi.fn() };
    const p = new TrackedProvider(
      'p1',
      [fakeProvider('k1', { fail: '401 Unauthorized' }, calls), fakeProvider('k2', {}, calls)],
      sink,
    );
    const res = await p.chat(req());
    expect(res.content).toBe('from k2');
    expect(res.provider).toBe('p1');
    expect(calls).toEqual(['k1:chat', 'k2:chat']);
    expect(sink.markKey).toHaveBeenCalledWith('p1', 0, '401 Unauthorized');
    expect(sink.recordUsage).toHaveBeenCalledWith(
      'p1',
      { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      true,
    );
  });

  it('does not fall back on non-key errors', async () => {
    const calls: string[] = [];
    const sink = { recordUsage: vi.fn() };
    const p = new TrackedProvider(
      'p1',
      [fakeProvider('k1', { fail: 'model not found' }, calls), fakeProvider('k2', {}, calls)],
      sink,
    );
    await expect(p.chat(req())).rejects.toThrow('model not found');
    expect(calls).toEqual(['k1:chat']);
    expect(sink.recordUsage).toHaveBeenCalledWith('p1', undefined, false);
  });

  it('stream falls back silently before any output', async () => {
    const sink = { recordUsage: vi.fn() };
    const p = new TrackedProvider(
      'p1',
      [fakeProvider('k1', { fail: 'insufficient quota' }), fakeProvider('k2')],
      sink,
    );
    const out: ChatChunk[] = [];
    for await (const c of p.stream(req({ stream: true }))) out.push(c);
    expect(out.map((c) => c.type)).toEqual(['delta', 'usage', 'done']);
    expect(sink.recordUsage).toHaveBeenCalledWith(
      'p1',
      { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      true,
    );
  });

  it('classifies key errors', () => {
    expect(isKeyError('Incorrect API key provided')).toBe(true);
    expect(isKeyError('429 Too Many Requests')).toBe(true);
    expect(isKeyError('context length exceeded')).toBe(false);
  });
});

describe('RoutedLLMRegistry routing', () => {
  const built: AiSdkLlmProviderOptions[] = [];
  const factory = (o: AiSdkLlmProviderOptions) => {
    built.push(o);
    return fakeProvider(o.id, { text: `${o.id}@${o.baseURL}` });
  };
  beforeEach(() => (built.length = 0));

  it('precedence: override > role route > active > env order; switching is live', async () => {
    const store = new ProviderStore({ cipher: fakeCipher });
    const env = [fakeProvider('deepseek'), fakeProvider('ollama')];
    const reg = new RoutedLLMRegistry({ store, envProviders: env, factory });
    expect(reg.resolve('chat')!.provider.id).toBe('deepseek');

    const a = store.upsert({
      presetId: 'custom',
      baseURL: 'http://a.test/v1',
      apiKey: 'ka-123456',
    });
    const b = store.upsert({
      presetId: 'custom',
      baseURL: 'http://b.test/v1',
      apiKey: 'kb-123456',
    });
    store.setActive(a.id);
    expect(reg.resolve('chat')!.provider.id).toBe(a.id);
    expect(reg.list()[0]!.id).toBe(a.id);
    expect((await reg.resolve('chat')!.provider.chat(req())).content).toBe(
      `${a.id}@http://a.test/v1`,
    );

    store.setRoute('agent-tools', { providerId: b.id, model: 'big-model' });
    expect(reg.resolve('agent-tools')).toMatchObject({
      provider: { id: b.id },
      model: 'big-model',
    });
    expect(reg.resolve('chat')!.provider.id).toBe(a.id);

    // 切换 active 立即生效
    store.setActive(b.id);
    expect(reg.resolve('chat')!.provider.id).toBe(b.id);
    // env provider 也能被设为 active
    store.setActive('ollama');
    expect(reg.resolve('chat')!.provider.id).toBe('ollama');

    // 禁用后不再参与路由，回落到 env
    store.setActive(a.id);
    store.upsert({ id: a.id, enabled: false });
    expect(reg.get(a.id)).toBeUndefined();
    expect(reg.resolve('chat')!.provider.id).toBe('deepseek');

    const forced = new RoutedLLMRegistry({
      store,
      envProviders: env,
      factory,
      overrideId: 'ollama',
    });
    expect(forced.resolve('agent-tools')!.provider.id).toBe('ollama');
  });

  it('builds one AI SDK provider per key (fallback order) with headers', () => {
    const store = new ProviderStore({ cipher: fakeCipher });
    const p = store.upsert({
      presetId: 'openrouter',
      apiKey: 'or-key-1111111',
      headers: { 'HTTP-Referer': 'https://companion.desk' },
    });
    store.addKey(p.id, 'or-key-2222222');
    new RoutedLLMRegistry({ store, factory });
    const mine = built.filter((o) => o.id === p.id);
    expect(mine.map((o) => o.apiKey)).toEqual(['or-key-1111111', 'or-key-2222222']);
    expect(mine[0]).toMatchObject({
      baseURL: 'https://openrouter.ai/api/v1',
      protocol: 'openai-chat',
      headers: { 'HTTP-Referer': 'https://companion.desk' },
    });
  });

  it('real AI SDK provider hits the configured base URL with key + headers', async () => {
    const seen: Array<{ url: string; auth: string | null; org: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url: String(url), auth: h.get('authorization'), org: h.get('x-org') });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const store = new ProviderStore({ cipher: fakeCipher });
    const p = store.upsert({
      presetId: 'custom',
      baseURL: 'http://mock.local/v1',
      defaultModel: 'mock-1',
      apiKey: 'sk-mock-123456',
      headers: { 'X-Org': 'acme' },
    });
    store.setActive(p.id);
    const reg = new RoutedLLMRegistry({
      store,
      factory: (o) => new AiSdkLlmProvider({ ...o, fetchImpl }),
    });
    const res = await reg.resolve()!.provider.chat(req());
    expect(res.content).toBe('pong');
    expect(seen).toEqual([
      { url: 'http://mock.local/v1/chat/completions', auth: 'Bearer sk-mock-123456', org: 'acme' },
    ]);
    expect(store.usage()[p.id]).toMatchObject({ requests: 1, inputTokens: 7, outputTokens: 1 });
  });
});

describe('ProviderService', () => {
  it('state never contains secrets; env providers listed; unknown ids rejected', async () => {
    const store = new ProviderStore({ cipher: fakeCipher });
    const reg = new RoutedLLMRegistry({ store, envProviders: [fakeProvider('deepseek')] });
    const svc = new ProviderService({
      store,
      envEntries: [{ id: 'deepseek', apiKey: 'sk-env-SECRET-999' }, { id: 'ollama' }],
      getRegistry: () => reg,
      factory: (o) =>
        fakeProvider(o.id, {
          fail: o.apiKey === 'bad-key-0000' ? '401 bad sk-abcdefabcdefabcdef' : undefined,
        }),
    });
    const v = svc.upsert({ presetId: 'kimi', apiKey: 'ms-very-secret-1' });
    const state = svc.state();
    const json = JSON.stringify(state);
    expect(json).not.toContain('ms-very-secret-1');
    expect(json).not.toContain('sk-env-SECRET-999');
    expect(state.envProviders.map((e) => [e.id, e.hasKey])).toEqual([
      ['deepseek', true],
      ['ollama', true],
    ]);
    expect(() => svc.setActive('nope')).toThrow(/不存在/);
    expect(svc.setActive(v.id).effectiveProviderId).toBe(v.id);

    expect((await svc.testDraft({ presetId: 'custom', apiKey: 'good-key-0000' })).ok).toBe(true);
    const bad = await svc.testDraft({ presetId: 'custom', apiKey: 'bad-key-0000' });
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain('sk-abcdefabcdefabcdef');
    expect((await svc.test(v.id)).ok).toBe(true);
  });
});

describe('ProviderIpcServer', () => {
  it('exposes ai:providers:* channels, broadcasts masked state on change', async () => {
    const { createFakeIpcAdapter } = await import('./helpers/fakeIpc');
    const { ProviderIpcServer, PROVIDERS_CHANGED_EVENT } = await import('../src/providers');
    const adapter = createFakeIpcAdapter();
    const wc = adapter.addWebContents(7);
    const store = new ProviderStore({ cipher: fakeCipher });
    const svc = new ProviderService({ store, envEntries: [], getRegistry: () => undefined });
    const server = new ProviderIpcServer({ adapter, service: svc });
    server.start();
    expect(server.channels).toContain('ai:providers:upsert');
    const view = (await adapter.invoke(7, 'ai:providers:upsert', {
      presetId: 'qwen',
      apiKey: 'dashscope-secret-1',
    })) as { id: string };
    await adapter.invoke(7, 'ai:providers:setActive', view.id);
    const changed = wc.sent.filter((s) => s.channel === PROVIDERS_CHANGED_EVENT);
    expect(changed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(wc.sent)).not.toContain('dashscope-secret-1');
    await expect(adapter.invoke(7, 'ai:providers:remove', 42)).rejects.toThrow(/字符串/);
    server.stop();
    expect(adapter.handlers.size).toBe(0);
  });
});
