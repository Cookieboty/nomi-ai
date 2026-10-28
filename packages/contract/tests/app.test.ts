/**
 * 应用契约（`@nomi-ai/contract/app`）测试：取代两份 `channels.ts` 与它们的快照测试。
 *
 * - 过程表快照：名字、kind、dangerous 不漂移（原 IPC_METHODS 的 36 个方法）；
 * - `AI_METHODS` 与过程表一一对应，位置参数打包规则；
 * - 事件表与 AIClient 的 12 个业务事件一一对应，schema 有意放宽；
 * - DTO schema：合法值通过、不合法值拒绝、二进制与 loose 字段保留；
 * - 端到端：用 in-process 传输（strict 序列化）跑通 query / mutation / stream / 事件 / dangerous。
 */

import { describe, expect, it } from 'vitest';

import { createClient, implement, type Handlers, type ProcedureDef } from '../src';
import {
  AI_EVENTS,
  AI_METHODS,
  aiArgsToInput,
  aiSchemas,
  appContract,
  NOMI_TRANSPORT_GLOBAL,
  type AppContract,
} from '../src/app';
import { createInProcessServer } from '../src/testing';

const procedures = appContract.procedures as unknown as Record<string, ProcedureDef>;

describe('appContract · 过程表', () => {
  it('快照：36 个 AI 门面过程的 kind / dangerous', () => {
    const table = Object.entries(procedures).map(
      ([name, def]) => `${name}:${def.kind}${def.dangerous ? ':dangerous' : ''}`,
    );
    expect(table).toEqual([
      'ai.chat.sendMessage:mutation',
      'ai.chat.stream:stream',
      'ai.chat.abort:mutation',
      'ai.chat.regenerate:stream',
      'ai.chat.agentStream:stream',
      'ai.sessions.list:query',
      'ai.sessions.get:query',
      'ai.sessions.create:mutation',
      'ai.sessions.fork:mutation',
      'ai.sessions.rename:mutation',
      'ai.sessions.delete:mutation',
      'ai.tools.list:query',
      'ai.tools.setEnabled:mutation',
      'ai.tools.confirm:mutation:dangerous',
      'ai.memory.userProfile.get:query',
      'ai.memory.userProfile.set:mutation',
      'ai.memory.userProfile.reset:mutation',
      'ai.memory.userProfile.export:query',
      'ai.memory.userProfile.import:mutation',
      'ai.memory.facts.list:query',
      'ai.memory.facts.put:mutation',
      'ai.memory.facts.delete:mutation',
      'ai.memory.summaries.get:query',
      'ai.memory.summaries.put:mutation',
      'ai.asr.list:query',
      'ai.asr.transcribe:mutation',
      'ai.tts.list:query',
      'ai.tts.listVoices:query',
      'ai.tts.synth:mutation',
      'ai.tts.stream:stream',
      'ai.tts.stop:mutation',
      'ai.avatar.isAvailable:query',
      'ai.avatar.playMotion:mutation',
      'ai.avatar.setExpression:mutation',
      'ai.avatar.driveLipSync:mutation',
    ]);
    expect(appContract.version).toEqual({ major: 1, minor: 0 });
    expect(NOMI_TRANSPORT_GLOBAL).toBe('nomiTransport');
  });

  it('AI_METHODS 与过程表一一对应；具名参数与入参 schema 的字段一致', () => {
    expect(AI_METHODS.map((m) => m.procedure).sort()).toEqual(Object.keys(procedures).sort());
    for (const spec of AI_METHODS) {
      expect(spec.procedure).toBe(`ai.${spec.facade}.${spec.method}`);
      if (spec.params === 'value' || spec.params.length === 0) continue;
      const shape = (procedures[spec.procedure]!.input as unknown as { shape?: object }).shape;
      expect(Object.keys(shape ?? {}), spec.procedure).toEqual([...spec.params]);
    }
  });

  it('aiArgsToInput：value 原样、具名打包、省略 undefined、无参为 undefined', () => {
    const by = (p: string) => AI_METHODS.find((m) => m.procedure === p)!;
    const opts = { messages: [] };
    expect(aiArgsToInput(by('ai.chat.stream'), [opts])).toBe(opts);
    expect(aiArgsToInput(by('ai.tools.confirm'), ['r1', true])).toEqual({ reqId: 'r1', ok: true });
    expect(aiArgsToInput(by('ai.tts.stream'), ['hi', { voiceId: 'v' }])).toEqual({
      text: 'hi',
      opts: { voiceId: 'v' },
    });
    expect(aiArgsToInput(by('ai.sessions.list'), [])).toBeUndefined();
  });
});

describe('appContract · 事件', () => {
  it('AI_EVENTS 覆盖 AIClient 的 12 个业务事件，且都声明在契约里', () => {
    expect(Object.keys(AI_EVENTS).sort()).toEqual(
      [
        'message:delta',
        'message:complete',
        'agent:step',
        'agent:turn-end',
        'agent:stopped-by-user',
        'tool:confirm-required',
        'tool:executed',
        'tts:chunk',
        'tts:end',
        'userProfile:changed',
        'avatar:touch',
        'avatar:motion-end',
      ].sort(),
    );
    expect(Object.values(AI_EVENTS).sort()).toEqual(Object.keys(appContract.events).sort());
  });

  it('事件 schema 有意放宽：已知字段可缺省、未知字段透传，但已知字段类型仍校验', () => {
    const changed = appContract.events['ai.userProfile.changed'];
    expect(changed.parse({ version: 1, identity: {} })).toEqual({ version: 1, identity: {} });
    const chunk = appContract.events['ai.tts.chunk'];
    const data = new Uint8Array([1, 2]);
    expect(chunk.parse({ rms: 0.5, data }).data).toBe(data);
    expect(chunk.safeParse({ rms: 'loud' }).success).toBe(false);
    expect(chunk.safeParse('not an object').success).toBe(false);
  });
});

describe('appContract · DTO schema', () => {
  it('chat 选项：loose 透传未知字段，messages 必填', () => {
    const parsed = aiSchemas.ChatOptions.parse({
      messages: [{ role: 'user', content: 'hi', images: [{ mime: 'image/png', data: 'AA' }] }],
      extra: { conversationId: 'c1' },
      role: 'chat',
      custom: 1,
    });
    expect(parsed.custom).toBe(1);
    expect(aiSchemas.ChatOptions.safeParse({}).success).toBe(false);
    expect(
      aiSchemas.ChatOptions.safeParse({ messages: [{ role: 'bot', content: '' }] }).success,
    ).toBe(false);
  });

  it('ChatResponse 去掉 raw；ChatChunk 按 type 判别', () => {
    const resp = aiSchemas.ChatResponse.parse({
      reqId: 'r',
      provider: 'p',
      model: 'm',
      content: 'ok',
      finishReason: 'stop',
      raw: { anything: true },
    });
    expect('raw' in resp).toBe(false);
    expect(aiSchemas.ChatChunk.parse({ type: 'delta', content: 'a' })).toEqual({
      type: 'delta',
      content: 'a',
    });
    expect(aiSchemas.ChatChunk.safeParse({ type: 'delta' }).success).toBe(false);
    expect(aiSchemas.ChatChunk.safeParse({ type: 'mystery' }).success).toBe(false);
  });

  it('UserProfile 顶层 loose；ProfilePatch 的 source 受限', () => {
    const profile = aiSchemas.UserProfile.parse({
      version: 1,
      identity: { nickname: 'n' },
      preferences: { replyLanguage: { value: 'zh', source: 'user', updatedAt: 1 } },
      habits: { topTools: [{ tool: 'x', count: 1 }] },
      dislikes: [],
      createdAt: 1,
      updatedAt: 2,
      chat: { maxHistoryLength: 10 },
    });
    expect(profile.chat).toEqual({ maxHistoryLength: 10 });
    expect(aiSchemas.ProfilePatch.safeParse({ patch: {}, source: 'hacker' }).success).toBe(false);
  });

  it('二进制字段要求 Uint8Array（Buffer 作为子类也可以）', () => {
    const pcm = { sampleRate: 16000, bitDepth: 16, channels: 1, data: new Uint8Array(4) };
    expect(aiSchemas.PcmChunk.safeParse(pcm).success).toBe(true);
    expect(aiSchemas.PcmChunk.safeParse({ ...pcm, data: [0, 0] }).success).toBe(false);
    expect(aiSchemas.PcmChunk.safeParse({ ...pcm, sampleRate: 44100 }).success).toBe(false);
  });
});

describe('appContract · 端到端（in-process，strict 序列化）', () => {
  function serve(trusted = true) {
    const handlers = Object.fromEntries(
      Object.entries(procedures).map(([name, def]) => [
        name,
        def.kind === 'stream'
          ? async function* () {}
          : () => {
              throw new Error(`${name} not stubbed`);
            },
      ]),
    ) as Record<string, unknown>;
    handlers['ai.sessions.list'] = () => [{ id: 's', title: 't', createdAt: 1, updatedAt: 1 }];
    handlers['ai.tools.confirm'] = () => undefined;
    handlers['ai.tts.synth'] = ({ text }: { text: string }) => ({
      reqId: 'r',
      providerId: 'p',
      mime: 'audio/mp3',
      data: new TextEncoder().encode(text),
    });
    handlers['ai.chat.stream'] = async function* () {
      yield { type: 'delta', content: 'a' };
      yield { type: 'done', finishReason: 'stop' };
    };
    const router = implement(appContract, handlers as unknown as Handlers<AppContract>);
    const server = createInProcessServer();
    server.serve(router);
    const api = createClient(appContract, server.connect({ surface: 'chat', trusted }));
    return { router, api };
  }

  it('query / mutation / stream / 事件都能跨序列化边界往返', async () => {
    const { api, router } = serve();
    expect(await api.ai.sessions.list()).toHaveLength(1);
    const audio = await api.ai.tts.synth({ text: 'hi' });
    expect(audio.data).toBeInstanceOf(Uint8Array);
    expect([...audio.data]).toEqual([104, 105]);

    const chunks: unknown[] = [];
    for await (const c of api.ai.chat.stream({ messages: [{ role: 'user', content: 'x' }] })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: 'delta', content: 'a' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const seen: unknown[] = [];
    api.on('ai.agent.step', (d) => seen.push(d));
    await api.$connect();
    await new Promise((r) => setTimeout(r, 0));
    router.events.publish('ai.agent.step', { step: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([{ step: 2 }]);
  });

  it('dangerous 的 tools.confirm 只接受 trusted 调用者', async () => {
    await expect(serve(true).api.ai.tools.confirm({ reqId: 'r', ok: true })).resolves.toBe(
      undefined,
    );
    await expect(serve(false).api.ai.tools.confirm({ reqId: 'r', ok: true })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(serve(false).api.ai.sessions.list()).resolves.toHaveLength(1);
  });
});
