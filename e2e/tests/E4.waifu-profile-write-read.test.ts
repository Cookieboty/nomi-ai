/**
 * E4 · waifu · userProfile.set → userProfile:changed → 下一次 chat 拿到最新值
 *
 * 语义对齐：
 * - 一个 waifu 主渲染窗口调用 `client.memory.userProfile.set({ patch })` 更新偏好；
 * - FakeProfileService 在 set 内部触发 `changed`，`createE2eRuntime` 桥接为 插件事件
 *   `userProfile/changed`，AIClient 的 UserProfileFacade 会把它映射为 `userProfile:changed`
 *   业务事件，经契约事件 `ai.userProfile.changed` 推给订阅了的窗口；
 * - 断言：
 *   1. 广播 payload.profile 与 set 后的 getPath 一致；
 *   2. 后续 chat.sendMessage 前后 profile.get() 拿到的是"最新"版本；
 *   3. 一个 second 渲染窗口也能收到 userProfile:changed。
 */

import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { createE2eRuntime, type E2eRuntimeHandle } from '../helpers/e2eRuntime';

describe('E4 · waifu · userProfile.set 后立即广播 & 下一次 chat 拿到最新值', () => {
  let handle: E2eRuntimeHandle;

  beforeEach(() => {
    handle = createE2eRuntime();
  });

  afterEach(() => {
    handle.dispose();
  });

  it('set → userProfile:changed 立即广播到所有窗口，且 getPath 返回最新值', async () => {
    const primary = handle.createRendererClient({ id: 701 });
    const secondary = handle.createRendererClient({ id: 702 });
    const client = new ClientAIClient({ bridge: primary.bridge });
    const bystander = new ClientAIClient({ bridge: secondary.bridge });

    const primaryChanges: unknown[] = [];
    const secondaryChanges: unknown[] = [];
    client.on('userProfile:changed', (p) => primaryChanges.push(p));
    bystander.on('userProfile:changed', (p) => secondaryChanges.push(p));
    await handle.settle(); // 订阅帧到达内核

    const userProfile = client.memory.userProfile as unknown as {
      set(input: { patch: Record<string, unknown>; source: 'user' }): Promise<unknown>;
      get(): Promise<unknown>;
    };

    const setResult = await userProfile.set({
      patch: {
        identity: { nickname: 'e2e-alice' },
      },
      source: 'user',
    });
    expect(setResult).toBeTruthy();

    await handle.settle(); // 事件帧到达两个窗口

    expect(primaryChanges).toHaveLength(1);
    expect(secondaryChanges).toHaveLength(1);
    expect(primaryChanges[0]).toMatchObject({
      profile: expect.objectContaining({
        identity: expect.objectContaining({ nickname: 'e2e-alice' }),
      }),
    });

    const latest = (await userProfile.get()) as { identity?: { nickname?: string } };
    expect(latest.identity?.nickname).toBe('e2e-alice');

    await client.dispose();
    await bystander.dispose();
  });

  it('下一次 chat.sendMessage 时，AIClient 侧 UserProfileService 已持有最新 nickname', async () => {
    const winA = handle.createRendererClient({ id: 711 });
    const client = new ClientAIClient({ bridge: winA.bridge });

    const userProfile = client.memory.userProfile as unknown as {
      set(input: { patch: Record<string, unknown>; source: 'user' }): Promise<unknown>;
    };
    await userProfile.set({
      patch: {
        identity: { nickname: 'e2e-bob' },
      },
      source: 'user',
    });

    const chat = client.chat as unknown as {
      sendMessage(opts: {
        provider: string;
        model: string;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{ content: string }>;
    };

    handle.llm.nextContent = 'greeted';
    const resp = await chat.sendMessage({
      provider: 'fake',
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.content).toBe('greeted');

    const snapshot = handle.profileService.get() as { identity?: { nickname?: string } };
    expect(snapshot.identity?.nickname).toBe('e2e-bob');

    await client.dispose();
  });
});
