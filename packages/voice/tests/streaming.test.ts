/** #61：流式识别（豆包 2.0）在控制器里的生命周期：partial / final、取消、启动中取消、A 取消后 B、切会话 */
import { describe, expect, it, vi } from 'vitest';

import type { StreamEvent, VoiceApi } from '../src/bridge';
import { VoiceController } from '../src/controller';

type StartReply = { ok: true; id: string } | { ok: false; code: 'failed'; error: string };

function fakes(
  opts: { startDelay?: number; startFail?: boolean; stopText?: string; deferStart?: boolean } = {},
) {
  let handlers: { onFrame(f: Float32Array): void } | null = null;
  let t = 0;
  let seq = 0;
  let streamFn: ((e: StreamEvent) => void) | null = null;
  const mic = {
    running: false,
    start: vi.fn(async (h: typeof handlers) => {
      handlers = h;
    }),
    stop: vi.fn(async () => {
      handlers = null;
    }),
  };
  const pushed: Record<string, number> = {};
  const cancelled: string[] = [];
  /** deferStart：每次 streamStart 都挂起，由测试按任意顺序回复 */
  const starts: Array<{ resolve: (r: StartReply) => void; reject: (e: unknown) => void }> = [];
  const api = {
    activity: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ ok: true as const, text: '整段' })),
    onStream: vi.fn((fn: (e: StreamEvent) => void) => {
      streamFn = fn;
      return () => (streamFn = null);
    }),
    streamStart: vi.fn(async () => {
      if (opts.deferStart)
        return new Promise<StartReply>((resolve, reject) => starts.push({ resolve, reject }));
      if (opts.startDelay) await new Promise((r) => setTimeout(r, opts.startDelay));
      if (opts.startFail) return { ok: false as const, code: 'failed' as const, error: 'x' };
      return { ok: true as const, id: `s${++seq}` };
    }),
    streamPush: vi.fn(async (id: string, pcm: Uint8Array) => {
      pushed[id] = (pushed[id] ?? 0) + pcm.byteLength;
      return true;
    }),
    streamStop: vi.fn(async () => ({ ok: true as const, text: opts.stopText ?? '最终' })),
    streamCancel: vi.fn(async (id: string) => {
      cancelled.push(id);
      return true;
    }),
  } as unknown as VoiceApi;
  const push = (n: number) => {
    for (let i = 0; i < n; i++) {
      t += 32;
      handlers?.onFrame(new Float32Array(512).fill(0.2));
    }
  };
  const emit = (e: StreamEvent) => streamFn?.(e);
  return { mic, api, push, emit, pushed, cancelled, starts, now: () => t };
}
const make = (f: ReturnType<typeof fakes>) => {
  const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
  c.updateSettings({ streaming: true });
  return c;
};

describe('VoiceController streaming', () => {
  it('pushes PCM while recording, shows partials, submits the final once', async () => {
    const f = fakes();
    const c = make(f);
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    await c.pttStart();
    f.push(30);
    await Promise.resolve();
    expect(f.pushed.s1).toBeGreaterThan(0);
    f.emit({ id: 's1', type: 'partial', text: '你' });
    f.emit({ id: 's1', type: 'partial', text: '您好' }); // 修订
    expect(c.state.partial).toBe('您好');
    expect(got).toEqual([]); // partial 不提交
    expect(await c.pttStop()).toBe('最终');
    expect(got).toEqual(['最终']);
    expect(c.state.partial).toBe('');
    expect(f.api.transcribe).not.toHaveBeenCalled();
    expect(f.pushed.s1).toBe(30 * 512 * 2);
    // 迟到的 partial 不会改动状态
    f.emit({ id: 's1', type: 'partial', text: '迟到' });
    expect(c.state.partial).toBe('');
  });

  it('cancel discards the stream (no final, no transcribe)', async () => {
    const f = fakes();
    const c = make(f);
    await c.pttStart();
    f.push(20);
    expect(await c.pttStop(true)).toBe('');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.cancelled).toEqual(['s1']);
    expect(f.api.streamStop).not.toHaveBeenCalled();
  });

  it('cancel while the stream is still starting closes it when it arrives', async () => {
    const f = fakes({ startDelay: 30 });
    const c = make(f);
    await c.pttStart();
    f.push(20);
    await c.pttStop(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(f.cancelled).toEqual(['s1']);
    expect(f.pushed.s1).toBeUndefined(); // 旧音频不会发出去
  });

  it('A cancelled then B started: A audio / partials never reach B', async () => {
    const f = fakes({ startDelay: 20 });
    const c = make(f);
    await c.pttStart(); // A
    f.push(10);
    await c.pttStop(true);
    await c.pttStart(); // B
    f.push(20);
    await new Promise((r) => setTimeout(r, 50));
    f.emit({ id: 's1', type: 'partial', text: 'A 的文本' });
    expect(c.state.partial).toBe('');
    f.emit({ id: 's2', type: 'partial', text: 'B' });
    expect(c.state.partial).toBe('B');
    expect(f.pushed.s1).toBeUndefined();
    expect(f.pushed.s2).toBe(20 * 512 * 2);
    expect(f.cancelled).toContain('s1');
    expect(await c.pttStop()).toBe('最终');
    expect(f.api.streamStop).toHaveBeenCalledWith('s2');
  });

  describe('A 松开后还在等启动回复时开始 B：A 只释放自己的流（#70）', () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    /** A 录音并正常松开（等 A 的启动回复），随后开始 B */
    const aStoppingThenB = async () => {
      const f = fakes({ deferStart: true });
      const c = make(f);
      const got: string[] = [];
      c.onTranscript((t) => got.push(t));
      await c.pttStart(); // A
      f.push(30);
      const stopA = c.pttStop();
      await tick();
      expect(c.state.phase).toBe('transcribing');
      await c.pttStart(); // B
      expect(f.starts).toHaveLength(2);
      return { f, c, got, stopA };
    };
    /** B 继续录音、出 partial、松开：都要落在 B 的流上 */
    const expectBIntact = async (f: ReturnType<typeof fakes>, c: VoiceController) => {
      f.push(20);
      await tick();
      expect(f.pushed.B).toBe(20 * 512 * 2);
      f.emit({ id: 'B', type: 'partial', text: 'B 的话' });
      expect(c.state.partial).toBe('B 的话');
      expect(await c.pttStop()).toBe('最终');
      expect(f.api.streamStop).toHaveBeenCalledWith('B');
      expect(f.cancelled).not.toContain('B');
    };

    it('B 先拿到 ID、A 的回复晚到：只取消 A，A 走整段且照常交付，B 的流不受影响', async () => {
      const { f, c, got, stopA } = await aStoppingThenB();
      f.starts[1]!.resolve({ ok: true, id: 'B' });
      await tick();
      f.starts[0]!.resolve({ ok: true, id: 'A' });
      expect(await stopA).toBe('整段');
      expect(f.cancelled).toContain('A');
      expect(f.pushed.A).toBeUndefined(); // A 的音频没进任何流
      await expectBIntact(f, c);
      expect(f.api.streamStop).not.toHaveBeenCalledWith('A');
      expect(f.api.transcribe).toHaveBeenCalledTimes(1); // 只有 A 走整段，B 不额外整段识别
      expect(got).toEqual(['整段', '最终']);
    });

    it('回复顺序交换（A 先回、B 后回）：同样只取消 A', async () => {
      const { f, c, stopA } = await aStoppingThenB();
      f.starts[0]!.resolve({ ok: true, id: 'A' });
      expect(await stopA).toBe('整段');
      f.starts[1]!.resolve({ ok: true, id: 'B' });
      await tick();
      await expectBIntact(f, c);
      expect(f.cancelled).toEqual(['A']);
    });

    it.each<
      [string, (s: { resolve: (r: StartReply) => void; reject: (e: unknown) => void }) => void]
    >([
      ['返回非 ok', (s) => s.resolve({ ok: false, code: 'failed', error: 'x' })],
      ['晚到的 rejection', (s) => s.reject(new Error('ipc gone'))],
    ])('A 的启动%s：不清理 B', async (_name, settleA) => {
      const { f, c, stopA } = await aStoppingThenB();
      f.starts[1]!.resolve({ ok: true, id: 'B' });
      await tick();
      settleA(f.starts[0]!);
      expect(await stopA).toBe('整段');
      await expectBIntact(f, c);
    });
  });

  it('stream start failure falls back to whole-utterance recognition', async () => {
    const f = fakes({ startFail: true });
    const c = make(f);
    await c.pttStart();
    f.push(30);
    expect(await c.pttStop()).toBe('整段');
    expect(f.api.transcribe).toHaveBeenCalledTimes(1);
  });

  it('main-process error event (e.g. local-only switched on) stops pushing and shows the reason', async () => {
    const f = fakes();
    const c = make(f);
    await c.pttStart();
    f.push(10);
    await Promise.resolve();
    const before = f.pushed.s1;
    f.emit({ id: 's1', type: 'error', code: 'local_only', error: '已开启仅本地' });
    expect(c.state.error).toMatchObject({ code: 'local_only' });
    f.push(10);
    expect(f.pushed.s1).toBe(before);
  });

  it('non-streaming engines keep the old path', async () => {
    const f = fakes();
    const c = new VoiceController({ api: f.api, source: 'chat', mic: () => f.mic, now: f.now });
    await c.pttStart();
    f.push(30);
    expect(await c.pttStop()).toBe('整段');
    expect(f.api.streamStart).not.toHaveBeenCalled();
  });

  it('dispose cancels the running stream and unsubscribes', async () => {
    const f = fakes();
    const c = make(f);
    await c.pttStart();
    f.push(10);
    await c.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.cancelled).toEqual(['s1']);
  });
});
