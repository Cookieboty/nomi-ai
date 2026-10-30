import type { ChatMessage } from '@nomi-ai/bundle-ig-base';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';

import { AIClient } from '../../src/AIClient';
import {
  DEFAULT_CONTEXT_BUDGET,
  estimateTokens,
  fitMessagesToBudget,
} from '../../src/facade/chatContext';
import { createFakeSdkCtx } from '../helpers/fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
} from '../helpers/fakeSeams';

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const sys = (content: string): ChatMessage => ({ role: 'system', content });

describe('estimateTokens', () => {
  it('counts CJK characters ~1 token each and ASCII ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('你好abcd')).toBe(3);
  });
});

describe('fitMessagesToBudget', () => {
  it('keeps everything when within budget', () => {
    const msgs = [sys('be nice'), u('q1'), a('a1'), u('q2')];
    expect(fitMessagesToBudget(msgs)).toEqual(msgs);
  });

  it('drops oldest turns first, keeps system prompt and the latest message', () => {
    const long = 'x'.repeat(400); // ~100 tokens + 4 overhead
    const msgs = [sys('S'), u(long), a(long), u(long), a(long), u('latest')];
    const out = fitMessagesToBudget(msgs, { maxTokens: 120 });
    expect(out[0]).toEqual(sys('S'));
    expect(out[out.length - 1]).toEqual(u('latest'));
    // 预算只够最新一条 + 一条历史；开头孤立的 assistant 被丢弃
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('starts the window on a user turn when assistant would be orphaned', () => {
    const msgs = [u('q1'), a('a1'), u('q2'), a('a2'), u('q3')];
    expect(fitMessagesToBudget(msgs, { maxMessages: 4 }).map((m) => m.content)).toEqual([
      'q2',
      'a2',
      'q3',
    ]);
  });

  it('respects maxMessages', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? u(`q${i}`) : a(`a${i}`)));
    msgs.push(u('last'));
    const out = fitMessagesToBudget(msgs, { maxMessages: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[out.length - 1]!.content).toBe('last');
    expect(out[0]!.role).toBe('user');
  });

  it('truncates an oversized latest message but never drops system prompts', () => {
    const out = fitMessagesToBudget([sys('rules'), u('y'.repeat(4000))], { maxTokens: 100 });
    expect(out[0]).toEqual(sys('rules'));
    expect(out[1]!.content.endsWith('…[truncated]')).toBe(true);
    expect(out[1]!.content.length).toBeLessThan(4000);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_CONTEXT_BUDGET.maxTokens).toBeGreaterThan(1000);
    expect(fitMessagesToBudget([])).toEqual([]);
  });
});

describe('ChatFacade · history', () => {
  function wire() {
    const ctx = createFakeSdkCtx();
    const llm = createFakeLLM('fake');
    ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));
    ctx.provide(ToolRegistryKey, createFakeToolRegistry());
    ctx.provide(UserProfileKey, createFakeProfileService());
    return { client: new AIClient(ctx), llm };
  }

  it('forwards the full conversation (stream + non-stream) to the provider', async () => {
    const { client, llm } = wire();
    const convo = [sys('S'), u('q1'), a('a1'), u('q2')];
    await client.chat.sendMessage({ messages: convo });
    for await (const _ of client.chat.stream({ messages: convo })) {
      /* drain */
    }
    expect(llm.chatCalls[0]!.messages).toEqual(convo);
    expect(llm.streamCalls[0]!.messages).toEqual(convo);
    await client.dispose();
  });

  it('applies the context budget, or skips it with context: false', async () => {
    const { client, llm } = wire();
    const big = 'z'.repeat(400);
    const convo = [sys('S'), u(big), a(big), u('q')];
    await client.chat.sendMessage({ messages: convo, context: { maxTokens: 50 } });
    await client.chat.sendMessage({ messages: convo, context: false });
    expect(llm.chatCalls[0]!.messages.map((m) => m.content)).toEqual(['S', 'q']);
    expect(llm.chatCalls[1]!.messages).toEqual(convo);
    await client.dispose();
  });
});
