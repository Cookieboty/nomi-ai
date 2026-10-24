import { describe, expect, it } from 'vitest';

import type { GatewayConfig, RuntimeProvider } from '../src/config';
import { checkUpstream } from '../src/net/upstreamGuard';
import { pickWire, wiresFor, WIRE_DOWN_TTL_MS } from '../src/route/native';
import { mapModel, preferredWire, resolveCandidates, splitRef } from '../src/route/resolve';
import { upstreamUrl } from '../src/upstream';

/** 只要映射到的模型名 */
const mapBuiltinModel = (...a: Parameters<typeof mapModel>) => mapModel(...a)?.ref ?? null;

const p = (extra: Partial<RuntimeProvider> = {}): RuntimeProvider => ({
  id: 'relay',
  name: 'Relay',
  enabled: true,
  urls: { chat: 'https://r/v1', responses: 'https://r/v1', messages: 'https://r' },
  keys: [{ id: 'k', value: 'v', enabled: true }],
  models: [],
  ...extra,
});

describe('pickWire (§7.3)', () => {
  const all = ['chat', 'responses', 'messages'] as const;
  it('Claude models prefer Messages even before same-protocol passthrough', () => {
    expect(pickWire(p(), 'claude-opus-5', 'chat', all)).toBe('messages');
    expect(pickWire(p(), 'anthropic/claude-opus-5', 'responses', all)).toBe('messages');
  });
  it('a manual wire on the model turns rule 2 off', () => {
    const q = p({ models: [{ id: 'claude-opus-5', enabled: true, wires: ['chat'] }] });
    expect(pickWire(q, 'claude-opus-5', 'chat', ['chat'])).toBe('chat');
  });
  it('same protocol, then OpenAI → Responses, then preferWire, then chat first', () => {
    expect(pickWire(p(), 'glm-5', 'responses', all)).toBe('responses');
    expect(pickWire(p(), 'gpt-6', 'messages', ['chat', 'responses'])).toBe('responses');
    expect(pickWire(p({ quirks: { preferWire: 'messages' } }), 'glm-5', 'gemini', all)).toBe(
      'messages',
    );
    expect(pickWire(p(), 'glm-5', 'gemini', all)).toBe('chat');
    expect(pickWire(p(), 'glm-5', 'gemini', [])).toBeNull();
  });
});

describe('wiresFor', () => {
  it('drops wires that probing, learning, the model or the key rule out', () => {
    const now = 10 * WIRE_DOWN_TTL_MS;
    const q = p({ detected: { responses: { ok: false } } });
    expect(wiresFor(q, 'm', q.keys[0], undefined, now).sort()).toEqual(['chat', 'messages']);
    expect(
      wiresFor(q, 'm', q.keys[0], { wireDown: { chat: { at: now - 1000, reason: '404' } } }, now),
    ).toEqual(['messages']);
    // 过期的 wireDown 不再生效
    expect(
      wiresFor(
        q,
        'm',
        q.keys[0],
        { wireDown: { chat: { at: now - WIRE_DOWN_TTL_MS, reason: '' } } },
        now,
      ).sort(),
    ).toEqual(['chat', 'messages']);
    expect(
      wiresFor(q, 'm', { id: 'k2', value: '', enabled: true, wire: 'messages' }, undefined, now),
    ).toEqual(['messages']);
    expect(wiresFor(q, 'm', q.keys[0], { modelWire: { m: ['chat'] } }, now)).toEqual(['chat']);
  });
});

describe('resolve (§6.2 / §7.2)', () => {
  const cfg = (providers: RuntimeProvider[]): GatewayConfig => ({
    host: '127.0.0.1',
    port: 1,
    providers,
    clients: {
      claude: { token: 't', models: { main: 'a/x', small: 'a/y', tiers: { opus: 'b/big' } } },
    },
  });
  it('splits on the first slash only', () => {
    expect(splitRef('relay/anthropic/claude-opus')).toEqual({
      provider: 'relay',
      model: 'anthropic/claude-opus',
    });
    expect(splitRef('glm-5')).toEqual({ provider: null, model: 'glm-5' });
  });
  it('Claude built-in names map to tiers / small / main', () => {
    const models = cfg([]).clients.claude!.models;
    expect(mapBuiltinModel('claude', models, 'claude-opus-4-8')).toBe('b/big');
    expect(mapBuiltinModel('claude', models, 'claude-haiku-4-5')).toBe('a/y');
    expect(mapBuiltinModel('claude', models, 'claude-sonnet-5')).toBe('a/x');
    expect(mapBuiltinModel('claude', models, '')).toBe('a/x');
    expect(mapBuiltinModel('nomi', models, 'whatever')).toBeNull();
  });
  it('aliases still resolve, bare names prefer the home provider, and fallbacks are appended', () => {
    const a = p({
      id: 'a',
      aliases: ['old-a'],
      models: [
        { id: 'x', enabled: true },
        { id: 'dup', enabled: true },
      ],
      fallback: ['b/big'],
    });
    const b = p({
      id: 'b',
      models: [
        { id: 'big', enabled: true },
        { id: 'dup', enabled: true },
      ],
    });
    const r = resolveCandidates(cfg([a, b]), 'claude', 'old-a/x', 'messages');
    expect(r.ok && r.candidates.map((c) => c.publicModel)).toEqual(['a/x', 'b/big']);
    const bare = resolveCandidates(cfg([a, b]), 'claude', 'dup', 'messages');
    expect(bare.ok && bare.candidates[0]!.provider.id).toBe('a');
  });
  it('preferredWire lists every upstream that may receive the request, fallbacks included', () => {
    const a = p({
      id: 'a',
      urls: { chat: 'http://127.0.0.1:11434/v1' },
      keys: [
        { id: 'k1', value: 'v', enabled: true },
        { id: 'k2', value: 'w', enabled: true },
      ],
      models: [{ id: 'x', enabled: true }],
      fallback: ['b/big'],
    });
    const b = p({ id: 'b', name: 'B', models: [{ id: 'big', enabled: true }] });
    const r = preferredWire(cfg([a, b]), 'nomi', 'a/x');
    expect(r).toMatchObject({ wire: 'chat', publicModel: 'a/x' });
    expect(r!.upstreams).toEqual([
      { providerId: 'a', name: 'Relay', url: 'http://127.0.0.1:11434/v1' },
      { providerId: 'b', name: 'B', url: 'https://r/v1' },
      // B 的 Messages 地址：运行时可能换协议过去（#100）
      { providerId: 'b', name: 'B', url: 'https://r' },
    ]);
  });
  it('preferredWire also counts other-wire addresses the same key may switch to (#100)', () => {
    const a = p({
      id: 'a',
      urls: { chat: 'http://127.0.0.1:11434/v1', messages: 'https://cloud.example' },
      keys: [{ id: 'k1', value: 'v', enabled: true }],
      models: [{ id: 'x', enabled: true }],
    });
    const r = preferredWire(cfg([a]), 'nomi', 'a/x');
    expect(r!.wire).toBe('chat');
    expect(r!.upstreams.map((u) => u.url)).toEqual([
      'http://127.0.0.1:11434/v1',
      'https://cloud.example',
    ]);
    // Key 限定在 chat 时不会换到 messages，不算
    const pinned = p({ ...a, keys: [{ id: 'k1', value: 'v', enabled: true, wire: 'chat' }] });
    expect(preferredWire(cfg([pinned]), 'nomi', 'a/x')!.upstreams.map((u) => u.url)).toEqual([
      'http://127.0.0.1:11434/v1',
    ]);
  });
  it('SDK wire selection uses native preferences before committing to an ingress', () => {
    const native = (model: string, extra: Partial<RuntimeProvider> = {}) =>
      preferredWire(
        cfg([p({ id: 'a', models: [{ id: model, enabled: true }], ...extra })]),
        'nomi',
        `a/${model}`,
      )?.wire;
    expect(native('gpt-6')).toBe('responses');
    expect(native('claude-opus-5')).toBe('messages');
    expect(native('glm-5', { quirks: { preferWire: 'messages' } })).toBe('messages');
    expect(native('glm-5', { quirks: { responsesTellsCache: true } })).toBe('responses');
    expect(native('glm-5')).toBe('chat');
    expect(native('gpt-6', { models: [{ id: 'gpt-6', enabled: true, wires: ['chat'] }] })).toBe(
      'chat',
    );
    // 外部 CLI 已有入口时仍按同协议透传，不受 SDK 入口选择影响。
    const external = resolveCandidates(cfg([p({ id: 'a' })]), 'codex', 'a/gpt-6', 'chat');
    expect(external.ok && external.candidates[0]!.wire).toBe('chat');
  });
  it('a disabled provider or one without keys is not a candidate', () => {
    const r = resolveCandidates(cfg([p({ id: 'a', keys: [] })]), 'claude', 'a/x', 'chat');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(
      resolveCandidates(cfg([p({ id: 'a', enabled: false })]), 'claude', 'a/x', 'chat').ok,
    ).toBe(false);
  });
});

describe('upstream addresses', () => {
  it('builds per-wire URLs', () => {
    expect(upstreamUrl('messages', 'https://api.deepseek.com/anthropic', 'm')).toBe(
      'https://api.deepseek.com/anthropic/v1/messages',
    );
    expect(upstreamUrl('messages', 'https://x/v1/', 'm', { countTokens: true })).toBe(
      'https://x/v1/messages/count_tokens',
    );
    expect(upstreamUrl('chat', 'https://x/v1', 'm')).toBe('https://x/v1/chat/completions');
    expect(upstreamUrl('gemini', 'https://x/v1beta', 'google/gemini-3', { stream: true })).toBe(
      'https://x/v1beta/models/google/gemini-3:streamGenerateContent?alt=sse',
    );
  });

  it('upstream guard: public ok, private needs confirmation, never the gateway itself', async () => {
    const lookupAll = async (h: string) => [
      { address: h === 'rebind.example' ? '10.0.0.5' : '93.184.216.34', family: 4 },
    ];
    await expect(checkUpstream('https://api.example.com/v1', { lookupAll })).resolves.toBeTruthy();
    await expect(checkUpstream('https://rebind.example/v1', { lookupAll })).rejects.toThrow(
      '局域网',
    );
    await expect(checkUpstream('http://127.0.0.1:11434/v1', {})).rejects.toThrow('确认');
    await expect(
      checkUpstream('http://127.0.0.1:11434/v1', { allowedPrivateHosts: ['127.0.0.1:11434'] }),
    ).resolves.toBeTruthy();
    await expect(
      checkUpstream('http://localhost:18721/v1', {
        allowedPrivateHosts: ['localhost:18721'],
        selfPort: 18721,
      }),
    ).rejects.toThrow('网关自己');
    await expect(checkUpstream('ftp://x/y', {})).rejects.toThrow('http');
    // 代理的 fake-ip：域名解析到 198.18.0.0/15 放行，IP 字面量仍要确认
    const fake = async () => [{ address: '198.18.2.35', family: 4 }];
    await expect(
      checkUpstream('https://gateway.example/v1', { lookupAll: fake }),
    ).resolves.toBeTruthy();
    await expect(checkUpstream('https://198.18.2.35/v1', {})).rejects.toThrow('确认');
    await expect(checkUpstream('https://u:p@x.example/', { lookupAll })).rejects.toThrow(
      '账号密码',
    );
  });
});
