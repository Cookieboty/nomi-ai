import { createShutdown, LifecycleRegistry } from '../../../src/core/lifecycle';

describe('LifecycleRegistry', () => {
  it('后注册先停止，且 stopAll 幂等', async () => {
    const order: string[] = [];
    const r = new LifecycleRegistry();
    r.register({ name: 'a', stop: () => void order.push('a') });
    r.register({ name: 'b', stop: async () => void order.push('b') });
    r.register({ name: 'c', stop: () => void order.push('c') });
    await r.stopAll();
    expect(order).toEqual(['c', 'b', 'a']);
    await r.stopAll();
    expect(order).toHaveLength(3);
  });

  it('同名注册视为替换；没有 stop 的服务被跳过', async () => {
    const stop1 = jest.fn();
    const stop2 = jest.fn();
    const r = new LifecycleRegistry();
    r.register({ name: 'x', stop: stop1 });
    r.register({ name: 'x', stop: stop2 });
    r.register({ name: 'nostop' });
    expect(r.names()).toEqual(['x', 'nostop']);
    await r.stopAll();
    expect(stop1).not.toHaveBeenCalled();
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  it('一个服务抛错 / 卡住不影响其余服务', async () => {
    jest.useFakeTimers();
    try {
      const warn = jest.fn();
      const ok = jest.fn();
      const r = new LifecycleRegistry();
      r.register({ name: 'ok', stop: ok });
      r.register({ name: 'hang', stop: () => new Promise<void>(() => undefined) });
      r.register({
        name: 'boom',
        stop: () => {
          throw new Error('x');
        },
      });
      const p = r.stopAll({ warn }, 1000);
      await jest.advanceTimersByTimeAsync(1500);
      await p;
      expect(ok).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createShutdown', () => {
  it('stop() 重入：并发 / 重复调用只执行一次 work', async () => {
    const work = jest.fn().mockResolvedValue(undefined);
    const s = createShutdown({ work, timeoutMs: 1000, exit: jest.fn() });
    await Promise.all([s.stop(), s.stop()]);
    await s.stop();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('requestQuit：多次触发只 stop + exit 一次，且 exit 在 work 完成之后', async () => {
    const events: string[] = [];
    let release!: () => void;
    const work = jest.fn(
      () =>
        new Promise<void>((r) => {
          release = () => {
            events.push('work-done');
            r();
          };
        }),
    );
    const exit = jest.fn(() => void events.push('exit'));
    const s = createShutdown({ work, timeoutMs: 1000, exit });
    s.requestQuit();
    s.requestQuit();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    release();
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(['work-done', 'exit']);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('work 卡住时 5s 类超时兜底：到点放弃等待并 exit', async () => {
    jest.useFakeTimers();
    try {
      const onTimeout = jest.fn();
      const exit = jest.fn();
      const s = createShutdown({
        work: () => new Promise<void>(() => undefined),
        timeoutMs: 5000,
        exit,
        onTimeout,
      });
      s.requestQuit();
      await jest.advanceTimersByTimeAsync(4999);
      expect(exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('work 失败时 stop() 抛错，但 requestQuit 仍会 exit', async () => {
    const exit = jest.fn();
    const s = createShutdown({
      work: () => Promise.reject(new Error('fail')),
      timeoutMs: 1000,
      exit,
    });
    await expect(s.stop()).rejects.toThrow('fail');
    s.requestQuit();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
