import { describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../src/config';
import { runGatewayWorker, type WorkerInbound, type WorkerOutbound } from '../src/worker';

function fakePort() {
  let handler: ((e: { data: WorkerInbound }) => void) | null = null;
  const out: WorkerOutbound[] = [];
  const waiters: Array<() => void> = [];
  return {
    out,
    port: {
      on: (_ev: 'message', fn: (e: { data: WorkerInbound }) => void) => (handler = fn),
      postMessage: (m: WorkerOutbound) => {
        out.push(m);
        waiters.splice(0).forEach((w) => w());
      },
    },
    send: (data: WorkerInbound) => handler!({ data }),
    next: () => new Promise<void>((r) => waiters.push(r)),
  };
}

const cfg = (port = 0, extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
  host: '127.0.0.1',
  port,
  providers: [],
  clients: { codex: { token: 't', models: {} } },
  ...extra,
});

describe('gateway worker loop', () => {
  it('starts on the first config, hot-swaps later ones, reports errors and stops', async () => {
    const f = fakePort();
    runGatewayWorker(f.port);
    let wait = f.next();
    f.send({ type: 'config', config: cfg() });
    await wait;
    const listening = f.out[0] as Extract<WorkerOutbound, { type: 'listening' }>;
    expect(listening.type).toBe('listening');
    const health = await fetch(`${listening.url}/health`);
    expect(health.status).toBe(200);

    // 同一监听地址：只换配置，不重启（端口不变）
    f.send({ type: 'config', config: cfg(0, { providers: [] }) });
    const models = await fetch(`${listening.url}/v1/models`, {
      headers: { authorization: 'Bearer t' },
    });
    expect(models.status).toBe(200);
    expect(f.out).toHaveLength(1);

    // 端口被占用：报 fatal 错误
    const f2 = fakePort();
    runGatewayWorker(f2.port);
    wait = f2.next();
    f2.send({ type: 'config', config: cfg(listening.port) });
    await wait;
    expect(f2.out[0]).toMatchObject({ type: 'error', fatal: true });

    wait = f.next();
    f.send({ type: 'stop' });
    await wait;
    expect(f.out.at(-1)).toEqual({ type: 'stopped' });
    await expect(fetch(`${listening.url}/health`)).rejects.toThrow();
  });
});
