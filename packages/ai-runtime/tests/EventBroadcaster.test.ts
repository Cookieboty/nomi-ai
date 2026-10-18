/**
 * EventBroadcaster 集成测试。
 *
 * - 触发 插件事件 → 所有存活 wc 收到 `ai:event`；
 * - `isDestroyed()=true` 的 wc 被跳过；
 * - subscribe 过滤：`include` / `exclude` 生效；
 * - `stop()` 后不再广播。
 */

import { AIClient } from '@nomi-ai/ai-sdk';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { describe, it, expect } from 'vitest';

import {
  EVENT_BROADCAST_CHANNEL,
  EVENT_SUBSCRIBE_CHANNEL,
  EventBroadcaster,
} from '../src/EventBroadcaster';
import { NoopRuntimeLogger } from '../src/logger';

import { createFakeIpcAdapter } from './helpers/fakeIpc';
import { createFakeSdkCtx } from './helpers/fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
} from './helpers/fakeSeams';

function bootstrap() {
  const ctx = createFakeSdkCtx();
  ctx.provide(LLMRegistryKey, createFakeLLMRegistry(createFakeLLM()));
  ctx.provide(ToolRegistryKey, createFakeToolRegistry());
  ctx.provide(UserProfileKey, createFakeProfileService());
  const client = new AIClient(ctx);
  const adapter = createFakeIpcAdapter();
  const broadcaster = new EventBroadcaster({ adapter, logger: NoopRuntimeLogger });
  broadcaster.start(client);
  return { ctx, client, adapter, broadcaster };
}

describe('EventBroadcaster', () => {
  it('broadcasts 插件宿主 event to all live web contents', async () => {
    const { ctx, adapter } = bootstrap();
    const wc1 = adapter.addWebContents(1);
    const wc2 = adapter.addWebContents(2);

    await ctx.triggerEvent('agent/turn-end', {
      sessionId: 's1',
      turnId: 't1',
      ok: true,
    });

    for (const wc of [wc1, wc2]) {
      const evtMsg = wc.sent.find((m) => m.channel === EVENT_BROADCAST_CHANNEL);
      expect(evtMsg).toBeTruthy();
      const payload = evtMsg!.payload as { evt: string; data: { sessionId: string } };
      expect(payload.evt).toBe('agent:turn-end');
      expect(payload.data.sessionId).toBe('s1');
    }
  });

  it('skips destroyed web contents', async () => {
    const { ctx, adapter } = bootstrap();
    const wcLive = adapter.addWebContents(1);
    const wcDead = adapter.addWebContents(2);
    wcDead.destroy();

    await ctx.triggerEvent('tts/end', { reqId: 'r1', ok: true });

    expect(wcLive.sent.some((m) => m.channel === EVENT_BROADCAST_CHANNEL)).toBe(true);
    expect(wcDead.sent.length).toBe(0);
  });

  it('respects per-window subscribe filter (exclude)', async () => {
    const { ctx, adapter } = bootstrap();
    const wcAll = adapter.addWebContents(11);
    const wcFiltered = adapter.addWebContents(22);

    adapter.emitTo(22, EVENT_SUBSCRIBE_CHANNEL, { exclude: ['tool:executed'] });

    await ctx.triggerEvent('tools/post-execute', { toolName: 't', reqId: 'r', ok: true });

    expect(wcAll.sent.some((m) => m.channel === EVENT_BROADCAST_CHANNEL)).toBe(true);
    expect(wcFiltered.sent.some((m) => m.channel === EVENT_BROADCAST_CHANNEL)).toBe(false);
  });

  it('drops a subscribe filter after its window is gone', async () => {
    const { ctx, adapter } = bootstrap();
    const wc = adapter.addWebContents(7);
    adapter.emitTo(7, EVENT_SUBSCRIBE_CHANNEL, { include: ['tts:end'] });
    const idx = adapter.webContents.indexOf(wc);
    adapter.webContents.splice(idx, 1);

    await ctx.triggerEvent('agent/turn-end', { sessionId: 's', turnId: 't', ok: true });

    const again = adapter.addWebContents(7);
    await ctx.triggerEvent('agent/turn-end', { sessionId: 's2', turnId: 't2', ok: true });
    expect(again.sent.some((m) => m.channel === EVENT_BROADCAST_CHANNEL)).toBe(true);
  });

  it('stop() detaches listeners', async () => {
    const { ctx, adapter, broadcaster } = bootstrap();
    const wc = adapter.addWebContents(1);
    broadcaster.stop();
    await ctx.triggerEvent('tts/end', { reqId: 'r1', ok: true });
    expect(wc.sent.length).toBe(0);
  });
});
