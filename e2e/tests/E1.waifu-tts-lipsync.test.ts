/**
 * E1 · waifu profile · headless smoke
 *
 * 语义对齐：
 * - 真实内核（`createCore`）跑在无界面宿主 `@nomi-ai/host-node` 上，AI runtime 是生产的插件宿主 + `AIClient`；
 *   视图侧的 `ClientAIClient` 经 in-process 传输连进来（每个"窗口"一个连接）；
 * - 插件事件 `tts/chunk` → 订阅了的窗口收到 `tts:chunk`，其 `rms>0` 可驱动 `avatar.driveLipSync`；
 * - 插件事件 `agent/turn-end`（"回合完成"信号）→ 推给每个订阅了的窗口，没订阅的连接一帧都收不到
 *   （取代原 EventBroadcaster 的「按窗口订阅子集」）。
 *
 * 真实界面由 e2e-headed 覆盖，两套 E2E 的分工见 docs/development/testing.md。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeAvatarService } from '../helpers/fakeSeams';
import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

describe('E1 · waifu · tts chunk → lip sync + turn 完成广播', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('tts:chunk 推到订阅了的每个窗口，rms > 0 可驱动 avatar.driveLipSync', async () => {
    const waifuMain = core.openWindow({ surface: 'mascot', trusted: true });
    const waifuOverlay = core.openWindow({ surface: 'mascot', trusted: true });

    const avatar = createFakeAvatarService();
    const chunkAtA: Array<{ rms: number }> = [];
    const chunkAtB: Array<{ rms: number }> = [];

    waifuMain.client.on('tts:chunk', (p) => {
      const payload = p as { rms?: number };
      if (typeof payload.rms === 'number') {
        avatar.driveLipSync(payload.rms);
        chunkAtA.push({ rms: payload.rms });
      }
    });
    waifuOverlay.client.on('tts:chunk', (p) => {
      const payload = p as { rms?: number };
      if (typeof payload.rms === 'number') chunkAtB.push({ rms: payload.rms });
    });
    await core.settle(); // 订阅帧到达内核

    await core.emit('tts/chunk', {
      reqId: 'r-tts-1',
      seq: 0,
      mime: 'audio/mp3',
      data: new Uint8Array([0, 1]),
      rms: 0.65,
    });
    await core.emit('tts/chunk', {
      reqId: 'r-tts-1',
      seq: 1,
      mime: 'audio/mp3',
      data: new Uint8Array([0, 1]),
      rms: 0.42,
      isFinal: true,
    });

    expect(chunkAtA).toEqual([{ rms: 0.65 }, { rms: 0.42 }]);
    expect(chunkAtB).toEqual([{ rms: 0.65 }, { rms: 0.42 }]);
    expect(avatar.driveLipSyncCalls).toEqual([0.65, 0.42]);
    expect(avatar.driveLipSyncCalls.every((v) => v > 0)).toBe(true);
  });

  it('agent/turn-end（等价 message-complete）推给订阅了的窗口，未订阅的连接收不到', async () => {
    const waifuMain = core.openWindow({ surface: 'mascot', trusted: true });
    const chat = core.openWindow();
    const bystander = core.openWindow();
    const events: Array<unknown> = [];
    const chatEvents: Array<unknown> = [];
    waifuMain.client.on('agent:turn-end', (p) => events.push(p));
    chat.client.on('agent:turn-end', (p) => chatEvents.push(p));
    await core.settle(); // 订阅帧到达内核

    await core.emit('agent/turn-end', { sessionId: 's-e1', turnId: 't-1', ok: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's-e1', turnId: 't-1', ok: true });
    expect(chatEvents).toEqual(events);
    // 没有订阅任何事件、也没发过调用的连接一帧都收不到
    expect(bystander.transport.framesReceived).toBe(0);
  });
});
