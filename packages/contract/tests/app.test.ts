/**
 * 应用契约（`@nomi-ai/contract/app`）测试：取代两份 `channels.ts` 与它们的快照测试。
 *
 * - 过程表快照：名字、kind、dangerous 不漂移（原 IPC_METHODS 的 35 个方法）；
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
  aiProcedures,
  aiSchemas,
  appContract,
  NOMI_TRANSPORT_GLOBAL,
  type AppContract,
} from '../src/app';
import { createInProcessServer, withMissingHandlers } from '../src/testing';

/** 只看 AI 门面（`ai.*`）：P1b 各域的过程由 tests/domains.test.ts 覆盖 */
const procedures = Object.fromEntries(
  Object.entries(appContract.procedures as unknown as Record<string, ProcedureDef>).filter(([n]) =>
    n.startsWith('ai.'),
  ),
);
const aiEventNames = Object.keys(appContract.events).filter((n) => n.startsWith('ai.'));

describe('appContract · 过程表', () => {
  it('快照：37 个 AI 门面过程的 kind / dangerous', () => {
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
      'ai.avatar.emotion:mutation',
      'ai.avatar.gesture:mutation',
      'ai.avatar.activity:mutation',
      'ai.avatar.speaking:mutation',
      'ai.avatar.report:mutation',
    ]);
    expect(Object.keys(aiProcedures)).toHaveLength(37);
    expect(Object.keys(procedures)).toHaveLength(37);
    // C3：ai.avatar.* 改成语义过程（不留旧名）→ major
    expect(appContract.version).toEqual({ major: 2, minor: 1 });
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
    expect(aiArgsToInput(by('ai.avatar.emotion'), ['happy'])).toEqual({ name: 'happy' });
  });

  it('avatar：只收语义名，资源名（下划线 / 连字符）过不了线', () => {
    const gesture = procedures['ai.avatar.gesture']!.input;
    expect(gesture.safeParse({ name: 'thumbsUp' }).success).toBe(true);
    expect(gesture.safeParse({ name: 'thumbs_up' }).success).toBe(false);
    expect(gesture.safeParse({ name: 'think-on' }).success).toBe(false);
    const emotion = procedures['ai.avatar.emotion']!.input;
    expect(emotion.safeParse({ name: 'happy', weight: 0.4 }).success).toBe(true);
    expect(emotion.safeParse({ name: 'happy', weight: 2 }).success).toBe(false);
    const report = procedures['ai.avatar.report']!.input;
    expect(report.safeParse({ type: 'touched', hitbox: 'head' }).success).toBe(true);
    expect(report.safeParse({ type: 'clicked', hitbox: 'body', double: true }).success).toBe(true);
    expect(
      report.safeParse({
        type: 'scene',
        characterId: 'nomi',
        emotions: ['happy'],
        activities: ['idle'],
        gestures: ['thumbsUp'],
      }).success,
    ).toBe(true);
    expect(report.safeParse({ type: 'touched', hitbox: 'tail' }).success).toBe(false);
  });
});

describe('appContract · 事件', () => {
  it('AI_EVENTS 覆盖 AIClient 的 13 个业务事件，且都声明在契约里', () => {
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
        'avatar:touched',
        'avatar:clicked',
        'avatar:scene',
      ].sort(),
    );
    expect(Object.values(AI_EVENTS).sort()).toEqual(aiEventNames.sort());
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

  it('持久化数据的输出宽容旧值 / 手改值；对应的输入仍严格', () => {
    const out = (name: string) => procedures[name]!.output!;
    const inp = (name: string) => procedures[name]!.input;

    // 画像：旧版本的偏好枚举值、来源与缩进不让 get 整体失败，值原样返回
    const legacyProfile = {
      version: 1,
      identity: {},
      preferences: {
        replyStyle: { value: 'poetic', source: 'imported', updatedAt: 1 },
        tone: { value: 'cute', source: 'legacy', updatedAt: 1 },
        codeStyle: { indent: 8, quotes: 'backtick', packageManager: 'deno' },
      },
      habits: {},
      dislikes: [],
      createdAt: 1,
      updatedAt: 2,
    };
    expect(out('ai.memory.userProfile.get').parse(legacyProfile)).toEqual(legacyProfile);
    // 结构仍然校验：缺字段照样拒绝
    expect(out('ai.memory.userProfile.get').safeParse({ version: 1 }).success).toBe(false);
    // 输入严格：补丁来源不在枚举里拒绝
    expect(
      inp('ai.memory.userProfile.set').safeParse({ patch: {}, source: 'imported' }).success,
    ).toBe(false);

    // 事实：list / put 的输出放行旧 kind / source，put 的输入严格
    const legacyFact = { id: 'f', kind: 'hobby', text: 't', source: 'migrated', at: 1 };
    expect(out('ai.memory.facts.list').parse([legacyFact])).toEqual([legacyFact]);
    expect(out('ai.memory.facts.put').parse(legacyFact)).toEqual(legacyFact);
    expect(inp('ai.memory.facts.put').safeParse(legacyFact).success).toBe(false);
    expect(
      inp('ai.memory.facts.put').safeParse({ ...legacyFact, kind: 'note', source: 'user' }).success,
    ).toBe(true);

    // 会话 meta：手改出的嵌套值不让 list 失败；create 的输入 meta 仍严格
    const legacySession = {
      id: 's',
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      meta: { pinned: null, extra: { a: 1 } },
    };
    expect(out('ai.sessions.list').parse([legacySession])).toEqual([legacySession]);
    expect(inp('ai.sessions.create').safeParse({ meta: { extra: { a: 1 } } }).success).toBe(false);
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
    // 其他域的过程不在本测试关心范围内：没写的一律 NOT_FOUND
    const router = implement(
      appContract,
      withMissingHandlers(appContract, handlers as unknown as Partial<Handlers<AppContract>>),
    );
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
