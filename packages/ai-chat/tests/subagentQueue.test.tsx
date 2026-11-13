import { describe, expect, it, vi } from 'vitest';

import { createSubagentQueue } from '../src/contexts/subagentQueue';

describe('createSubagentQueue', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('while an earlier message is still undelivered, a later one queues behind it instead of steering ahead', async () => {
    const steered: string[] = [];
    const sent: string[] = [];
    const first = deferred();
    const q = createSubagentQueue({
      send: async (_id, text) => {
        sent.push(text);
      },
      steer: async (_id, text) => {
        steered.push(text);
        if (text === 'one') {
          await first.promise;
          return false;
        }
        return true;
      },
      accepted: async () => false,
    });
    q.sync([{ id: 'A', status: 'running' }]);
    q.setDraft('A', 'one');
    const p1 = q.submit('A');
    q.setDraft('A', 'two');
    await q.submit('A');
    expect(steered).toEqual(['one']);
    first.resolve();
    await p1;
    expect(q.view('A').queued).toEqual(['one', 'two']);
    q.sync([{ id: 'A', status: 'idle' }]);
    await flush();
    await flush();
    expect(sent).toEqual(['one', 'two']);
  });

  it('a rejected send that never reached the tab stays at the head and is retried later', async () => {
    const turns: ReturnType<typeof deferred>[] = [];
    const send = vi.fn(() => {
      const d = deferred();
      turns.push(d);
      return d.promise;
    });
    const q = createSubagentQueue({
      send,
      steer: async () => false,
      accepted: async () => false,
    });
    q.sync([{ id: 'a', status: 'running' }]);
    for (const text of ['一', '二']) {
      q.setDraft('a', text);
      await q.submit('a');
    }
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenCalledTimes(1);
    turns[0]!.reject(new Error('busy'));
    await flush();
    // 留在队首、暂停，不自动重试，也不跳过它发第二条
    expect(q.view('a').queued).toEqual(['一', '二']);
    expect(q.view('a').error).toBe('busy');
    expect(send).toHaveBeenCalledTimes(1);

    // 这个标签跑完一轮：按顺序接着发
    q.sync([{ id: 'a', status: 'running' }]);
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenLastCalledWith('a', '一');
    turns[1]!.resolve();
    await flush();
    expect(send).toHaveBeenLastCalledWith('a', '二');
    turns[2]!.resolve();
    await flush();
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['一', '一', '二']);
    expect(q.view('a').queued).toEqual([]);
  });

  it('a send that the tab accepted and then failed is not resent', async () => {
    const d = deferred();
    const send = vi.fn(() => d.promise);
    const q = createSubagentQueue({ send, steer: async () => false, accepted: async () => true });
    q.sync([{ id: 'a', status: 'idle' }]);
    q.setDraft('a', '一');
    await q.submit('a');
    d.reject(new Error('turn failed'));
    await flush();
    expect(q.view('a').queued).toEqual([]);
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('closing a tab drops its queue; results that arrive later do not touch a new tab with that id', async () => {
    let resolveSteer!: (ok: boolean) => void;
    const send = vi.fn(async () => undefined);
    const q = createSubagentQueue({
      send,
      steer: () => new Promise<boolean>((r) => (resolveSteer = r)),
      accepted: async () => false,
    });
    q.sync([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'idle' },
    ]);
    q.setDraft('a', '给 A');
    const pending = q.submit('a');
    q.sync([{ id: 'b', status: 'idle' }]);
    q.sync([
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'idle' },
    ]);
    resolveSteer(false);
    await pending;
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(q.view('a').queued).toEqual([]);
    expect(q.view('b').queued).toEqual([]);
  });
});
