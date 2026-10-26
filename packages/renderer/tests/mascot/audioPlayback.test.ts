import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mascot/softSpeech', () => ({ stopSoftSpeech: vi.fn() }));

import { speakRealtime, stopSpeaking } from '../../src/mascot/tts/audioPlayback';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let audios: FakeAudio[] = [];
class FakeAudio {
  src = '';
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  playDeferred = deferred<void>();
  play = vi.fn(() => this.playDeferred.promise);
  constructor() {
    audios.push(this);
  }
}

const OK = { success: true, audioBase64: btoa('abc'), mimeType: 'audio/mpeg' };
let urlSeq = 0;
let revoke: ReturnType<typeof vi.fn>;
let ctxState: 'running' | 'suspended';
let resumeDeferred: Deferred<void> | null;
let mediaSources: number;

beforeEach(() => {
  audios = [];
  urlSeq = 0;
  mediaSources = 0;
  resumeDeferred = null;
  ctxState = 'running';
  revoke = vi.fn();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', { createObjectURL: () => `blob:u${++urlSeq}`, revokeObjectURL: revoke });
  class FakeCtx {
    destination = {};
    get state() {
      return ctxState;
    }
    resume() {
      resumeDeferred = deferred<void>();
      return resumeDeferred.promise.then(() => {
        ctxState = 'running';
      });
    }
    createMediaElementSource() {
      mediaSources++;
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        frequencyBinCount: 4,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteTimeDomainData: vi.fn(),
      };
    }
  }
  vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { AudioContext: FakeCtx }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  stopSpeaking();
  vi.unstubAllGlobals();
});

function setApi(ttsSpeak: (...a: never[]) => Promise<unknown>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { ttsSpeak };
}

describe('audioPlayback 旧请求不能清理新句（#47）', () => {
  it('A.play 晚拒绝时 B 已在播放：B 的 pause / revoke 都不被调用', async () => {
    setApi(async () => OK);
    const a = speakRealtime('第一句');
    await flush();
    const audioA = audios[0]!;
    expect(audioA.play).toHaveBeenCalled();

    const b = speakRealtime('第二句');
    await flush();
    const audioB = audios[1]!;
    expect(audioB.play).toHaveBeenCalled();
    // 切句时 A 已被暂停并 revoke 自己的 url
    expect(audioA.pause).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:u1');
    audioB.pause.mockClear();
    revoke.mockClear();

    audioA.playDeferred.reject(new DOMException('aborted', 'AbortError')); // 晚到拒绝
    await expect(a).resolves.toBe(false);
    expect(audioB.pause).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalledWith('blob:u2');
    expect(audioB.src).toBe('blob:u2');

    // B 仍能正常结束
    audioB.playDeferred.resolve();
    await b;
  });

  it('A 的合成晚拒绝：不会打断已在播放的 B，也不回调 A 的 onEnd', async () => {
    const synthA = deferred<unknown>();
    let n = 0;
    setApi(() => (n++ === 0 ? synthA.promise : Promise.resolve(OK)));
    const onEndA = vi.fn();
    const a = speakRealtime('A', { onEnd: onEndA });
    const b = speakRealtime('B');
    await flush();
    const audioB = audios[0]!;
    expect(audioB.play).toHaveBeenCalled();

    synthA.reject(new Error('net'));
    await expect(a).resolves.toBe(false);
    expect(audioB.pause).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(onEndA).not.toHaveBeenCalled();
    audioB.playDeferred.resolve();
    await b;
  });

  it('AudioContext.resume 等待期间被停止：不再挂接包络，也不 play', async () => {
    ctxState = 'suspended';
    setApi(async () => OK);
    const p = speakRealtime('hi');
    await flush();
    expect(resumeDeferred).not.toBeNull();
    stopSpeaking();
    resumeDeferred!.resolve();
    await p;
    expect(mediaSources).toBe(0);
    expect(audios[0]!.play).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:u1');
  });

  it('取消旧句后晚到的合成结果被丢弃（不创建 Audio）', async () => {
    const synth = deferred<unknown>();
    setApi(() => synth.promise);
    const p = speakRealtime('x');
    stopSpeaking();
    synth.resolve(OK);
    await expect(p).resolves.toBe(true);
    expect(audios).toHaveLength(0);
  });
});
