/**
 * E4 · companion · userProfile.set → userProfile:changed → 下一次 chat 拿到最新值
 *
 * 语义对齐：
 * - 真实内核跑在无界面宿主上，用户画像是内核插件宿主里真实的 `UserPreferenceMemoryPlugin`（无界面宿主没有
 *   文件存储插件，画像只在内存里）；
 * - 一个桌面角色窗口调用 `client.memory.userProfile.set({ patch })`，画像变化经插件事件 `userProfile/changed`
 *   由 AIClient 映射成契约事件 `ai.userProfile.changed`，推给订阅了的窗口；
 * - 断言：
 *   1. 两个窗口都收到变化，payload.profile 与 set 后的 get 一致；
 *   2. 下一次 chat.sendMessage 时内核里的画像服务已是最新值。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

interface UserProfileApi {
  set(input: { patch: Record<string, unknown>; source: 'user' }): Promise<unknown>;
  get(): Promise<unknown>;
}

describe('E4 · companion · userProfile.set 后立即广播 & 下一次 chat 拿到最新值', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('set → userProfile:changed 推到订阅了的窗口，且 get 返回最新值', async () => {
    const primary = core.openWindow({ surface: 'mascot', trusted: true });
    const secondary = core.openWindow();

    const primaryChanges: unknown[] = [];
    const secondaryChanges: unknown[] = [];
    primary.client.on('userProfile:changed', (p) => primaryChanges.push(p));
    secondary.client.on('userProfile:changed', (p) => secondaryChanges.push(p));
    await core.settle(); // 订阅帧到达内核

    const userProfile = primary.client.memory.userProfile as unknown as UserProfileApi;
    const setResult = await userProfile.set({
      patch: { identity: { nickname: 'e2e-alice' } },
      source: 'user',
    });
    expect(setResult).toBeTruthy();
    await core.settle(); // 事件帧到达两个窗口

    expect(primaryChanges.length).toBeGreaterThanOrEqual(1);
    expect(secondaryChanges).toEqual(primaryChanges);
    expect(primaryChanges.at(-1)).toMatchObject({
      profile: expect.objectContaining({
        identity: expect.objectContaining({ nickname: 'e2e-alice' }),
      }),
    });

    const latest = (await userProfile.get()) as { identity?: { nickname?: string } };
    expect(latest.identity?.nickname).toBe('e2e-alice');
  });

  it('下一次 chat.sendMessage 时，内核的 UserProfileService 已持有最新 nickname', async () => {
    const { client } = core.openWindow();

    await (client.memory.userProfile as unknown as UserProfileApi).set({
      patch: { identity: { nickname: 'e2e-bob' } },
      source: 'user',
    });

    const chat = client.chat as unknown as {
      sendMessage(opts: {
        provider: string;
        model: string;
        messages: Array<{ role: string; content: string }>;
      }): Promise<{ content: string }>;
    };
    core.llm.nextContent = 'greeted';
    const resp = await chat.sendMessage({
      provider: 'fake',
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.content).toBe('greeted');

    const snapshot = core.profile().get() as { identity?: { nickname?: string } };
    expect(snapshot.identity?.nickname).toBe('e2e-bob');
  });
});
