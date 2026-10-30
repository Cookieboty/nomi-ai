/**
 * 麦克风采集：getUserMedia（开启回声消除 / 降噪 / 自动增益，减少把桌面角色自己的 TTS 录进去）
 * → ScriptProcessor（不需要额外脚本文件，兼容严格 CSP）→ 16 kHz → 512 样本帧。
 */
import { t as tr } from '@nomi-ai/ui';

import { levelOf, resampleTo16k } from './audio';
import { FRAME } from './vad';

export class MicError extends Error {
  constructor(
    readonly code: 'mic_denied' | 'mic_missing' | 'mic_busy' | 'mic_failed',
    message: string,
  ) {
    super(message);
  }
}

/** start() 期间被 stop() / 新的 start() 取代：晚到的设备已经被释放，调用方不应再把它当作失败或成功处理。 */
export class MicCancelled extends Error {
  constructor() {
    super('mic start cancelled');
  }
}

export function micErrorFrom(e: unknown): MicError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new MicError(
      'mic_denied',
      tr('ui.voice-mascot.microphone-access-denied-allow-nomi-in-system-settings'),
    );
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new MicError('mic_missing', tr('ui.voice-mascot.no-microphone-found'));
  if (name === 'NotReadableError' || name === 'AbortError')
    return new MicError('mic_busy', tr('ui.voice-mascot.the-microphone-is-in-use-by-another-app'));
  return new MicError(
    'mic_failed',
    tr('ui.voice-mascot.couldn-t-open-the-microphone', (e as Error)?.message ?? String(e)),
  );
}

export interface MicHandlers {
  onFrame(frame: Float32Array): void;
  onLevel?(level: number): void;
}

export class MicCapture {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioNode;
  private src?: MediaStreamAudioSourceNode;
  private pending = new Float32Array(0);
  /**
   * 启动代次：start() 与 stop() 都会 +1。start 的每个 await 之后都比较自己的代次，
   * 不一致就只释放「本次启动自己拿到的」stream / context，再抛 MicCancelled（#20）。
   */
  private token = 0;

  get running(): boolean {
    return !!this.ctx;
  }

  async start(h: MicHandlers): Promise<void> {
    if (this.ctx) return;
    const my = ++this.token;
    const cancelled = () => my !== this.token;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      if (cancelled()) throw new MicCancelled();
      throw micErrorFrom(e);
    }
    if (cancelled()) {
      // 取消后才返回的设备：立即释放，不创建 context、不产生帧
      stream.getTracks().forEach((t) => t.stop());
      throw new MicCancelled();
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    this.stream = stream;
    this.ctx = ctx;
    this.src = src;
    const rate = ctx.sampleRate;
    const onSamples = (input: Float32Array) => {
      if (cancelled()) return;
      h.onLevel?.(levelOf(input));
      const res = resampleTo16k(input, rate);
      const merged = new Float32Array(this.pending.length + res.length);
      merged.set(this.pending);
      merged.set(res, this.pending.length);
      let o = 0;
      for (; o + FRAME <= merged.length; o += FRAME) h.onFrame(merged.slice(o, o + FRAME));
      this.pending = merged.slice(o);
    };
    // 本次启动自己的资源释放（stop() 已经接管了 this.* 时，这里只是补刀：都是幂等的）
    const releaseOwn = () => {
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    };
    // 首选 AudioWorklet（音频线程，不丢帧）；不支持时退回 ScriptProcessor
    try {
      await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
      if (cancelled()) {
        releaseOwn();
        throw new MicCancelled();
      }
      const node = new AudioWorkletNode(ctx, 'cd-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => onSamples(ev.data);
      this.node = node;
      src.connect(node);
    } catch (e) {
      if (e instanceof MicCancelled) throw e;
      if (cancelled()) {
        releaseOwn();
        throw new MicCancelled();
      }
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (ev) => onSamples(new Float32Array(ev.inputBuffer.getChannelData(0)));
      this.node = sp;
      src.connect(sp);
      // ScriptProcessor 需要连到 destination 才会被驱动；输出全 0，不会出声
      sp.connect(ctx.destination);
    }
  }

  async stop(): Promise<void> {
    this.token += 1; // 取消仍在启动中的 start()
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.ctx;
    this.ctx = undefined;
    this.node = undefined;
    this.src = undefined;
    this.stream = undefined;
    this.pending = new Float32Array(0);
    await ctx?.close().catch(() => undefined);
  }
}
