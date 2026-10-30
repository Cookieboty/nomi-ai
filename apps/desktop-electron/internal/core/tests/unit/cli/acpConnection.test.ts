/**
 * ACP 传输层的超时 / 取消：卡住的 Gemini 不能让请求永远挂着。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { AcpConnection, AcpTimeoutError } from '../../../src/cli/gemini/acp';

function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & {
    sent: Array<Record<string, unknown>>;
    reply: (m: Record<string, unknown>) => void;
  };
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  child.sent = [];
  stdin.on('data', (c: Buffer) => {
    for (const l of c.toString('utf8').split('\n').filter(Boolean))
      child.sent.push(JSON.parse(l) as Record<string, unknown>);
  });
  Object.assign(child, { stdout, stdin, stderr: new PassThrough() });
  child.reply = (m) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  return child;
}

describe('AcpConnection timeouts', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejects with a translated AcpTimeoutError and calls onTimeout', async () => {
    const child = fakeChild();
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const onTimeout = jest.fn();
    const p = conn.request('initialize', {}, { timeoutMs: 1000, onTimeout });
    const caught = p.catch((e: unknown) => e);
    jest.advanceTimersByTime(1001);
    const err = await caught;
    expect(err).toBeInstanceOf(AcpTimeoutError);
    expect((err as Error).message).toContain('Gemini 响应超时（1 秒');
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // 迟到的应答被忽略
    child.reply({ id: 1, result: {} });
  });

  it('uses a default timeout for every request', async () => {
    const child = fakeChild();
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const caught = conn.request('session/new', {}).catch((e: unknown) => e);
    jest.advanceTimersByTime(120_001);
    expect(await caught).toBeInstanceOf(AcpTimeoutError);
  });

  it('idle requests restart the clock on activity and pause while the agent awaits us', async () => {
    // 假计时器：时间只在 advance 时前进，机器再忙也不会把 80ms 的间隔拉长成超时
    const child = fakeChild();
    let answer: (() => void) | null = null;
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: () => new Promise((r) => (answer = () => r({ ok: true }))),
    });
    const p = conn.request('session/prompt', {}, { idle: true, timeoutMs: 150 });
    let settled = false;
    const caught = p.catch((e: unknown) => e).finally(() => (settled = true));
    // 持续有动静：累计 320ms 也不超时（每次动静都重新计时）
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(80);
      child.reply({ method: 'session/update', params: {} });
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(settled).toBe(false);
    // 代理在等我们（权限确认）：等多久都不超时
    child.reply({ id: 900, method: 'session/request_permission', params: {} });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    answer!();
    await jest.advanceTimersByTimeAsync(20);
    child.reply({ id: 1, result: { stopReason: 'end_turn' } });
    await jest.advanceTimersByTimeAsync(0);
    expect(await caught).toEqual({ stopReason: 'end_turn' });
  });

  it('after the agent stops waiting on us, silence times the idle request out again', async () => {
    const child = fakeChild();
    let answer: (() => void) | null = null;
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: () => new Promise((r) => (answer = () => r({ ok: true }))),
    });
    const caught = conn
      .request('session/prompt', {}, { idle: true, timeoutMs: 150 })
      .catch((e: unknown) => e);
    child.reply({ id: 900, method: 'session/request_permission', params: {} });
    await jest.advanceTimersByTimeAsync(1000);
    answer!();
    await jest.advanceTimersByTimeAsync(151);
    expect(await caught).toBeInstanceOf(AcpTimeoutError);
  });

  it('an idle request with no activity times out', async () => {
    const child = fakeChild();
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const caught = conn
      .request('session/prompt', {}, { idle: true, timeoutMs: 500 })
      .catch((e: unknown) => e);
    jest.advanceTimersByTime(501);
    expect(await caught).toBeInstanceOf(AcpTimeoutError);
  });

  it('can be cancelled with an AbortSignal', async () => {
    const child = fakeChild();
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const ac = new AbortController();
    const caught = conn.request('initialize', {}, { signal: ac.signal }).catch((e: Error) => e);
    ac.abort();
    expect(((await caught) as Error).message).toBe('ACP request aborted');
    await expect(conn.request('initialize', {}, { signal: ac.signal })).rejects.toThrow('aborted');
  });

  it('leaves no timers behind once settled or closed', async () => {
    const child = fakeChild();
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const ok = conn.request('initialize', {});
    child.reply({ id: 1, result: { v: 1 } });
    await expect(ok).resolves.toEqual({ v: 1 });
    const pending = conn.request('session/new', {}).catch((e: Error) => e.message);
    (child as unknown as EventEmitter).emit('close');
    expect(await pending).toBe('ACP process exited');
    expect(jest.getTimerCount()).toBe(0);
  });
});
