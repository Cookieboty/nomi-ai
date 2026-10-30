import { describe, expect, it } from 'vitest';

import { AvatarSeamPlugin } from '../../src/plugins/AvatarSeamPlugin';
import { AvatarKey } from '../../src/seams/avatar';
import { createFakeAvatarHost } from '../helpers/fakeAvatarHost';
import { createFakeCtx } from '../helpers/fakeCtx';

async function service(cfg: Parameters<typeof AvatarSeamPlugin.apply>[1] = {}) {
  const ctx = createFakeCtx();
  await AvatarSeamPlugin.apply(ctx, cfg);
  return { ctx, svc: ctx.inject(AvatarKey)! };
}

describe('AvatarSeamPlugin (semantic events, §10.5)', () => {
  it('provides AvatarService and starts without host', async () => {
    const { svc } = await service();
    expect(svc).toBeDefined();
    expect(svc.hasHost()).toBe(false);
    expect(svc.scene()).toBeNull();
  });

  it('no-ops emotion / gesture / activity when tolerateNoHost=true (default)', async () => {
    const { ctx, svc } = await service();
    await expect(svc.gesture('wave')).resolves.toBeUndefined();
    await expect(svc.emotion('happy')).resolves.toBeUndefined();
    await expect(svc.activity('thinking')).resolves.toBeUndefined();
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('no host'))).toBe(true);
  });

  it('throws when tolerateNoHost=false and no host attached', async () => {
    const { svc } = await service({ tolerateNoHost: false });
    await expect(svc.gesture('wave')).rejects.toThrow(/no host attached/);
  });

  it('forwards semantic events to the host; clamps weight and speaking level', async () => {
    const { svc } = await service();
    const host = createFakeAvatarHost();
    const detach = svc.attachHost(host);
    expect(svc.hasHost()).toBe(true);

    await svc.gesture('thumbsUp');
    await svc.emotion('happy', 3);
    await svc.emotion('sad');
    await svc.activity('toolRunning');
    svc.speaking(-5);
    svc.speaking(0.42);
    svc.speaking(Number.NaN);

    expect(host.record.gesture).toEqual(['thumbsUp']);
    expect(host.record.emotion).toEqual([{ name: 'happy', weight: 1 }, { name: 'sad' }]);
    expect(host.record.activity).toEqual(['toolRunning']);
    expect(host.record.speaking).toEqual([0, 0.42, 0]);

    detach();
    expect(svc.hasHost()).toBe(false);
  });

  it('ignores names outside the semantic vocabulary (resource names never reach the host)', async () => {
    const { ctx, svc } = await service();
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    await svc.gesture('thumbs_up' as never);
    await svc.emotion('smile_02' as never);
    await svc.activity('typing_loop' as never);
    expect(host.record).toEqual({ emotion: [], gesture: [], activity: [], speaking: [] });
    expect(ctx.logs.filter((l) => l.msg.includes('not a semantic name'))).toHaveLength(3);
  });

  it('dispatches reports from the character (touched / clicked / scene) to on(evt)', async () => {
    const { svc } = await service();
    const touched: unknown[] = [];
    const clicked: unknown[] = [];
    const scenes: unknown[] = [];
    svc.on('touched', (p) => touched.push(p.hitbox));
    svc.on('clicked', (p) => clicked.push([p.hitbox, p.double ?? false]));
    const off = svc.on('scene', (p) => scenes.push(p.characterId));

    svc.report({ type: 'touched', hitbox: 'head' });
    svc.report({ type: 'clicked', hitbox: 'body', double: true });
    svc.report({ type: 'clicked', hitbox: 'any' });
    svc.report({
      type: 'scene',
      characterId: 'test-dummy',
      emotions: ['neutral'],
      activities: ['idle'],
      gestures: [],
    });
    off();
    svc.report({ type: 'scene', characterId: 'x', emotions: [], activities: [], gestures: [] });

    expect(touched).toEqual(['head']);
    expect(clicked).toEqual([
      ['body', true],
      ['any', false],
    ]);
    expect(scenes).toEqual(['test-dummy']);
    expect(svc.scene()?.characterId).toBe('x');
  });

  it('replaces host on double attachHost', async () => {
    const { ctx, svc } = await service();
    const h1 = createFakeAvatarHost();
    const h2 = createFakeAvatarHost();
    const detach1 = svc.attachHost(h1);
    svc.attachHost(h2);
    detach1(); // 旧 host 的 detach 不影响新 host
    await svc.gesture('nod');
    expect(h1.record.gesture).toEqual([]);
    expect(h2.record.gesture).toEqual(['nod']);
    expect(ctx.logs.some((l) => l.msg.includes('replacing'))).toBe(true);
  });

  it('swallows host errors with a warn log', async () => {
    const { ctx, svc } = await service();
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    host.fail('gesture', new Error('boom'));
    await expect(svc.gesture('wave')).resolves.toBeUndefined();
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('gesture failed'))).toBe(true);
  });
});
