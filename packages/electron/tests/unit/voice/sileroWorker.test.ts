jest.unmock('fs');
jest.unmock('path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSileroEngine,
  type SileroEngine,
  type WorkerReply,
  type WorkerRequest,
} from '../../../src/voice/sileroCore';
import {
  SileroClient,
  SileroStream,
  setSileroClient,
  warmup,
  type WorkerLike,
} from '../../../src/voice/sileroNode';

// ───────────── 假 onnxruntime-web：output = 输入 576 样本之和，stateN = state + 1 ─────────────
class Tensor {
  constructor(
    readonly type: string,
    readonly data: Float32Array | BigInt64Array,
    readonly dims: number[],
  ) {}
}
function fakeOrt(opts: { delay?: number; runs?: Array<{ x: Float32Array; state: Float32Array }> }) {
  const create = jest.fn(async () => ({
    run: async (feeds: Record<string, Tensor>) => {
      const x = feeds.input!.data as Float32Array;
      const state = feeds.state!.data as Float32Array;
      opts.runs?.push({ x: x.slice(), state: state.slice() });
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      let sum = 0;
      for (const v of x) sum += v;
      return {
        output: { data: Float32Array.of(sum) },
        stateN: { data: state.map((v) => v + 1) },
      };
    },
  }));
  return {
    create,
    mod: { env: { wasm: {} }, Tensor, InferenceSession: { create } } as unknown,
  };
}

const model = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-silero-'));
  const f = path.join(dir, 'silero_vad.onnx');
  fs.writeFileSync(f, Buffer.from([1, 2, 3]));
  return f;
})();

const frame = (v: number) => new Float32Array(512).fill(v);

// 崩溃 / 回退路径会打 warn 日志，测试里静音
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('sileroCore 推理内核', () => {
  it('每个流独立的 RNN 状态与 64 样本上下文', async () => {
    const runs: Array<{ x: Float32Array; state: Float32Array }> = [];
    const o = fakeOrt({ runs });
    const e = createSileroEngine(async () => o.mod);
    expect(await e.run('a', model, frame(1))).toBe(512);
    // 第二帧：前 64 个是上一帧的尾巴
    expect(await e.run('a', model, frame(2))).toBe(64 * 1 + 512 * 2);
    // 另一个流从零开始
    expect(await e.run('b', model, frame(1))).toBe(512);
    expect(runs[1]!.state[0]).toBe(1);
    expect(runs[2]!.state[0]).toBe(0);
    expect(o.create).toHaveBeenCalledTimes(1); // 会话复用
    expect(e.size()).toBe(2);
    await e.close('a');
    expect(e.size()).toBe(1);
    expect(await e.run('a', model, frame(1))).toBe(512); // 关闭后重开 = 新状态
  });

  it('串行执行：并发提交按顺序完成，close 排在已提交推理之后', async () => {
    const o = fakeOrt({ delay: 5 });
    const e = createSileroEngine(async () => o.mod);
    const done: number[] = [];
    const ps = [1, 2, 3].map((v) => e.run('a', model, frame(v)).then(() => done.push(v)));
    const closed = e.close('a');
    await Promise.all([...ps, closed]);
    expect(done).toEqual([1, 2, 3]);
    expect(e.size()).toBe(0);
  });

  it('加载失败：本次 reject，之后可重试', async () => {
    const o = fakeOrt({});
    let fail = true;
    const e = createSileroEngine(async () => {
      if (fail) throw new Error('no wasm');
      return o.mod;
    });
    await expect(e.run('a', model, frame(1))).rejects.toThrow('no wasm');
    fail = false;
    expect(await e.run('a', model, frame(1))).toBe(512);
  });
});

// ───────────── 假 worker：内部用真实内核 + 假 ort，异步回复 ─────────────
class FakeWorker extends EventEmitter implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  hang = false;
  constructor(private readonly engine: SileroEngine) {
    super();
  }
  postMessage(m: WorkerRequest, transfer?: ArrayBuffer[]): void {
    this.sent.push(m);
    if (m.t === 'run') {
      // 转移语义：确认调用方把帧的缓冲交了出来
      expect(transfer?.[0]).toBe(m.frame.buffer);
      if (this.hang) return;
      this.engine.run(m.stream, m.model, m.frame).then(
        (prob) => this.reply({ t: 'ok', id: m.id, prob }),
        (e: Error) => this.reply({ t: 'err', id: m.id, message: e.message }),
      );
    } else void this.engine.close(m.stream);
  }
  private reply(m: WorkerReply) {
    if (!this.terminated) setImmediate(() => this.emit('message', m));
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
  unref() {}
  crash(msg = 'boom') {
    this.emit('error', new Error(msg));
    this.emit('exit', 1);
  }
}

function setup(
  opts: { delay?: number; maxCrashes?: number; idleMs?: number; timeoutMs?: number } = {},
) {
  const workers: FakeWorker[] = [];
  const engines: SileroEngine[] = [];
  const spawn = jest.fn(() => {
    const e = createSileroEngine(async () => fakeOrt({ delay: opts.delay }).mod);
    engines.push(e);
    const w = new FakeWorker(e);
    workers.push(w);
    return w;
  });
  const local = jest.fn(() => createSileroEngine(async () => fakeOrt({}).mod));
  const c = new SileroClient({
    spawn,
    local,
    maxCrashes: opts.maxCrashes,
    idleMs: opts.idleMs,
    timeoutMs: opts.timeoutMs,
  });
  return { c, spawn, local, workers, engines };
}

describe('SileroClient（主进程 ↔ worker）', () => {
  it('结果按提交顺序返回，流之间互不影响', async () => {
    const { c, spawn } = setup({ delay: 2 });
    const order: string[] = [];
    const a1 = c.run('a', model, frame(1)).then((p) => (order.push('a1'), p));
    const b1 = c.run('b', model, frame(3)).then((p) => (order.push('b1'), p));
    const a2 = c.run('a', model, frame(2)).then((p) => (order.push('a2'), p));
    expect(await Promise.all([a1, b1, a2])).toEqual([512, 512 * 3, 64 + 512 * 2]);
    expect(order).toEqual(['a1', 'b1', 'a2']);
    expect(spawn).toHaveBeenCalledTimes(1);
    c.shutdown();
  });

  it('close 释放 worker 里的流状态', async () => {
    const { c, workers, engines } = setup();
    await c.run('a', model, frame(1));
    await c.run('b', model, frame(1));
    c.close('a');
    await new Promise((r) => setImmediate(r));
    expect(workers[0]!.sent.at(-1)).toEqual({ t: 'close', stream: 'a' });
    expect(engines[0]!.size()).toBe(1);
    c.shutdown();
  });

  it('worker 崩溃：进行中的请求失败，下次请求懒重建（状态从零开始）', async () => {
    const { c, spawn, workers } = setup({ delay: 20 });
    await c.run('a', model, frame(1));
    const inflight = c.run('a', model, frame(1));
    workers[0]!.crash();
    await expect(inflight).rejects.toThrow('boom');
    expect(workers[0]!.terminated).toBe(true);
    expect(await c.run('a', model, frame(1))).toBe(512);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(c.inProcess).toBe(false);
    c.shutdown();
  });

  it('连续崩溃达到上限后退回主进程内推理', async () => {
    const { c, spawn, local, workers } = setup({ maxCrashes: 2 });
    for (let i = 0; i < 2; i++) {
      const p = c.run('a', model, frame(1));
      workers[i]!.crash();
      await expect(p).rejects.toThrow();
    }
    expect(c.inProcess).toBe(true);
    expect(await c.run('a', model, frame(1))).toBe(512);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('一次成功即清零崩溃计数', async () => {
    const { c, workers } = setup({ maxCrashes: 2 });
    let p = c.run('a', model, frame(1));
    workers[0]!.crash();
    await expect(p).rejects.toThrow();
    await c.run('a', model, frame(1));
    p = c.run('a', model, frame(1));
    workers[1]!.crash();
    await expect(p).rejects.toThrow();
    expect(c.inProcess).toBe(false);
    c.shutdown();
  });

  it('worker 无法启动（spawn 返回 null / 抛错）时直接主进程内推理', async () => {
    const local = jest.fn(() => createSileroEngine(async () => fakeOrt({}).mod));
    const c1 = new SileroClient({ spawn: () => null, local });
    expect(await c1.run('a', model, frame(1))).toBe(512);
    expect(c1.inProcess).toBe(true);
    const c2 = new SileroClient({
      spawn: () => {
        throw new Error('ENOENT');
      },
      local,
    });
    expect(await c2.run('a', model, frame(1))).toBe(512);
    expect(c2.inProcess).toBe(true);
  });

  it('worker 卡死：超时后失败并重建', async () => {
    const { c, spawn, workers } = setup({ timeoutMs: 30 });
    await c.run('a', model, frame(1));
    workers[0]!.hang = true;
    await expect(c.run('a', model, frame(1))).rejects.toThrow('超时');
    expect(workers[0]!.terminated).toBe(true);
    expect(await c.run('a', model, frame(1))).toBe(512);
    expect(spawn).toHaveBeenCalledTimes(2);
    c.shutdown();
  });

  it('没有活跃流后空闲结束 worker，之后按需重建', async () => {
    const { c, spawn, workers } = setup({ idleMs: 20 });
    await c.run('a', model, frame(1));
    c.close('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(workers[0]!.terminated).toBe(true);
    await c.run('a', model, frame(1));
    expect(spawn).toHaveBeenCalledTimes(2);
    c.shutdown();
  });

  it('shutdown：进行中的请求失败、worker 结束', async () => {
    const { c, workers } = setup({ delay: 20 });
    const p = c.run('a', model, frame(1));
    c.shutdown();
    await expect(p).rejects.toThrow();
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('SileroStream / warmup 走共享客户端', () => {
  afterEach(() => setSileroClient(null));

  it('warmup 成功后释放临时流；dispose 后的 prob 返回 0', async () => {
    const { c, workers, engines } = setup();
    setSileroClient(c);
    expect(await warmup(model)).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(workers[0]!.sent.map((m) => m.t)).toEqual(['run', 'close']);
    expect(engines[0]!.size()).toBe(0);
    const s = new SileroStream(model);
    expect(await s.prob(frame(1))).toBe(512);
    s.dispose();
    expect(await s.prob(frame(1))).toBe(0);
  });

  it('warmup 失败返回错误信息', async () => {
    const c = new SileroClient({
      spawn: null,
      local: () =>
        createSileroEngine(async () => {
          throw new Error('wasm missing');
        }),
    });
    setSileroClient(c);
    expect(await warmup(model)).toBe('wasm missing');
  });
});
