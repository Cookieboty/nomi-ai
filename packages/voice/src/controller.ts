/**
 * VoiceController —— 一个窗口里的语音输入状态机。
 *
 *   按住说话（ptt）：pttStart → 录音 → pttStop → 识别 → onTranscript
 *     流式引擎（豆包 2.0）：pttStart 同时开主进程流会话，边录边推 PCM，临时文本进 state.partial；
 *     pttStop 发送最后一包并取最终结果（只提交一次）；取消则直接丢弃会话。
 *   免按键（handsfree）：VAD 分段，每句话说完自动识别
 *   唤醒词（wake）：VAD 分段 → 本地 whisper 转写 → 匹配唤醒词 → 进入「已唤醒」窗口接收下一句指令
 *
 * 每次状态变化都上报主进程（ai:voice:activity），由主进程广播给桌面角色（表情）并处理打断 TTS。
 */
import { t } from '@nomi-ai/ui';

import { concatFloat32, encodeWav, floatToPcm16 } from './audio';
import type { AsrErrorCode, StreamEvent, TranscribeResult, VoiceApi } from './bridge';
import { MicCancelled, MicCapture, MicError } from './mic';
import { Segmenter } from './segmenter';
import { EnergyVad, RemoteVad, type VadEngine } from './vad';
import { matchWakePhrase } from './wake';

export type VoiceMode = 'off' | 'ptt' | 'handsfree' | 'wake';
export type VoicePhase =
  | 'idle'
  | 'starting'
  | 'recording' // 按住说话录音中
  | 'listening' // 免按键：等待说话
  | 'hearing' // 检测到正在说话
  | 'transcribing'
  | 'wake-armed' // 唤醒词：等待唤醒
  | 'awake'; // 已唤醒：等待指令

export interface VoiceError {
  code: AsrErrorCode | MicError['code'] | 'too_short';
  message: string;
}

export interface VoiceState {
  mode: VoiceMode;
  phase: VoicePhase;
  level: number;
  /** 录音时长（ms，按住说话） */
  elapsedMs: number;
  vad: 'silero' | 'energy' | null;
  error: VoiceError | null;
  lastText: string;
  /** 流式识别的临时文本（会被修订；不会自动发送） */
  partial: string;
}

export interface ControllerDeps {
  api: VoiceApi;
  source: 'chat' | 'mascot';
  mic?: () => Pick<MicCapture, 'start' | 'stop' | 'running'>;
  createVad?: (api: VoiceApi) => Promise<VadEngine>;
  now?: () => number;
}

const MIN_PTT_MS = 350;

export class VoiceController {
  private st: VoiceState = {
    mode: 'off',
    phase: 'idle',
    level: 0,
    elapsedMs: 0,
    vad: null,
    error: null,
    lastText: '',
    partial: '',
  };
  private readonly subs = new Set<(s: VoiceState) => void>();
  private readonly transcriptSubs = new Set<(text: string, via: VoiceMode) => void>();
  private readonly mic: Pick<MicCapture, 'start' | 'stop' | 'running'>;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private vad: VadEngine | null = null;
  private seg: Segmenter | null = null;
  private awakeUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  /**
   * 会话代次：每次开始 / 停止一个会话（PTT 或免按键）都 +1。
   * 排队中的麦克风帧、飞行中的 VAD / 识别结果带着发起时的代次回来，代次不一致就丢弃，
   * 避免「停止后马上重新开始」时旧会话的帧 / 识别文本串到新会话里（仅比较 mode 不够：新会话 mode 可能相同）。
   */
  private gen = 0;
  private settings: {
    vadThreshold: number;
    wakePhrase: string;
    wakeWindowSec: number;
    /** 当前引擎支持流式（豆包 2.0）：按住说话时边录边识别 */
    streaming: boolean;
  } = {
    vadThreshold: 0.5,
    wakePhrase: '',
    wakeWindowSec: 8,
    streaming: false,
  };
  /** 流式会话：id 未就绪前的音频先缓存；每 ~100ms 合并推一次 */
  private stream: {
    gen: number;
    id: string | null;
    ready: Promise<string | null>;
    pending: Uint8Array[];
    pendingBytes: number;
    failed: boolean;
    eventError: { code: AsrErrorCode; message: string } | null;
  } | null = null;
  private readonly offStream: (() => void) | undefined;

  constructor(private readonly d: ControllerDeps) {
    this.mic = d.mic?.() ?? new MicCapture();
    this.offStream = d.api.onStream?.((e) => this.onStreamEvent(e));
  }

  private onStreamEvent(e: StreamEvent) {
    const s = this.stream;
    if (!s || !s.id || e.id !== s.id || s.gen !== this.gen) return; // 旧会话 / 别的会话
    if (e.type === 'partial' && typeof e.text === 'string') this.set({ partial: e.text });
    if (e.type === 'error') {
      // 主进程已结束这次会话（如中途开启「仅本地模型」）：停止推送，立即提示
      s.eventError = {
        code: e.code ?? 'failed',
        message: e.error ?? t('ui.voice-mascot.recognition-failed'),
      };
      s.failed = true;
      s.pending = [];
      this.set({ error: s.eventError });
    }
  }

  private openStream(gen: number) {
    const api = this.d.api;
    const rec: NonNullable<VoiceController['stream']> = {
      gen,
      id: null,
      ready: Promise.resolve(null),
      pending: [],
      pendingBytes: 0,
      failed: false,
      eventError: null,
    };
    rec.ready = api
      .streamStart(this.d.source)
      .then((r) => {
        if (!r.ok) {
          rec.failed = true;
          return null;
        }
        // 启动期间已取消 / 被新会话取代：关掉刚开的会话，旧音频不进新会话
        if (this.stream !== rec || gen !== this.gen) {
          void api.streamCancel(r.id).catch(() => undefined);
          return null;
        }
        rec.id = r.id;
        this.flushStream(rec, true);
        return r.id;
      })
      .catch(() => {
        rec.failed = true;
        return null;
      });
    this.stream = rec;
  }

  private pushStream(f: Float32Array, gen: number) {
    const rec = this.stream;
    if (!rec || rec.gen !== gen || rec.failed) return;
    const bytes = floatToPcm16(f);
    rec.pending.push(bytes);
    rec.pendingBytes += bytes.byteLength;
    if (rec.pendingBytes > 16000 * 2 * 60) {
      // 一分钟还没建好连接：不再缓存（最终按整段识别）
      rec.failed = true;
      rec.pending = [];
      return;
    }
    this.flushStream(rec, false);
  }

  private flushStream(rec: NonNullable<VoiceController['stream']>, force: boolean) {
    if (!rec.id || (!force && rec.pendingBytes < 3200)) return;
    const id = rec.id;
    while (rec.pending.length) {
      // 单次 IPC 不超过 32 KB
      const parts: Uint8Array[] = [];
      let n = 0;
      while (rec.pending.length && n + rec.pending[0]!.byteLength <= 32 * 1024) {
        const p = rec.pending.shift()!;
        parts.push(p);
        n += p.byteLength;
      }
      if (!parts.length) parts.push(rec.pending.shift()!.subarray(0, 32 * 1024));
      const buf = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.byteLength;
      }
      void this.d.api.streamPush(id, buf).catch(() => undefined);
    }
    rec.pendingBytes = 0;
  }

  /** 丢弃流式会话（取消 / 太短 / 被取代） */
  private dropStream() {
    const rec = this.stream;
    this.stream = null;
    if (!rec) return;
    void rec.ready.then((id) => {
      if (id) void this.d.api.streamCancel(id).catch(() => undefined);
    });
  }

  get state(): VoiceState {
    return this.st;
  }

  subscribe(fn: (s: VoiceState) => void): () => void {
    this.subs.add(fn);
    fn(this.st);
    return () => this.subs.delete(fn);
  }

  onTranscript(fn: (text: string, via: VoiceMode) => void): () => void {
    this.transcriptSubs.add(fn);
    return () => this.transcriptSubs.delete(fn);
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private set(p: Partial<VoiceState>) {
    const prevPhase = this.st.phase;
    this.st = { ...this.st, ...p };
    for (const f of this.subs) f(this.st);
    if (p.phase && p.phase !== prevPhase && p.phase !== 'starting') {
      const activity =
        p.phase === 'recording' || p.phase === 'listening' || p.phase === 'awake'
          ? 'listening'
          : p.phase === 'hearing'
            ? 'hearing'
            : p.phase === 'transcribing'
              ? 'transcribing'
              : p.phase === 'wake-armed'
                ? 'wake-armed'
                : 'idle';
      void this.d.api.activity(activity, `${this.d.source}:${this.st.mode}`).catch(() => undefined);
    }
  }

  clearError(): void {
    this.set({ error: null });
  }

  private fail(e: unknown) {
    const err: VoiceError =
      e instanceof MicError
        ? { code: e.code, message: e.message }
        : { code: 'failed', message: e instanceof Error ? e.message : String(e) };
    this.set({ error: err });
  }

  // ---------------------------------------------------------------- 按住说话
  async pttStart(): Promise<void> {
    if (this.st.phase === 'recording' || this.st.phase === 'starting') return;
    if (this.st.mode !== 'off' && this.st.mode !== 'ptt') await this.stopContinuous();
    this.chunks = [];
    const gen = ++this.gen;
    this.dropStream();
    this.set({ mode: 'ptt', phase: 'starting', error: null, elapsedMs: 0, partial: '' });
    // 与打开麦克风并行建连，减少首字等待
    if (this.settings.streaming && typeof this.d.api.streamStart === 'function')
      this.openStream(gen);
    try {
      await this.mic.start({
        onFrame: (f) => {
          if (gen !== this.gen) return;
          this.chunks.push(f);
          this.pushStream(f, gen);
          this.set({ elapsedMs: this.now() - this.startedAt });
        },
        onLevel: (level) => {
          if (gen === this.gen) this.set({ level });
        },
      });
      // 启动期间被取消 / 被新会话取代：状态已由取消方处理，不能再切回 recording
      if (gen !== this.gen) return;
      this.startedAt = this.now();
      this.set({ phase: 'recording' });
    } catch (e) {
      if (gen !== this.gen || e instanceof MicCancelled) return;
      this.dropStream();
      this.set({ mode: 'off', phase: 'idle', level: 0 });
      this.fail(e);
    }
  }

  /** 松开：识别并回调；返回识别文本（取消 / 太短返回空串） */
  async pttStop(cancel = false): Promise<string> {
    if (this.st.mode !== 'ptt') return '';
    const ms = this.now() - this.startedAt;
    // 先换代次：仍在启动中的 pttStart / 排队帧都会因此失效（取消一定落实）
    const gen = ++this.gen;
    await this.mic.stop();
    const audio = concatFloat32(this.chunks);
    this.chunks = [];
    const stream = this.stream;
    if (cancel) {
      this.dropStream();
      this.set({ mode: 'off', phase: 'idle', level: 0, partial: '' });
      return '';
    }
    if (ms < MIN_PTT_MS || audio.length < 16000 * 0.3) {
      this.dropStream();
      this.set({
        mode: 'off',
        phase: 'idle',
        level: 0,
        partial: '',
        error: {
          code: 'too_short',
          message: t('ui.voice-mascot.too-short-hold-the-button-while-talking-then'),
        },
      });
      return '';
    }
    this.set({ phase: 'transcribing', level: 0 });
    let text: string;
    const id = stream ? await stream.ready : null;
    // 只释放自己的流记录：等启动回复期间可能已经开始了新录音 B，this.stream 已是 B 的，
    // 清掉会让 B 的音频 / 临时文本 / 结束都丢失（#70）
    if (this.stream === stream) this.stream = null;
    if (stream && id) {
      this.flushStream(stream, true);
      let r: TranscribeResult;
      try {
        r = await this.d.api.streamStop(id);
      } catch (e) {
        r = { ok: false, code: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok && stream.eventError)
        r = { ok: false, code: stream.eventError.code, error: stream.eventError.message };
      text = this.handleResult(r, 'command', false);
    } else {
      // 没有流式会话（非流式引擎，或建连失败 / 启动回复晚于松开）：整段识别
      text = await this.recognize(audio, 'command');
    }
    if (gen === this.gen) this.set({ partial: '' });
    // 识别期间已开始新会话：别把新会话的状态重置掉（识别出的文本照常交付）
    if (gen === this.gen) this.set({ mode: 'off', phase: 'idle' });
    if (text) this.emit(text, 'ptt');
    return text;
  }

  // ---------------------------------------------------------------- 免按键 / 唤醒词
  /** 设置变化（唤醒词、灵敏度等）即时生效，无需重启麦克风 */
  updateSettings(patch: Partial<VoiceController['settings']>): void {
    const next = { ...this.settings };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    this.settings = next;
    this.seg?.setThreshold(
      this.vad?.kind === 'silero' ? next.vadThreshold : Math.min(0.9, next.vadThreshold + 0.1),
    );
  }

  async startContinuous(
    mode: 'handsfree' | 'wake',
    settings?: Partial<VoiceController['settings']>,
  ): Promise<void> {
    if (this.st.mode === mode) return;
    await this.stopContinuous();
    // 先 stop 再取代次：await 期间可能有别的 start/stop，以最后一次为准
    const gen = ++this.gen;
    this.settings = { ...this.settings, ...settings };
    this.set({ mode, phase: 'starting', error: null });
    let vad: VadEngine | null = null;
    try {
      vad = await (this.d.createVad ?? defaultCreateVad)(this.d.api);
      if (gen !== this.gen) {
        // createVad 等待期间被停止 / 取代：只释放自己创建的 VAD
        vad.dispose();
        return;
      }
      this.vad = vad;
      this.seg = new Segmenter({
        threshold:
          vad.kind === 'silero'
            ? this.settings.vadThreshold
            : Math.min(0.9, this.settings.vadThreshold + 0.1),
        maxSpeechMs: mode === 'wake' ? 6000 : 30_000,
      });
      await this.mic.start({
        onFrame: (f) => {
          if (gen !== this.gen) return;
          this.queue = this.queue
            .then(() => this.onContinuousFrame(f, gen))
            .catch((e) => this.fail(e));
        },
        onLevel: (level) => {
          if (gen === this.gen) this.set({ level });
        },
      });
      if (gen !== this.gen) return; // 启动期间已被停止 / 取代，状态由取消方处理
      this.set({ phase: mode === 'wake' ? 'wake-armed' : 'listening', vad: vad.kind });
    } catch (e) {
      if (gen !== this.gen || e instanceof MicCancelled) {
        // 旧会话的失败不能动新会话的状态；只释放自己的 VAD（若已被新会话接管则不是它）
        if (vad && this.vad !== vad) vad.dispose();
        return;
      }
      this.vad?.dispose();
      this.vad = null;
      this.set({ mode: 'off', phase: 'idle', level: 0, vad: null });
      this.fail(e);
    }
  }

  async stopContinuous(): Promise<void> {
    if (this.st.mode !== 'handsfree' && this.st.mode !== 'wake') return;
    this.gen += 1; // 之后到达的旧会话帧 / 识别结果一律丢弃
    await this.mic.stop();
    this.vad?.dispose();
    this.vad = null;
    this.seg = null;
    this.awakeUntil = 0;
    this.set({ mode: 'off', phase: 'idle', level: 0, vad: null });
  }

  private restingPhase(): VoicePhase {
    if (this.st.mode === 'wake') return this.now() < this.awakeUntil ? 'awake' : 'wake-armed';
    return 'listening';
  }

  private async onContinuousFrame(f: Float32Array, gen: number): Promise<void> {
    if (gen !== this.gen) return;
    const vad = this.vad;
    const seg = this.seg;
    if (!vad || !seg) return;
    const p = await vad.prob(f);
    // 等待推理期间可能已经停止 / 重新开始：只处理同一会话
    if (this.seg !== seg || gen !== this.gen) return;
    if (this.st.mode === 'wake' && this.st.phase === 'awake' && this.now() >= this.awakeUntil)
      this.set({ phase: 'wake-armed' });
    for (const ev of seg.push(f, p)) {
      if (ev.type === 'start') {
        if (this.st.mode === 'handsfree' || this.st.phase === 'awake')
          this.set({ phase: 'hearing' });
      } else if (ev.type === 'end') {
        void this.handleSegment(ev.audio, gen);
      }
    }
  }

  private async handleSegment(audio: Float32Array, gen: number): Promise<void> {
    const mode = this.st.mode;
    if (mode === 'handsfree') {
      this.set({ phase: 'transcribing' });
      const text = await this.recognize(audio, 'command');
      if (gen !== this.gen || this.st.mode !== mode) return;
      this.set({ phase: 'listening' });
      if (text) this.emit(text, 'handsfree');
      return;
    }
    if (mode !== 'wake') return;
    const awake = this.now() < this.awakeUntil;
    if (awake) {
      this.set({ phase: 'transcribing' });
      const text = await this.recognize(audio, 'command');
      if (gen !== this.gen) return;
      this.awakeUntil = 0;
      if (this.st.mode !== 'wake') return;
      this.set({ phase: 'wake-armed' });
      if (text) this.emit(text, 'wake');
      return;
    }
    // 未唤醒：只做本地短句检查，不打扰 UI（不显示「识别中」）
    const text = await this.recognize(audio, 'wake', true);
    if (gen !== this.gen || this.st.mode !== 'wake' || !text) return;
    const m = matchWakePhrase(text, this.settings.wakePhrase);
    if (!m.matched) return;
    if (m.rest.length >= 2) {
      this.emit(m.rest, 'wake');
      this.set({ phase: 'wake-armed' });
    } else {
      this.awakeUntil = this.now() + this.settings.wakeWindowSec * 1000;
      this.set({ phase: 'awake' });
    }
  }

  private async recognize(
    audio: Float32Array,
    purpose: 'command' | 'wake',
    quiet = false,
  ): Promise<string> {
    try {
      const r = await this.d.api.transcribe(encodeWav(audio), this.d.source, purpose);
      const text = this.handleResult(r, purpose, quiet);
      if (!r.ok && purpose === 'wake' && (r.code === 'no_engine' || r.code === 'no_model'))
        await this.stopContinuous();
      return text;
    } catch (e) {
      this.fail(e);
      return '';
    } finally {
      if (
        this.st.phase === 'transcribing' &&
        (this.st.mode === 'handsfree' || this.st.mode === 'wake')
      )
        this.set({ phase: this.restingPhase() });
    }
  }

  private handleResult(r: TranscribeResult, purpose: 'command' | 'wake', quiet: boolean): string {
    if (r.ok) {
      if (!quiet) this.set({ lastText: r.text });
      if (!r.text && !quiet)
        this.set({
          error: { code: 'empty', message: t('ui.voice-mascot.didn-t-catch-that-say-it-again') },
        });
      return r.text;
    }
    if (!quiet || r.code !== 'empty') this.set({ error: { code: r.code, message: r.error } });
    void purpose;
    return '';
  }

  private emit(text: string, via: VoiceMode) {
    for (const f of this.transcriptSubs) f(text, via);
  }

  async dispose(): Promise<void> {
    await this.stopContinuous();
    if (this.st.mode === 'ptt') await this.pttStop(true);
    this.dropStream();
    this.offStream?.();
    this.subs.clear();
    this.transcriptSubs.clear();
  }
}

async function defaultCreateVad(api: VoiceApi): Promise<VadEngine> {
  const r = await api.vadOpen().catch(() => ({ kind: 'energy' as const }));
  if (r.kind === 'silero' && 'handle' in r && r.handle) {
    const h = r.handle;
    return new RemoteVad(
      (f) => api.vadProb(h, f),
      () => void api.vadClose(h).catch(() => undefined),
    );
  }
  return new EnergyVad();
}
