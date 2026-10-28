import { describe, expect, it } from 'vitest';

import { AvatarSeamPlugin } from '../../src/plugins/AvatarSeamPlugin';
import {
  AgentSensoryInjectEvent,
  TouchCooldown,
  TouchInjectPlugin,
  type AgentSensoryInjectPayload,
} from '../../src/plugins/TouchInjectPlugin';
import { AvatarKey } from '../../src/seams/avatar';
import { createFakeAvatarHost } from '../helpers/fakeAvatarHost';
import { createFakeCtx } from '../helpers/fakeCtx';

describe('TouchCooldown', () => {
  it('admits first hit and rejects subsequent within window', () => {
    const cd = new TouchCooldown(5_000);
    expect(cd.tryAdmit('Head', 0)).toBe(true);
    expect(cd.tryAdmit('Head', 100)).toBe(false);
    expect(cd.tryAdmit('Head', 4_999)).toBe(false);
    expect(cd.tryAdmit('Head', 5_000)).toBe(true);
  });

  it('tracks each area independently', () => {
    const cd = new TouchCooldown(5_000);
    expect(cd.tryAdmit('Head', 0)).toBe(true);
    expect(cd.tryAdmit('Body', 100)).toBe(true);
    expect(cd.tryAdmit('Head', 100)).toBe(false);
  });

  it('reset clears state', () => {
    const cd = new TouchCooldown(5_000);
    cd.tryAdmit('Head', 0);
    cd.reset();
    expect(cd.tryAdmit('Head', 10)).toBe(true);
  });
});

describe('TouchInjectPlugin', () => {
  async function setup(cfg: Parameters<typeof TouchInjectPlugin.apply>[1] = {}) {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    await TouchInjectPlugin.apply(ctx, cfg);
    return { ctx, host };
  }

  it('emits agent/sensory-inject on first hit and drops second within 5s', async () => {
    const { ctx, host } = await setup();
    host.emit('touch', { hitArea: 'Head', at: 1_000 });
    host.emit('touch', { hitArea: 'Head', at: 3_000 });

    const injected = ctx.events.filter((e) => e.evt === AgentSensoryInjectEvent) as Array<{
      evt: string;
      payload: AgentSensoryInjectPayload;
    }>;
    expect(injected).toHaveLength(1);
    expect(injected[0]!.payload).toMatchObject({
      channel: 'touch',
      data: { area: 'Head', at: 1_000 },
    });
  });

  it('allows the same area again after cooldown', async () => {
    const { ctx, host } = await setup({ cooldownMs: 1_000 });
    host.emit('touch', { hitArea: 'Head', at: 0 });
    host.emit('touch', { hitArea: 'Head', at: 999 });
    host.emit('touch', { hitArea: 'Head', at: 1_000 });
    const injected = ctx.events.filter((e) => e.evt === AgentSensoryInjectEvent);
    expect(injected).toHaveLength(2);
  });

  it('respects channel and hitAreaWhitelist config', async () => {
    const { ctx, host } = await setup({
      channel: 'affection',
      hitAreaWhitelist: ['Head'],
    });
    host.emit('touch', { hitArea: 'Head', at: 100, x: 0.5, y: 0.6 });
    host.emit('touch', { hitArea: 'Body', at: 200 });
    const injected = ctx.events.filter((e) => e.evt === AgentSensoryInjectEvent) as Array<{
      evt: string;
      payload: AgentSensoryInjectPayload;
    }>;
    expect(injected).toHaveLength(1);
    expect(injected[0]!.payload).toEqual({
      channel: 'affection',
      data: { area: 'Head', at: 100, x: 0.5, y: 0.6 },
    });
  });

  it('warns and no-ops when ctx.avatar is not provided', async () => {
    const ctx = createFakeCtx();
    await TouchInjectPlugin.apply(ctx, {});
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('not available'))).toBe(true);
    expect(ctx.events).toHaveLength(0);
  });

  it('dispose detaches listener and resets cooldown', async () => {
    const { ctx, host } = await setup();
    host.emit('touch', { hitArea: 'Head', at: 0 });
    expect(ctx.events).toHaveLength(1);
    await TouchInjectPlugin.dispose?.(ctx);
    host.emit('touch', { hitArea: 'Head', at: 100 });
    expect(ctx.events).toHaveLength(1);
  });
});
