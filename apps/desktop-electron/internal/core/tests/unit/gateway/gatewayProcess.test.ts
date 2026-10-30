import { EventEmitter } from 'node:events';

import type { GatewayConfig, WorkerInbound, WorkerOutbound } from '@nomi-ai/gateway';

import {
  GatewayProcess,
  type GatewayChild,
  type GatewayStatus,
} from '../../../src/gateway/GatewayProcess';

class FakeChild extends EventEmitter implements GatewayChild {
  sent: WorkerInbound[] = [];
  killed = false;
  postMessage(m: WorkerInbound) {
    this.sent.push(m);
  }
  kill() {
    this.killed = true;
    return true;
  }
  say(m: WorkerOutbound) {
    this.emit('message', m);
  }
  die(code = 1) {
    this.emit('exit', code);
  }
}

const cfg = (port = 18721): GatewayConfig => ({
  host: '127.0.0.1',
  port,
  providers: [],
  clients: {},
});

function setup(lazy = false) {
  const children: FakeChild[] = [];
  const statuses: GatewayStatus[] = [];
  const usage: unknown[] = [];
  const learned: unknown[] = [];
  const gp = new GatewayProcess({
    logger: { info() {}, warn() {} },
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    backoffMs: () => 1,
    lazy,
    onStatus: (s) => statuses.push(s),
    onUsage: (e) => usage.push(e),
    onLearn: (e) => learned.push(e),
  });
  return { gp, children, statuses, usage, learned };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('GatewayProcess', () => {
  it('spawns on the first config, pushes later configs to the same process, forwards usage', async () => {
    const t = setup();
    const ready = t.gp.whenReady(1000);
    t.gp.apply(cfg());
    expect(t.children).toHaveLength(1);
    expect(t.children[0]!.sent[0]).toEqual({ type: 'config', config: cfg() });
    t.children[0]!.say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
    await expect(ready).resolves.toBe(true);
    expect(t.gp.getStatus()).toMatchObject({ state: 'running', port: 18721 });
    t.gp.apply(cfg(18721));
    expect(t.children).toHaveLength(1);
    expect(t.children[0]!.sent).toHaveLength(2);
    t.children[0]!.say({ type: 'usage', event: { client: 'nomi' } as never });
    expect(t.usage).toHaveLength(1);
    t.children[0]!.say({
      type: 'learn',
      event: { type: 'dropped-param', providerId: 'p', wire: 'chat', param: 'store' },
    });
    expect(t.learned).toHaveLength(1);
  });

  it('restarts after a crash with backoff and fuses after 5 failures in the window', async () => {
    const t = setup();
    t.gp.apply(cfg());
    for (let i = 0; i < 4; i++) {
      t.children[i]!.die(1);
      await tick();
    }
    expect(t.children).toHaveLength(5);
    expect(t.gp.getStatus().state).not.toBe('failed');
    t.children[4]!.die(1);
    await tick();
    expect(t.children).toHaveLength(5);
    expect(t.gp.getStatus()).toMatchObject({ state: 'failed' });
    expect(String((t.gp.getStatus() as { error: string }).error)).toMatch(/5/);
    await expect(t.gp.whenReady(10)).resolves.toBe(false);
    // 用户点「重试」清零熔断
    t.gp.retry();
    expect(t.children).toHaveLength(6);
  });

  it('successful listening clears the crash-fuse window', async () => {
    const now = 1_000;
    const children: FakeChild[] = [];
    const gp = new GatewayProcess({
      logger: { info() {}, warn() {} },
      fork: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      backoffMs: () => 1,
      now: () => now,
      crashFuseMax: 3,
      crashFuseWindowMs: 60_000,
    });
    gp.apply(cfg());
    children[0]!.die(1);
    await tick();
    children[1]!.die(1);
    await tick();
    children[2]!.say({ type: 'listening', port: 1, url: 'http://127.0.0.1:1' });
    children[2]!.die(1);
    await tick();
    // 成功后计数清零，再崩两次仍未熔断（max=3）
    expect(gp.getStatus().state).not.toBe('failed');
    expect(children).toHaveLength(4);
  });

  it('a fatal start error (port in use) stops retrying; a successful start resets the counter', async () => {
    const t = setup();
    t.gp.apply(cfg());
    t.children[0]!.say({ type: 'error', message: 'EADDRINUSE', fatal: true });
    expect(t.gp.getStatus()).toEqual({ state: 'failed', error: 'EADDRINUSE' });
    expect(t.children[0]!.killed).toBe(true);
    t.children[0]!.die(0);
    await tick();
    expect(t.children).toHaveLength(1);
  });

  it('whenReady times out while starting; stop() is final', async () => {
    const t = setup();
    t.gp.apply(cfg());
    await expect(t.gp.whenReady(10)).resolves.toBe(false);
    t.gp.stop();
    expect(t.children[0]!.sent.at(-1)).toEqual({ type: 'stop' });
    expect(t.gp.getStatus()).toEqual({ state: 'stopped' });
    t.children[0]!.die(0);
    await tick();
    expect(t.children).toHaveLength(1);
  });

  describe('按需启动（lazy）', () => {
    it('apply 只记配置；第一次 whenReady 才拉起进程，之后照常推配置', async () => {
      const t = setup(true);
      t.gp.apply(cfg());
      expect(t.children).toHaveLength(0);
      expect(t.gp.getStatus().state).toBe('stopped');
      const ready = t.gp.whenReady(1000);
      expect(t.children).toHaveLength(1);
      expect(t.children[0]!.sent[0]).toEqual({ type: 'config', config: cfg() });
      t.children[0]!.say({ type: 'listening', port: 18721, url: 'http://127.0.0.1:18721' });
      await expect(ready).resolves.toBe(true);
      t.gp.apply(cfg(18722));
      expect(t.children).toHaveLength(1);
      expect(t.children[0]!.sent[1]).toEqual({ type: 'config', config: cfg(18722) });
    });

    it('ensureStarted 在配置到达前调用：配置一到就拉起；重复调用不多起进程', () => {
      const t = setup(true);
      t.gp.ensureStarted();
      expect(t.children).toHaveLength(0);
      t.gp.apply(cfg());
      expect(t.children).toHaveLength(1);
      t.gp.ensureStarted();
      t.gp.ensureStarted();
      expect(t.children).toHaveLength(1);
    });

    it('拉起后崩溃照样重启并熔断；熔断后 ensureStarted / whenReady 不再拉起，retry 才重来', async () => {
      const t = setup(true);
      t.gp.apply(cfg());
      t.gp.ensureStarted();
      for (let i = 0; i < 5; i++) {
        t.children[t.children.length - 1]!.die(1);
        await tick();
      }
      expect(t.gp.getStatus().state).toBe('failed');
      const n = t.children.length;
      t.gp.ensureStarted();
      await expect(t.gp.whenReady(50)).resolves.toBe(false);
      expect(t.children).toHaveLength(n);
      t.gp.retry();
      expect(t.children).toHaveLength(n + 1);
    });
  });
});
