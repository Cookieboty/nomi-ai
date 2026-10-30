/**
 * P5-7 集成测试 · 场景 3：memory.userProfile.set → 后续 chat.stream 携带的 systemPrompt
 * 会读取 tone。因 P5 阶段没有 systemPrompt 装配（P6 才落地），本测试收敛到
 * **userProfile.set 后 subscribe 能拿到新值 + get() 返回新值**，确保 tone 已入库。
 */

import { UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';

import { AIClient } from '../../src/AIClient';
import { createFakeSdkCtx } from '../helpers/fakeSdkCtx';
import { createFakeProfileService } from '../helpers/fakeSeams';

describe('AIClient · memory.userProfile', () => {
  it('set → subscribe → get sees the new tone', async () => {
    const ctx = createFakeSdkCtx();
    ctx.provide(UserProfileKey, createFakeProfileService());
    const client = new AIClient(ctx);

    const seen: string[] = [];
    const off = client.memory.userProfile.subscribe((p) => {
      const tone = p.preferences?.tone?.value;
      if (tone) seen.push(tone);
    });

    await client.memory.userProfile.set({
      patch: {
        preferences: {
          tone: { value: 'cute', source: 'user', updatedAt: 1 },
        },
      },
      source: 'user',
    });

    off();
    expect(seen).toEqual(['cute']);
    const after = client.memory.userProfile.get();
    expect(after.preferences.tone?.value).toBe('cute');
    await client.dispose();
  });

  it('subscribe unsubscribe stops receiving updates', async () => {
    const ctx = createFakeSdkCtx();
    ctx.provide(UserProfileKey, createFakeProfileService());
    const client = new AIClient(ctx);
    let hits = 0;
    const off = client.memory.userProfile.subscribe(() => hits++);
    off();
    await client.memory.userProfile.set({
      patch: { identity: { nickname: 'n' } },
      source: 'user',
    });
    expect(hits).toBe(0);
    await client.dispose();
  });

  it('facts + summaries CRUD in-memory', async () => {
    const ctx = createFakeSdkCtx();
    ctx.provide(UserProfileKey, createFakeProfileService());
    const client = new AIClient(ctx);

    client.memory.facts.put({
      id: 'f1',
      kind: 'preference',
      text: 'likes cats',
      source: 'user',
      at: 1,
    });
    expect(client.memory.facts.list()).toHaveLength(1);
    expect(client.memory.facts.delete('f1')).toBe(true);
    expect(client.memory.facts.list()).toHaveLength(0);

    client.memory.summaries.put({
      sessionId: 's1',
      summary: 'x',
      updatedAt: 1,
      stepCount: 1,
    });
    expect(client.memory.summaries.get('s1')?.summary).toBe('x');
    await client.dispose();
  });
});
