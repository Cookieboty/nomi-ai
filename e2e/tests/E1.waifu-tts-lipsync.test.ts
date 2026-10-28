/**
 * E1 · waifu profile · headless smoke
 *
 * 语义对齐：
 * - 主进程侧真实构造 `AIClient` + `createAiRouter`（应用契约）+ 契约 IPC 传输（无 Electron，
 *   IPC 走内存版 ipcMain；LLM/Tool/UserProfile seams 由 e2e/helpers/fakeSeams 提供）；
 * - 一个"waifu 主渲染窗口"通过 `ClientAIClient` 订阅 AI 事件；
 * - 触发 插件事件 `tts/chunk` → 渲染窗口收到 `tts:chunk`，其 `rms>0` 可驱动 `avatar.driveLipSync`；
 * - 触发 插件事件 `agent/turn-end`（等价于 P8-3 里的"turn 完成/消息完成"信号）→ 推给每个订阅了的窗口，
 *   没订阅的窗口收不到（取代原 EventBroadcaster 的「按窗口订阅子集」）。
 *
 * 本用例不启动 Electron，以 `agent:turn-end` 作为回合完成信号；真实界面由 e2e-headed 覆盖，
 * 两套 E2E 的分工见 docs/development/testing.md。
 */

import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { createE2eRuntime, type E2eRuntimeHandle } from '../helpers/e2eRuntime';
import { createFakeAvatarService } from '../helpers/fakeSeams';

describe('E1 · waifu · tts chunk → lip sync + turn 完成广播', () => {
  let handle: E2eRuntimeHandle;

  beforeEach(() => {
    handle = createE2eRuntime();
  });

  afterEach(() => {
    handle.dispose();
  });

  it('tts:chunk 广播到所有渲染窗口，rms > 0 可驱动 avatar.driveLipSync', async () => {
    const waifuMain = handle.createRendererClient({ id: 501 });
    const waifuOverlay = handle.createRendererClient({ id: 502 });
    const clientA = new ClientAIClient({ bridge: waifuMain.bridge });
    const clientB = new ClientAIClient({ bridge: waifuOverlay.bridge });

    const avatar = createFakeAvatarService();
    const chunkAtA: Array<{ rms: number }> = [];
    const chunkAtB: Array<{ rms: number }> = [];

    const offA = clientA.on('tts:chunk', (p) => {
      const payload = p as { rms?: number };
      if (typeof payload.rms === 'number') {
        avatar.driveLipSync(payload.rms);
        chunkAtA.push({ rms: payload.rms });
      }
    });
    const offB = clientB.on('tts:chunk', (p) => {
      const payload = p as { rms?: number };
      if (typeof payload.rms === 'number') chunkAtB.push({ rms: payload.rms });
    });
    await handle.settle(); // 订阅帧到达内核

    await handle.ctx.triggerEvent('tts/chunk', {
      reqId: 'r-tts-1',
      seq: 0,
      mime: 'audio/mp3',
      data: new Uint8Array([0, 1]),
      rms: 0.65,
    });
    await handle.ctx.triggerEvent('tts/chunk', {
      reqId: 'r-tts-1',
      seq: 1,
      mime: 'audio/mp3',
      data: new Uint8Array([0, 1]),
      rms: 0.42,
      isFinal: true,
    });
    await handle.settle(); // 事件帧到达两个窗口

    expect(chunkAtA).toEqual([{ rms: 0.65 }, { rms: 0.42 }]);
    expect(chunkAtB).toEqual([{ rms: 0.65 }, { rms: 0.42 }]);
    expect(avatar.driveLipSyncCalls).toEqual([0.65, 0.42]);
    expect(avatar.driveLipSyncCalls.every((v) => v > 0)).toBe(true);

    offA();
    offB();
    await clientA.dispose();
    await clientB.dispose();
  });

  it('agent/turn-end（等价 message-complete）推给订阅了的窗口，未订阅的窗口收不到', async () => {
    const waifuMain = handle.createRendererClient({ id: 511 });
    const waifuOverlay = handle.createRendererClient({ id: 512 });
    const bystander = handle.createRendererClient({ id: 513 });
    const client = new ClientAIClient({ bridge: waifuMain.bridge });
    const overlay = new ClientAIClient({ bridge: waifuOverlay.bridge });
    const events: Array<unknown> = [];
    const overlayEvents: Array<unknown> = [];
    client.on('agent:turn-end', (p) => events.push(p));
    overlay.on('agent:turn-end', (p) => overlayEvents.push(p));
    await handle.settle(); // 订阅帧到达内核

    await handle.ctx.triggerEvent('agent/turn-end', {
      sessionId: 's-e1',
      turnId: 't-1',
      ok: true,
    });
    await handle.settle();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's-e1', turnId: 't-1', ok: true });
    expect(overlayEvents).toEqual(events);
    // 没有客户端订阅的窗口一帧都收不到
    expect(bystander.webContents.sent).toEqual([]);

    await client.dispose();
    await overlay.dispose();
  });
});
