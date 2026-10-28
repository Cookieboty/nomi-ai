/**
 * 朗读服务（主进程）：实时朗读配置（userData/tts-config.json）、Edge 在线朗读的合成 / 试听 / 打断 /
 * 健康状态、把 AI 回复转给看板娘朗读。Azure / OpenAI 尚未接入。
 *
 * 任何合成失败都静默（渲染层只显示文字），连续失败次数经 `status()` 给设置页显示提示。
 * 契约（host/contract/media.ts 的 `tts.*`）只用这一个实例：打断（stop）要能取消同一个引擎里的请求。
 */
import type { HostPorts } from '@nomi-ai/host-ports';
import type {
  TTSConfig,
  TTSPreviewRequest,
  TTSSpeakRequest,
  TTSSpeakResult,
  TTSStatus,
  TTSTestResult,
} from '@nomi-ai/types';

import { sendMascotCommand } from '../ai/mascotCommand';
import type { AppEvents } from '../core/appEvents';
import { t } from '../i18n';

import { EdgeTtsService } from './edge/EdgeTtsService';
import { BUILTIN_ZH_VOICES, listChineseVoices, type VoiceList } from './edge/edgeVoices';
import { replySpeechCommand, type ReplySpeechCommand } from './replySpeech';
import { TtsConfigStore } from './TtsConfigStore';
import { TtsRouter, applyTtsEnvOverride } from './ttsRouter';

interface TtsLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface TtsServiceDeps {
  paths: Pick<HostPorts['paths'], 'userData'>;
  logger: TtsLogger;
  /** 默认 process.env（CD_TTS=off：e2e 不联网） */
  env?: Record<string, string | undefined>;
  /** 测试注入 */
  edge?: EdgeTtsService;
  /** 应用事件总线：朗读回复默认经 mascot:command 转给看板娘窗口 */
  events?: AppEvents;
  /** 测试注入：替代经 events 的 mascot:command */
  sendToMascot?: (cmd: ReplySpeechCommand) => void;
}

export class TtsService {
  private readonly store: TtsConfigStore;
  private readonly edge: EdgeTtsService;
  private readonly router: TtsRouter;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly d: TtsServiceDeps) {
    this.env = d.env ?? process.env;
    this.store = new TtsConfigStore({ paths: d.paths });
    this.edge = d.edge ?? new EdgeTtsService();
    this.router = new TtsRouter({
      getConfig: () => applyTtsEnvOverride(this.store.load(), this.env),
      edge: this.edge,
      onOutcome: (o) => this.d.logger.debug('tts:speak', o),
    });
  }

  private notAvailable(provider: TTSConfig['provider']): TTSTestResult {
    return provider === 'none'
      ? { success: true, message: t('electron.common.no-realtime-tts-engine-selected') }
      : { success: false, message: t('electron.common.this-tts-engine-is-not-available-yet') };
  }

  /** 试听 / 测试都用传入的（未保存的）配置，CD_TTS=off 时仍静默 */
  private previewRouter(cfg: Partial<TTSConfig>): TtsRouter {
    return new TtsRouter({
      getConfig: () =>
        applyTtsEnvOverride({ ...this.store.load(), ...cfg, enabled: true } as TTSConfig, this.env),
      edge: this.edge,
    });
  }

  /** 无文件时返回默认（Edge 实时朗读 + 角色提示语音开）；读取失败返回 null */
  getConfig(): TTSConfig | null {
    try {
      return this.store.load();
    } catch (error) {
      this.d.logger.error('获取TTS配置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 校验不通过时抛错 */
  saveConfig(config: TTSConfig): TTSConfig {
    try {
      const saved = this.store.save(config);
      this.d.logger.info('TTS配置保存成功', { provider: saved.provider, enabled: saved.enabled });
      return saved;
    } catch (error) {
      this.d.logger.error('TTS配置保存失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  resetConfig(): void {
    try {
      this.store.reset();
      this.d.logger.info('TTS配置已重置');
    } catch (error) {
      this.d.logger.error('重置TTS配置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async testConnection(config: TTSConfig): Promise<TTSTestResult> {
    if (config.provider !== 'edge') return { ...this.notAvailable(config.provider), latency: 0 };
    const t0 = Date.now();
    const r = await this.previewRouter(config).speak({
      text: t('electron.common.tts-test-sentence'),
    });
    return r.success
      ? {
          success: true,
          message: t('electron.common.realtime-tts-reachable'),
          latency: Date.now() - t0,
        }
      : { success: false, message: t('electron.common.realtime-tts-unreachable'), latency: 0 };
  }

  preview(req: TTSPreviewRequest): Promise<TTSSpeakResult> {
    return this.previewRouter({
      provider: req.provider,
      edgeVoice: req.edgeVoice,
      rate: req.rate,
    }).speak({ text: String(req.text ?? '').slice(0, 300) });
  }

  /** CD_TTS=off（e2e）不联网，直接给内置列表 */
  async voices(): Promise<VoiceList> {
    return this.env.CD_TTS === 'off'
      ? { voices: [...BUILTIN_ZH_VOICES], source: 'builtin' }
      : listChineseVoices();
  }

  status(): TTSStatus {
    return this.edge.getStatus();
  }

  /** 打断：取消还在等音频的请求 */
  stop(): boolean {
    this.edge.stop();
    return true;
  }

  /** 合成路由：成功返回 mp3（base64），失败静默 */
  speak(req: TTSSpeakRequest | null | undefined): Promise<TTSSpeakResult> {
    return this.router.speak(req ?? { text: '' });
  }

  /**
   * 朗读 AI 回复：对话窗口把整句转发到看板娘窗口（沿用 mascot:command → tts:speak 播放链路）。
   * 停止由看板娘窗口处理（它在朗读回复时才停播放并取消合成），不在这里误停别的台词。
   */
  reply(msg: unknown): boolean {
    let cfg: TTSConfig | null;
    try {
      cfg = this.store.load();
    } catch {
      cfg = null;
    }
    const cmd = replySpeechCommand(msg, cfg, this.env);
    if (!cmd) return false;
    if (this.d.sendToMascot) this.d.sendToMascot(cmd);
    else sendMascotCommand(this.d.events, cmd);
    return true;
  }

  /** 角色提示语音开关：看板娘窗口据此决定是否播放预录提示语 */
  promptVoice(): boolean {
    try {
      return this.store.load().promptVoice !== false;
    } catch {
      return true;
    }
  }

  health(config?: Partial<TTSConfig>): TTSTestResult {
    const provider = config?.provider ?? this.store.load().provider;
    if (provider === 'edge') {
      const s = this.edge.getStatus();
      return s.consecutiveFailures >= 3
        ? { success: false, message: t('electron.common.realtime-tts-unreachable') }
        : { success: true, message: t('electron.common.realtime-tts-reachable') };
    }
    const res = this.notAvailable(provider);
    return res.success ? { ...res, success: false } : res;
  }
}
