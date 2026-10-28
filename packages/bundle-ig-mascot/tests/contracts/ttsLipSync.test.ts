import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarSeamPlugin } from '../../src/plugins/AvatarSeamPlugin';
import { RmsThrottler, TtsLipSyncPlugin } from '../../src/plugins/TtsLipSyncPlugin';
import { AvatarKey } from '../../src/seams/avatar';
import { createFakeAvatarHost } from '../helpers/fakeAvatarHost';
import { createFakeCtx } from '../helpers/fakeCtx';

describe('RmsThrottler', () => {
  it('admits first sample and rejects until minGapMs passes', () => {
    const th = new RmsThrottler(50);
    expect(th.admit(0)).toBe(true);
    expect(th.admit(10)).toBe(false);
    expect(th.admit(49)).toBe(false);
    expect(th.admit(50)).toBe(true);
  });

  it('always admits isFinal (and resets the gap anchor)', () => {
    const th = new RmsThrottler(50);
    th.admit(0);
    expect(th.admit(1, true)).toBe(true);
    expect(th.admit(2)).toBe(false);
    expect(th.admit(52)).toBe(true);
  });

  it('reset clears state', () => {
    const th = new RmsThrottler(50);
    th.admit(1_000);
    th.reset();
    expect(th.admit(1_010)).toBe(true);
  });
});

describe('TtsLipSyncPlugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(cfg: Parameters<typeof TtsLipSyncPlugin.apply>[1] = {}) {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    await TtsLipSyncPlugin.apply(ctx, cfg);
    return { ctx, host };
  }

  it('throttles tts/chunk at ~20fps (50ms) by default', async () => {
    const { ctx, host } = await setup();
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(i * 10);
      await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: i, rms: 0.5 });
    }
    // 0 / 50 / 100 都拿到 (i=0,5)；i=0 时立刻取；再取 5 表示 t=50
    expect(host.record.driveLipSync.length).toBeLessThanOrEqual(3);
    expect(host.record.driveLipSync.length).toBeGreaterThanOrEqual(2);
  });

  it('always drives lip on isFinal chunk', async () => {
    const { ctx, host } = await setup();
    vi.setSystemTime(0);
    await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: 0, rms: 0.5 });
    vi.setSystemTime(1);
    await ctx.triggerEvent('tts/chunk', {
      reqId: 'r',
      seq: 1,
      rms: 0.9,
      isFinal: true,
    });
    expect(host.record.driveLipSync).toEqual([0.5, 0.9]);
  });

  it('missing rms defaults to 0 (no NaN)', async () => {
    const { ctx, host } = await setup();
    vi.setSystemTime(0);
    await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: 0 });
    expect(host.record.driveLipSync).toEqual([0]);
  });

  it('tts/end resets throttler, drives 0 and plays idle motion', async () => {
    const { ctx, host } = await setup({ idleMotionGroup: 'idle' });
    vi.setSystemTime(0);
    await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: 0, rms: 0.5 });
    await ctx.triggerEvent('tts/end', { reqId: 'r' });
    expect(host.record.driveLipSync).toEqual([0.5, 0]);
    expect(host.record.playMotion).toEqual([{ group: 'idle', index: undefined }]);
  });

  it('resetOnEnd=false skips idle motion & zero lip', async () => {
    const { ctx, host } = await setup({ resetOnEnd: false });
    vi.setSystemTime(0);
    await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: 0, rms: 0.5 });
    await ctx.triggerEvent('tts/end', { reqId: 'r' });
    expect(host.record.driveLipSync).toEqual([0.5]);
    expect(host.record.playMotion).toEqual([]);
  });

  it('dispose removes chunk/end handlers', async () => {
    const { ctx, host } = await setup();
    await TtsLipSyncPlugin.dispose?.(ctx);
    vi.setSystemTime(0);
    await ctx.triggerEvent('tts/chunk', { reqId: 'r', seq: 0, rms: 0.5 });
    await ctx.triggerEvent('tts/end', { reqId: 'r' });
    expect(host.record.driveLipSync).toEqual([]);
    expect(host.record.playMotion).toEqual([]);
  });
});
