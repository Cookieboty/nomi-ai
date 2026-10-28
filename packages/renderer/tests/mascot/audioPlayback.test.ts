import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mascot/softSpeech', () => ({ stopSoftSpeech: vi.fn() }));
// 朗读经契约 tts.speak / tts.stop（D1）。这里的用例按微任务节拍断言，用直接的替身而不是完整线协议
const host = vi.hoisted(() => ({
  speak: null as null | ((req: never) => Promise<unknown>),
  stop: null as null | (() => Promise<boolean>),
}));
vi.mock('../../src/services/api', () => ({
  api: {
    tts: {
      speak: (req: never) => host.speak!(req),
      stop: () => host.stop?.() ?? Promise.resolve(true),
    },
  },
  hasTransport: () => host.speak !== null,
}));

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
  host.speak = null;
  host.stop = null;
  vi.unstubAllGlobals();
});

function setApi(ttsSpeak: (...a: never[]) => Promise<unknown>) {
  host.speak = ttsSpeak;
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

describe('speakRealtime 分句流式播放 / 打断', () => {
  it('去掉 Markdown 后按句请求；边播边预取下一句，最后一句播完才 onEnd', async () => {
    const texts: string[] = [];
    setApi(async (req: never) => {
      texts.push((req as { text: string }).text);
      return OK;
    });
    const onEnd = vi.fn();
    const long =
      '第一句话在这里。' + '```js\nconst x = 1\n```\n' + '**第二句**话也很长！' + '第三句。';
    const started = await (async () => {
      const p = speakRealtime(long, { onEnd });
      await flush();
      audios[0]!.playDeferred.resolve();
      return p;
    })();
    expect(started).toBe(true);
    expect(texts.join('')).not.toMatch(/const|\*|`/);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    // 逐句播放到结束
    for (let i = 0; i < 10 && !onEnd.mock.calls.length; i++) {
      const a = audios[audios.length - 1]!;
      a.playDeferred.resolve();
      await flush();
      a.onended?.();
      await flush();
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(audios.length).toBe(texts.length);
  });

  it('长文本切成多段；stopSpeaking 后不再播放后续段，并通知主进程取消', async () => {
    const ttsStop = vi.fn(async () => true);
    let calls = 0;
    host.speak = async () => {
      calls++;
      return OK;
    };
    host.stop = ttsStop;
    const onEnd = vi.fn();
    const text = Array.from({ length: 6 }, (_, i) =>
      `这是第${i}句，内容稍微长一点点以便切分开来。`.repeat(3),
    ).join('');
    const p = speakRealtime(text, { onEnd });
    await flush();
    audios[0]!.playDeferred.resolve();
    await expect(p).resolves.toBe(true);
    expect(calls).toBe(2); // 当前句 + 预取下一句
    stopSpeaking();
    expect(ttsStop).toHaveBeenCalled();
    audios[0]!.onended?.();
    await flush();
    expect(audios.length).toBe(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('中途某句失败：停下并 onEnd（文字仍在）', async () => {
    let n = 0;
    setApi(async () => (n++ === 0 ? OK : { success: false, via: 'none' }));
    const onEnd = vi.fn();
    const p = speakRealtime(
      '第一句。' +
        '第二句很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长。',
      { onEnd },
    );
    await flush();
    audios[0]!.playDeferred.resolve();
    await expect(p).resolves.toBe(true);
    audios[0]!.onended?.();
    await flush();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(audios.length).toBe(1);
  });

  it('只剩代码块（没有可读文字）：不请求，直接 onEnd', async () => {
    const ttsSpeak = vi.fn(async () => OK);
    setApi(ttsSpeak);
    const onEnd = vi.fn();
    await expect(speakRealtime('```\ncode\n```', { onEnd })).resolves.toBe(false);
    expect(ttsSpeak).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
  });
});
