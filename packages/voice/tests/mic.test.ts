import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MicCancelled, MicCapture } from '../src/mic';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeStream = () => {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
};

let contexts: { close: ReturnType<typeof vi.fn> }[] = [];
let workletGate: ReturnType<typeof deferred<void>> | null = null;

beforeEach(() => {
  contexts = [];
  workletGate = null;
  class FakeCtx {
    sampleRate = 16000;
    destination = {};
    close = vi.fn(async () => undefined);
    audioWorklet = { addModule: () => (workletGate ? workletGate.promise : Promise.resolve()) };
    constructor() {
      contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
      return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    }
  }
  class FakeWorkletNode {
    port: { onmessage: unknown } = { onmessage: null };
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});
afterEach(() => vi.unstubAllGlobals());

function mockGum(...gates: ReturnType<typeof deferred<MediaStream>>[]) {
  let i = 0;
  const getUserMedia = vi.fn(() => gates[i++]!.promise);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

describe('MicCapture 启动期间取消（#20）', () => {
  it('getUserMedia 未返回时 stop()：晚到的 stream 立即释放，不创建 context，不产生帧', async () => {
    const gate = deferred<MediaStream>();
    mockGum(gate);
    const mic = new MicCapture();
    const onFrame = vi.fn();
    const p = mic.start({ onFrame });
    const settled = p.catch((e) => e);
    await mic.stop();
    const { stream, track } = fakeStream();
    gate.resolve(stream);
    expect(await settled).toBeInstanceOf(MicCancelled);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(0);
    expect(mic.running).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('A 取消后 B 重新开始：A 晚到只释放自己的 stream，B 不受影响', async () => {
    const gateA = deferred<MediaStream>();
    const gateB = deferred<MediaStream>();
    mockGum(gateA, gateB);
    const mic = new MicCapture();
    const a = mic.start({ onFrame: vi.fn() }).catch((e) => e);
    await mic.stop();
    const b = mic.start({ onFrame: vi.fn() });
    const sB = fakeStream();
    const sA = fakeStream();
    gateB.resolve(sB.stream);
    await b;
    expect(mic.running).toBe(true);
    gateA.resolve(sA.stream); // A 晚到
    expect(await a).toBeInstanceOf(MicCancelled);
    expect(sA.track.stop).toHaveBeenCalledTimes(1);
    expect(sB.track.stop).not.toHaveBeenCalled();
    expect(mic.running).toBe(true);
    await mic.stop();
    expect(sB.track.stop).toHaveBeenCalledTimes(1);
  });

  it('addModule 等待期间 stop()：不再挂接节点，stream 与 context 都被释放', async () => {
    const gate = deferred<MediaStream>();
    mockGum(gate);
    workletGate = deferred<void>();
    const mic = new MicCapture();
    const p = mic.start({ onFrame: vi.fn() }).catch((e) => e);
    const { stream, track } = fakeStream();
    gate.resolve(stream);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    await mic.stop();
    workletGate.resolve();
    expect(await p).toBeInstanceOf(MicCancelled);
    expect(track.stop).toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalled();
    expect(mic.running).toBe(false);
  });

  it('getUserMedia 在取消后才拒绝：按取消处理，不当成「麦克风失败」', async () => {
    const gate = deferred<MediaStream>();
    mockGum(gate);
    const mic = new MicCapture();
    const p = mic.start({ onFrame: vi.fn() }).catch((e) => e);
    await mic.stop();
    gate.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    expect(await p).toBeInstanceOf(MicCancelled);
  });
});
