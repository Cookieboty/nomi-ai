import { describe, expect, it } from 'vitest';

import { AvatarSeamPlugin } from '../../src/plugins/AvatarSeamPlugin';
import { AvatarKey } from '../../src/seams/avatar';
import { createFakeAvatarHost } from '../helpers/fakeAvatarHost';
import { createFakeCtx } from '../helpers/fakeCtx';

describe('AvatarSeamPlugin', () => {
  it('provides AvatarService and starts without host', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey);
    expect(svc).toBeDefined();
    expect(svc!.hasHost()).toBe(false);
  });

  it('noop playMotion / setExpression when tolerateNoHost=true (default)', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    await expect(svc.playMotion('idle')).resolves.toBeUndefined();
    await expect(svc.setExpression('smile')).resolves.toBeUndefined();
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('no host'))).toBe(true);
  });

  it('throws when tolerateNoHost=false and no host attached', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, { tolerateNoHost: false });
    const svc = ctx.inject(AvatarKey)!;
    await expect(svc.playMotion('idle')).rejects.toThrow(/no host attached/);
  });

  it('attaches host and forwards playMotion/setExpression/driveLipSync', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    const detach = svc.attachHost(host);
    expect(svc.hasHost()).toBe(true);

    await svc.playMotion('idle', 0);
    await svc.setExpression('smile');
    svc.driveLipSync(0.42);

    expect(host.record.playMotion).toEqual([{ group: 'idle', index: 0 }]);
    expect(host.record.setExpression).toEqual(['smile']);
    expect(host.record.driveLipSync).toEqual([0.42]);

    detach();
    expect(svc.hasHost()).toBe(false);
  });

  it('clamps driveLipSync rms into [0, 1]', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);

    svc.driveLipSync(-5);
    svc.driveLipSync(999);
    svc.driveLipSync(Number.NaN);
    svc.driveLipSync(0.5);
    expect(host.record.driveLipSync).toEqual([0, 1, 0, 0.5]);
  });

  it('forwards host events (touch / motion:end) to on(evt) listeners', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);

    const touches: unknown[] = [];
    const ends: unknown[] = [];
    svc.on('touch', (p) => touches.push(p));
    svc.on('motion:end', (p) => ends.push(p));

    host.emit('touch', { hitArea: 'Head', at: 1_000 });
    host.emit('motion:end', { group: 'idle', index: 0 });

    expect(touches).toEqual([{ hitArea: 'Head', at: 1_000 }]);
    expect(ends).toEqual([{ group: 'idle', index: 0 }]);
  });

  it('replaces host on double attachHost and detaches old one', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const h1 = createFakeAvatarHost();
    const h2 = createFakeAvatarHost();
    svc.attachHost(h1);
    svc.attachHost(h2);

    const received: unknown[] = [];
    svc.on('touch', (p) => received.push(p));
    h1.emit('touch', { hitArea: 'H1', at: 1 });
    h2.emit('touch', { hitArea: 'H2', at: 2 });

    expect(received).toEqual([{ hitArea: 'H2', at: 2 }]);
    expect(ctx.logs.some((l) => l.msg.includes('replacing'))).toBe(true);
  });

  it('swallows host errors in playMotion/setExpression with warn log', async () => {
    const ctx = createFakeCtx();
    await AvatarSeamPlugin.apply(ctx, {});
    const svc = ctx.inject(AvatarKey)!;
    const host = createFakeAvatarHost();
    svc.attachHost(host);
    host.fail('playMotion', new Error('boom'));

    await expect(svc.playMotion('idle')).resolves.toBeUndefined();
    expect(ctx.logs.some((l) => l.level === 'warn' && l.msg.includes('playMotion failed'))).toBe(
      true,
    );
  });
});
