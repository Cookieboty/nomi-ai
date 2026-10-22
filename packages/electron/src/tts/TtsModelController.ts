/**
 * TTS 模型按需下载编排（主进程）。模型不再随安装包分发，见 docs/design/tts-on-demand.md。
 *
 * 规则：
 * - 用户开启语音（设置页开关 / 看板娘工具栏）且当前 provider 为 sherpa、模型缺失 → 下载；
 *   下载失败或被取消 → 语音关回去（并带错误信息），绝不在没有模型时保持「开着却不响」。
 * - 启动时**不**自动下载（#60：应用启动不算用户同意下载）：语音已开但缺模型（老用户升级 / 切到 sherpa）
 *   只在设置页显示「需要下载」+ 一键下载，由用户触发（ai:tts-model:download，不改语音开关）。
 * - 下载中途关掉语音 → 取消下载（与「取消」按钮一致：删除半成品，不继续占带宽 / 磁盘）。
 * - 缺模型时合成只返回 not_ready（静默 + 提示），永不崩溃。
 * 纯逻辑：所有副作用经 deps 注入，便于单测。
 */
import type { SherpaModelStatus } from '@nomi-ai/types';

export interface TtsModelSpeaker {
  getStatus(): SherpaModelStatus;
  isReady(): boolean;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModel(): Promise<SherpaModelStatus>;
  onStatus(fn: (s: SherpaModelStatus) => void): () => void;
}

export interface TtsModelControllerDeps {
  sherpa: TtsModelSpeaker;
  getVoiceEnabled: () => boolean;
  /** 持久化 voiceSettings.enabled 并广播给渲染进程 */
  setVoiceEnabled: (enabled: boolean) => void;
  /**
   * 用户打开语音时把朗读引擎配置（tts-config.json）也设为启用：旧版设置页关掉的引擎没有别的入口
   * 能再打开，否则开关是开的、朗读却一直是「tts disabled」（#82）。关闭语音时不动它。
   */
  enableEngine?: () => void;
  /** 当前 TTS provider 是否本地 sherpa（只有 sherpa 需要模型） */
  usesSherpa: () => boolean;
  /** CD_TTS=off（E2E）时不自动下载 */
  ttsDisabled?: () => boolean;
  /** 模型状态推送（ai:tts-model:changed） */
  broadcast: (s: TtsModelState) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface TtsModelState extends SherpaModelStatus {
  voiceEnabled: boolean;
}

export interface EnableResult {
  ok: boolean;
  voiceEnabled: boolean;
  /** 'cancelled' | 失败原因 */
  error?: string;
  status: TtsModelState;
}

export class TtsModelController {
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: TtsModelControllerDeps) {}

  state(): TtsModelState {
    return { ...this.deps.sherpa.getStatus(), voiceEnabled: this.deps.getVoiceEnabled() };
  }

  private push(): void {
    this.deps.broadcast(this.state());
  }

  /**
   * 订阅模型进度。启动时不下载（#60）：语音开着但缺模型时只记日志，设置页显示「需要下载」由用户触发。
   */
  start(): void {
    this.unsub ??= this.deps.sherpa.onStatus(() => this.push());
    this.push();
    if (this.deps.ttsDisabled?.()) return;
    if (!this.deps.getVoiceEnabled() || !this.deps.usesSherpa()) return;
    if (this.deps.sherpa.isReady()) return;
    this.deps.log?.('voice enabled but TTS model missing; waiting for the user to download it');
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * 开 / 关语音（设置页、工具栏共用）。开启时按需下载，失败或取消则关回去。
   * @param alreadyPersisted 工具栏已经写入 enabled=true（save-voice-settings），这里只负责下载与回滚
   */
  async setVoiceEnabled(enabled: boolean, alreadyPersisted = false): Promise<EnableResult> {
    if (!enabled) {
      if (!alreadyPersisted) this.deps.setVoiceEnabled(false);
      // 下载中途关掉语音：取消下载（与「取消」一致），不在后台继续下 ~115 MB
      if (this.deps.sherpa.getStatus().state === 'downloading') {
        await this.deps.sherpa.cancelDownload().catch(() => undefined);
      }
      this.push();
      return { ok: true, voiceEnabled: false, status: this.state() };
    }
    if (!alreadyPersisted) this.deps.setVoiceEnabled(true);
    this.deps.enableEngine?.();
    this.push();
    if (!this.deps.usesSherpa() || this.deps.sherpa.isReady()) {
      return { ok: true, voiceEnabled: true, status: this.state() };
    }
    try {
      await this.deps.sherpa.download();
      this.push();
      return { ok: true, voiceEnabled: this.deps.getVoiceEnabled(), status: this.state() };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const error =
        code === 'superseded' ? 'cancelled' : e instanceof Error ? e.message : String(e);
      this.deps.log?.(`voice enable rolled back: ${error}`);
      this.deps.setVoiceEnabled(false);
      this.push();
      return { ok: false, voiceEnabled: false, error, status: this.state() };
    }
  }

  /** 重试 / 单独下载（不改语音开关） */
  async download(): Promise<EnableResult> {
    try {
      await this.deps.sherpa.download();
      return { ok: true, voiceEnabled: this.deps.getVoiceEnabled(), status: this.state() };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const error =
        code === 'superseded' ? 'cancelled' : e instanceof Error ? e.message : String(e);
      return { ok: false, voiceEnabled: this.deps.getVoiceEnabled(), error, status: this.state() };
    }
  }

  async cancel(): Promise<TtsModelState> {
    await this.deps.sherpa.cancelDownload();
    // 启动时自动下载被取消：没有模型就别保持开着
    if (this.deps.usesSherpa() && !this.deps.sherpa.isReady() && this.deps.getVoiceEnabled()) {
      this.deps.setVoiceEnabled(false);
    }
    this.push();
    return this.state();
  }

  async deleteModel(): Promise<TtsModelState> {
    await this.deps.sherpa.deleteModel();
    if (this.deps.usesSherpa() && !this.deps.sherpa.isReady() && this.deps.getVoiceEnabled()) {
      this.deps.setVoiceEnabled(false);
    }
    this.push();
    return this.state();
  }
}
