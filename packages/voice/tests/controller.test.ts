import { describe, expect, it, vi } from 'vitest';

import type { VoiceApi } from '../src/bridge';
import { VoiceController } from '../src/controller';
import { MicCancelled, MicError } from '../src/mic';
import type { VadEngine } from '../src/vad';

function fakes(text = '你好') {
  let handlers: { onFrame(f: Float32Array): void; onLevel?(l: number): void } | null = null;
  let t = 0;
  const mic = {
    running: false,
    start: vi.fn(async (h: typeof handlers) => {
      handlers = h;
    }),
    stop: vi.fn(async () => {
      handlers = null;
    }),
  };
  const activity: string[] = [];
  const api = {
    activity: vi.fn(async (a: string) => {
      activity.push(a);
    }),
    transcribe: vi.fn(async () => ({ ok: true as const, text })),
    vadOpen: vi.fn(async () => ({ kind: 'energy' })),
  } as unknown as VoiceApi;
  const push = (n: number, v = 0.3) => {
    for (let i = 0; i < n; i++) {
      t += 32;
      handlers?.onFrame(new Float32Array(512).fill(v));
    }
  };
  return { mic, api, activity, push, now: () => t, advance: (ms: number) => (t += ms) };
}

describe('VoiceController push-to-talk', () => {
  it('records, transcribes and emits the text; reports activity', async () => {
    const f = fakes('打开笔记');
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    await c.pttStart();
    expect(c.state.phase).toBe('recording');
    f.push(30);
    const text = await c.pttStop();
    expect(text).toBe('打开笔记');
    expect(got).toEqual(['打开笔记']);
    expect(c.state.phase).toBe('idle');
    expect(f.activity).toEqual(['listening', 'transcribing', 'idle']);
  });

  it('too short press shows a friendly hint and does not call ASR', async () => {
    const f = fakes();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
    await c.pttStart();
    f.push(2);
    expect(await c.pttStop()).toBe('');
    expect(c.state.error?.code).toBe('too_short');
    expect(f.api.transcribe).not.toHaveBeenCalled();
  });

  it('cancel discards audio', async () => {
    const f = fakes();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
    await c.pttStart();
    f.push(30);
    expect(await c.pttStop(true)).toBe('');
    expect(f.api.transcribe).not.toHaveBeenCalled();
  });

  it('mic permission denied surfaces a Chinese error', async () => {
    const f = fakes();
    f.mic.start.mockRejectedValueOnce(new MicError('mic_denied', '麦克风权限被拒绝'));
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
    await c.pttStart();
    expect(c.state).toMatchObject({ phase: 'idle', error: { code: 'mic_denied' } });
  });
});

const scriptedVad = (probs: number[]): VadEngine => {
  let i = 0;
  return { kind: 'silero', prob: async () => probs[i++] ?? 0, reset() {}, dispose() {} };
};

describe('VoiceController continuous', () => {
  it('hands-free: speech → hearing → transcribe → emit, keeps listening', async () => {
    const f = fakes('现在几点');
    const probs = [...Array(3).fill(0), ...Array(15).fill(0.9), ...Array(30).fill(0)];
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => scriptedVad(probs),
    });
    const got: string[] = [];
    c.onTranscript((t, via) => got.push(`${via}:${t}`));
    await c.startContinuous('handsfree');
    expect(c.state.phase).toBe('listening');
    f.push(48);
    await vi.waitFor(() => expect(got).toEqual(['handsfree:现在几点']));
    expect(f.activity).toContain('hearing');
    expect(c.state.phase).toBe('listening');
    await c.stopContinuous();
    expect(c.state.mode).toBe('off');
  });

  it('wake word: ignores non-matching speech, then wakes and takes next utterance', async () => {
    const f = fakes();
    const utter = [...Array(12).fill(0.9), ...Array(25).fill(0)];
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => scriptedVad([...utter, ...utter, ...utter]),
    });
    const transcribe = f.api.transcribe as ReturnType<typeof vi.fn>;
    transcribe
      .mockResolvedValueOnce({ ok: true, text: '今天好累' })
      .mockResolvedValueOnce({ ok: true, text: '你好诺米' })
      .mockResolvedValueOnce({ ok: true, text: '讲个笑话' });
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    await c.startContinuous('wake', { wakePhrase: '你好，诺米', wakeWindowSec: 10 });
    expect(c.state.phase).toBe('wake-armed');
    f.push(37);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(c.state.phase).toBe('wake-armed');
    f.push(37);
    await vi.waitFor(() => expect(c.state.phase).toBe('awake'));
    expect(transcribe.mock.calls[1]![2]).toBe('wake');
    f.push(37);
    await vi.waitFor(() => expect(got).toEqual(['讲个笑话']));
    expect(transcribe.mock.calls[2]![2]).toBe('command');
    expect(c.state.phase).toBe('wake-armed');
  });

  it('picks up a changed wake phrase without restarting the mic', async () => {
    const f = fakes();
    const utter = [...Array(12).fill(0.9), ...Array(25).fill(0)];
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => scriptedVad([...utter, ...utter]),
    });
    const transcribe = f.api.transcribe as ReturnType<typeof vi.fn>;
    transcribe.mockResolvedValue({ ok: true, text: '诺米诺米' });
    await c.startContinuous('wake', { wakePhrase: '你好，诺米', wakeWindowSec: 10 });
    f.push(37);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(c.state.phase).toBe('wake-armed');
    c.updateSettings({ wakePhrase: '诺米诺米' });
    f.push(37);
    await vi.waitFor(() => expect(c.state.phase).toBe('awake'));
  });

  it('stopping while a VAD call is in flight does not throw', async () => {
    const f = fakes();
    let release: (v: number) => void = () => {};
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => ({
        kind: 'silero' as const,
        prob: () => new Promise<number>((r) => (release = r)),
        reset() {},
        dispose() {},
      }),
    });
    await c.startContinuous('handsfree');
    f.push(1);
    await c.stopContinuous();
    release(0.9);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.state.error).toBeNull();
    expect(c.state.phase).toBe('idle');
  });

  it('代次：停止后立即重新开始，旧会话飞行中的识别结果被丢弃，不串到新会话', async () => {
    const f = fakes();
    const utter = [...Array(12).fill(0.9), ...Array(25).fill(0)];
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => scriptedVad([...utter, ...utter]),
    });
    let resolveOld: (v: { ok: true; text: string }) => void = () => {};
    const transcribe = f.api.transcribe as ReturnType<typeof vi.fn>;
    transcribe.mockImplementationOnce(
      () => new Promise((r) => (resolveOld = r as typeof resolveOld)),
    );
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    await c.startContinuous('handsfree');
    f.push(37);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1)); // 旧会话的识别还在飞
    await c.stopContinuous();
    await c.startContinuous('handsfree'); // 同一 mode 的新会话
    expect(c.state.phase).toBe('listening');
    resolveOld({ ok: true, text: '旧会话的话' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]); // 之前只比较 mode，这里会被误交付
    expect(c.state.phase).toBe('listening');
    await c.stopContinuous();
  });

  it('代次：停止后旧会话遗留的排队帧不会喂给新会话的 VAD', async () => {
    const f = fakes();
    const probs: number[] = [];
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: async () => ({
        kind: 'silero' as const,
        prob: async () => {
          probs.push(1);
          return 0;
        },
        reset() {},
        dispose() {},
      }),
    });
    let onFrame: (f: Float32Array) => void = () => {};
    f.mic.start.mockImplementation(async (h: { onFrame(f: Float32Array): void }) => {
      onFrame = h.onFrame;
    });
    await c.startContinuous('handsfree');
    const stale = onFrame; // 旧会话的回调
    await c.stopContinuous();
    await c.startContinuous('handsfree');
    stale(new Float32Array(512)); // 旧回调晚到
    await new Promise((r) => setTimeout(r, 10));
    expect(probs).toHaveLength(0);
    await c.stopContinuous();
  });
});

describe('VoiceController 启动期间取消（#20）', () => {
  const deferredStart = () => {
    let handlers: { onFrame(f: Float32Array): void } | null = null;
    const gates: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    const mic = {
      running: false,
      start: vi.fn(
        (h: typeof handlers) =>
          new Promise<void>((resolve, reject) => {
            handlers = h;
            gates.push({ resolve, reject });
          }),
      ),
      stop: vi.fn(async () => undefined),
    };
    return { mic, gates, frame: (v = 0.3) => handlers?.onFrame(new Float32Array(512).fill(v)) };
  };

  it('pttStart 等待麦克风时 pttStop(取消)：晚到的 start 不再进入 recording，后续帧被丢弃', async () => {
    const f = fakes();
    const d = deferredStart();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => d.mic, now: f.now });
    const start = c.pttStart();
    expect(c.state.phase).toBe('starting');
    await c.pttStop(true);
    expect(c.state).toMatchObject({ mode: 'off', phase: 'idle' });
    d.gates[0]!.resolve(); // 设备晚到
    await start;
    expect(c.state).toMatchObject({ mode: 'off', phase: 'idle', error: null });
    d.frame();
    expect(f.api.transcribe).not.toHaveBeenCalled();
    // 状态是 off，下一次按住能正常重新开始
    const again = c.pttStart();
    d.gates[1]!.resolve();
    await again;
    expect(c.state.phase).toBe('recording');
  });

  it('pttStart 等待期间收到取消错误（MicCancelled）：不当作失败、不污染新会话状态', async () => {
    const f = fakes();
    const d = deferredStart();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => d.mic, now: f.now });
    const a = c.pttStart();
    await c.pttStop(true);
    const b = c.pttStart(); // B 重启
    d.gates[1]!.resolve();
    await b;
    expect(c.state.phase).toBe('recording');
    d.gates[0]!.reject(new MicCancelled()); // A 晚到
    await a;
    expect(c.state).toMatchObject({ mode: 'ptt', phase: 'recording', error: null });
  });

  it('A 取消后 B 重启，A 的晚到成功不会把 B 的状态改掉、A 的帧不进 B 的 chunks', async () => {
    const f = fakes();
    const d = deferredStart();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => d.mic, now: f.now });
    const a = c.pttStart();
    await c.pttStop(true);
    const b = c.pttStart();
    d.gates[0]!.resolve();
    await a;
    expect(c.state.phase).toBe('starting'); // 仍是 B 的 starting，没被 A 切成 recording
    d.gates[1]!.resolve();
    await b;
    expect(c.state.phase).toBe('recording');
  });

  it('免按键：createVad 等待中 stopContinuous，晚到的 VAD 被释放，不启动麦克风', async () => {
    const f = fakes();
    let finish: (v: VadEngine) => void = () => {};
    const dispose = vi.fn();
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => f.mic,
      now: f.now,
      createVad: () => new Promise<VadEngine>((r) => (finish = r)),
    });
    const start = c.startContinuous('handsfree');
    await vi.waitFor(() => expect(c.state.phase).toBe('starting'));
    await c.stopContinuous();
    expect(c.state.mode).toBe('off');
    finish({ kind: 'silero', prob: async () => 0, reset() {}, dispose });
    await start;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.mic.start).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ mode: 'off', phase: 'idle', error: null });
  });

  it('免按键：mic.start 等待中 stopContinuous，晚到的成功不会把状态切回 listening', async () => {
    const f = fakes();
    const d = deferredStart();
    const c = new VoiceController({
      api: f.api,
      source: 'mascot',
      mic: () => d.mic,
      now: f.now,
      createVad: async () => scriptedVad([]),
    });
    const start = c.startContinuous('handsfree');
    await vi.waitFor(() => expect(d.mic.start).toHaveBeenCalled());
    await c.stopContinuous();
    d.gates[0]!.resolve();
    await start;
    expect(c.state).toMatchObject({ mode: 'off', phase: 'idle', error: null });
    d.frame();
    expect(f.api.transcribe).not.toHaveBeenCalled();
  });
});
