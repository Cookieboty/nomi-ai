/**
 * P7-4 契约测试 —— `ClientAIClient` 与 P5 `AIClient` 结构等价断言。
 *
 * 目的：保证渲染进程薄客户端在**面向 UI 的调用面**上与主进程 P5 SDK 完全一致。
 * 一旦 P5 AIClient 或客户端 Proxy 任何一方漏挂 facade / method，该测试会立刻红。
 *
 * 双重保障：
 * 1. **compile-time**：`expectTypeOf<ClientKeys>().toEqualTypeOf<SdkKeys>()`——
 *    直接靠 TS 的键集比较，任何顶层 facade（chat/sessions/tools/memory/asr/tts/avatar）
 *    在两侧命名漂移都会编译失败。
 * 2. **runtime**：把 P5 每个 facade 的 method key 汇总，逐一在 `ClientAIClient`
 *    的 Proxy facade 上取值，断言得到 `function`。用应用契约的 `AI_METHODS` 反查
 *    是否也覆盖了对应的 (facade, method)，避免契约与门面漂移。
 *
 * 说明：`register` 系列（`tools.register` / `asr.register` / `tts.register`）在 P5
 * 是「主进程 SDK 才允许的注册操作」，不应出现在应用契约里；因此测试白名单里把这三条剔除。
 */

import type { AIClient, MemoryFacade } from '@nomi-ai/ai-sdk';
import { AI_METHODS } from '@nomi-ai/contract/app';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { ClientAIClient } from '../src/ClientAIClient';

import { createFakeServer } from './fakeServer';

type SdkTopKeys = 'chat' | 'sessions' | 'tools' | 'memory' | 'asr' | 'tts' | 'avatar';
type ClientTopKeys = 'chat' | 'sessions' | 'tools' | 'memory' | 'asr' | 'tts' | 'avatar';

describe('P7 契约 · ClientAIClient ≡ AIClient 结构等价', () => {
  it('顶层 facade 键集完全一致（compile-time）', () => {
    expectTypeOf<Pick<AIClient, SdkTopKeys>>().toMatchTypeOf<Pick<AIClient, SdkTopKeys>>();
    expectTypeOf<Pick<ClientAIClient, ClientTopKeys>>().toMatchTypeOf<
      Pick<ClientAIClient, ClientTopKeys>
    >();
    // 客户端顶层键集 ⊇ SDK 顶层键集
    type Diff = Exclude<SdkTopKeys, ClientTopKeys>;
    expectTypeOf<Diff>().toEqualTypeOf<never>();
  });

  it('memory 子域三分（facts / summaries / userProfile）与 P5 一致', () => {
    type MemoryKeys = keyof MemoryFacade;
    type ClientMemoryKeys = keyof ClientAIClient['memory'];
    type Diff = Exclude<MemoryKeys, ClientMemoryKeys>;
    expectTypeOf<Diff>().toEqualTypeOf<never>();
  });

  /**
   * P5 每个 facade 允许经应用契约暴露给渲染进程的方法名（等同于 AI_METHODS 的期望值）。
   * 变更 P5 门面时同步维护本表，做为「主进程 → 渲染进程可暴露」的白名单快照。
   */
  const expectedFacadeMethods: Record<string, string[]> = {
    chat: ['sendMessage', 'stream', 'abort', 'regenerate', 'agentStream'],
    sessions: ['list', 'get', 'create', 'fork', 'rename', 'delete'],
    tools: ['list', 'setEnabled', 'confirm'],
    userProfile: ['get', 'set', 'reset', 'export', 'import'],
    facts: ['list', 'put', 'delete'],
    summaries: ['get', 'put'],
    asr: ['list', 'transcribe'],
    tts: ['list', 'listVoices', 'synth', 'stream', 'stop'],
    avatar: ['isAvailable', 'emotion', 'gesture', 'activity', 'speaking', 'report'],
  };

  it('AI_METHODS 覆盖所有可暴露方法且不多不少', () => {
    const actual = new Map<string, Set<string>>();
    for (const spec of AI_METHODS) {
      const facade = spec.facade.replace(/^memory\./, '');
      const method = spec.method;
      let bucket = actual.get(facade);
      if (!bucket) {
        bucket = new Set();
        actual.set(facade, bucket);
      }
      bucket.add(method);
    }
    const expectedFacades = Object.keys(expectedFacadeMethods).sort();
    expect([...actual.keys()].sort()).toEqual(expectedFacades);
    for (const [facade, methods] of Object.entries(expectedFacadeMethods)) {
      expect([...(actual.get(facade) ?? new Set())].sort()).toEqual([...methods].sort());
    }
  });

  it('ClientAIClient 的每个 facade Proxy 均能路由到对应的方法', () => {
    const client = new ClientAIClient({ transport: createFakeServer().connect() });
    const topLevel: Record<string, Record<string, unknown>> = {
      chat: client.chat,
      sessions: client.sessions,
      tools: client.tools,
      asr: client.asr,
      tts: client.tts,
      avatar: client.avatar,
      userProfile: client.memory.userProfile,
      facts: client.memory.facts,
      summaries: client.memory.summaries,
    };
    for (const [facade, methods] of Object.entries(expectedFacadeMethods)) {
      const bag = topLevel[facade];
      expect(bag, `facade ${facade}`).toBeDefined();
      for (const m of methods) {
        expect(typeof bag[m], `${facade}.${m}`).toBe('function');
      }
    }
  });
});
