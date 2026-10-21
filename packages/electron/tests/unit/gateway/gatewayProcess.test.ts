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

function setup() {
  const children: FakeChild[] = [];
  const statuses: GatewayStatus[] = [];
  const usage: unknown[] = [];
  const gp = new GatewayProcess({
    logger: { info() {}, warn() {} },
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    backoffMs: () => 1,
    onStatus: (s) => statuses.push(s),
    onUsage: (e) => usage.push(e),
  });
  return { gp, children, statuses, usage };
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
  });

  it('restarts after a crash with backoff and gives up after 3 failures', async () => {
    const t = setup();
    t.gp.apply(cfg());
    t.children[0]!.die(1);
    await tick();
    expect(t.children).toHaveLength(2);
    expect(t.children[1]!.sent[0]).toMatchObject({ type: 'config' });
    t.children[1]!.die(1);
    await tick();
    t.children[2]!.die(1);
    await tick();
    expect(t.children).toHaveLength(3);
    expect(t.gp.getStatus()).toMatchObject({ state: 'failed' });
    await expect(t.gp.whenReady(10)).resolves.toBe(false);
    // 用户点「重试」
    t.gp.retry();
    expect(t.children).toHaveLength(4);
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
});
