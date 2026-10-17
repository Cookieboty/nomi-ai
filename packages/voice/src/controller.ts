/**
 * VoiceController —— 一个窗口里的语音输入状态机。
 *
 *   按住说话（ptt）：pttStart → 录音 → pttStop → 识别 → onTranscript
 *   免按键（handsfree）：VAD 分段，每句话说完自动识别
 *   唤醒词（wake）：VAD 分段 → 本地 whisper 转写 → 匹配唤醒词 → 进入「已唤醒」窗口接收下一句指令
 *
 * 每次状态变化都上报主进程（ai:voice:activity），由主进程广播给看板娘（表情）并处理打断 TTS。
 */
import { t } from '@nomi-ai/ui';

import { concatFloat32, encodeWav } from './audio';
import type { AsrErrorCode, VoiceApi } from './bridge';
import { MicCapture, MicError } from './mic';
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
  private settings: { vadThreshold: number; wakePhrase: string; wakeWindowSec: number } = {
    vadThreshold: 0.5,
    wakePhrase: '',
    wakeWindowSec: 8,
  };

  constructor(private readonly d: ControllerDeps) {
    this.mic = d.mic?.() ?? new MicCapture();
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
    this.gen += 1;
    this.set({ mode: 'ptt', phase: 'starting', error: null, elapsedMs: 0 });
    try {
      await this.mic.start({
        onFrame: (f) => {
          this.chunks.push(f);
          this.set({ elapsedMs: this.now() - this.startedAt });
        },
        onLevel: (level) => this.set({ level }),
      });
      this.startedAt = this.now();
      this.set({ phase: 'recording' });
    } catch (e) {
      this.set({ mode: 'off', phase: 'idle', level: 0 });
      this.fail(e);
    }
  }

  /** 松开：识别并回调；返回识别文本（取消 / 太短返回空串） */
  async pttStop(cancel = false): Promise<string> {
    if (this.st.mode !== 'ptt') return '';
    const ms = this.now() - this.startedAt;
    const gen = this.gen;
    await this.mic.stop();
    const audio = concatFloat32(this.chunks);
    this.chunks = [];
    if (cancel) {
      this.set({ mode: 'off', phase: 'idle', level: 0 });
      return '';
    }
    if (ms < MIN_PTT_MS || audio.length < 16000 * 0.3) {
      this.set({
        mode: 'off',
        phase: 'idle',
        level: 0,
        error: { code: 'too_short', message: t('说得太短了，按住按钮说话，说完再松开。') },
      });
      return '';
    }
    this.set({ phase: 'transcribing', level: 0 });
    const text = await this.recognize(audio, 'command');
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
    try {
      this.vad = await (this.d.createVad ?? defaultCreateVad)(this.d.api);
      this.seg = new Segmenter({
        threshold:
          this.vad.kind === 'silero'
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
        onLevel: (level) => this.set({ level }),
      });
      this.set({ phase: mode === 'wake' ? 'wake-armed' : 'listening', vad: this.vad.kind });
    } catch (e) {
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
      if (r.ok) {
        if (!quiet) this.set({ lastText: r.text });
        if (!r.text && !quiet)
          this.set({ error: { code: 'empty', message: t('没听清，再说一次？') } });
        return r.text;
      }
      if (!quiet || r.code !== 'empty') this.set({ error: { code: r.code, message: r.error } });
      if (purpose === 'wake' && (r.code === 'no_engine' || r.code === 'no_model'))
        await this.stopContinuous();
      return '';
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

  private emit(text: string, via: VoiceMode) {
    for (const f of this.transcriptSubs) f(text, via);
  }

  async dispose(): Promise<void> {
    await this.stopContinuous();
    if (this.st.mode === 'ptt') await this.pttStop(true);
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
