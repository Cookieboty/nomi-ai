/**
 * TTS 路由（纯逻辑，无 electron 依赖，便于单测）：
 *   none（默认）→ 不合成，AI 回复只出文字
 *   edge / azure / openai → 主进程尚未实现，静默（AI 回复只出文字）
 *   fish-local / fish-cloud（可选高级）→ Fish；失败 → 静默
 *   legacy → 交给 legacy 播放器；禁用 / 未知（含已移除的内置离线引擎）→ 静默
 */
import type { TTSConfig, TTSSpeakRequest, TTSSpeakResult } from '@nomi-ai/types';

export type TtsEngineKind = 'fish' | 'legacy' | 'none';

export function selectEngine(cfg: Pick<TTSConfig, 'enabled' | 'provider'>): TtsEngineKind {
  if (!cfg.enabled) return 'none';
  switch (cfg.provider) {
    case 'fish-local':
    case 'fish-cloud':
      return 'fish';
    case 'legacy':
      return 'legacy';
    default:
      return 'none';
  }
}

/**
 * CD_TTS=off（e2e）：不调用任何实时朗读引擎，tts:speak 直接静默（避免外网请求让用例不稳定）。
 */
export function applyTtsEnvOverride<T extends Pick<TTSConfig, 'enabled'>>(
  cfg: T,
  env: Record<string, string | undefined> = process.env,
): T {
  return env.CD_TTS === 'off' ? { ...cfg, enabled: false } : cfg;
}

export interface FishSpeaker {
  speak(req: TTSSpeakRequest): Promise<TTSSpeakResult>;
}

/** 每条 tts:speak 请求的结果摘要（success / fallback / error + provider），供主进程打日志 */
export interface TtsSpeakOutcome {
  outcome: 'success' | 'fallback' | 'error';
  /** 配置里选的 provider（none / edge / azure / openai / fish-local / fish-cloud / legacy） */
  provider: string;
  /** 实际出声的引擎；none = 没有生成音频 */
  via: TTSSpeakResult['via'];
  ms: number;
  textLength: number;
  /** 失败码（timeout …） */
  code?: string;
  message?: string;
  audioBytes?: number;
}

export interface TtsRouterDeps {
  getConfig: () => TTSConfig;
  fish: FishSpeaker;
  /** 每条请求结束时调用一次（成功 / 回退 / 异常） */
  onOutcome?: (o: TtsSpeakOutcome) => void;
  /** 单次请求总超时（默认 90s）：超时静默，避免 IPC 永久挂起 */
  speakTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_SPEAK_TIMEOUT_MS = 90_000;
const silent = (message: string): TTSSpeakResult => ({
  success: false,
  via: 'none',
  fallbackToSystem: false,
  message,
});

export class TtsRouter {
  constructor(private readonly deps: TtsRouterDeps) {}

  /**
   * 对外入口：包一层「必有结果日志 + 总超时」。任何路径（成功 / 回退 / 抛错 / 超时）都恰好上报一次 onOutcome。
   */
  async speak(req: TTSSpeakRequest): Promise<TTSSpeakResult> {
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    let provider = 'unknown';
    let lastCode: string | undefined;
    const textLength = req?.text?.length ?? 0;
    const report = (r: TTSSpeakResult | null, err?: unknown): void => {
      const message = err ? (err instanceof Error ? err.message : String(err)) : r?.message;
      const o: TtsSpeakOutcome = {
        outcome: err ? 'error' : r?.success ? 'success' : 'fallback',
        provider,
        via: r?.via ?? 'none',
        ms: now() - t0,
        textLength,
        code: lastCode,
        message,
        audioBytes: r?.audioBase64 ? Math.floor((r.audioBase64.length * 3) / 4) : undefined,
      };
      try {
        this.deps.onOutcome?.(o);
      } catch {
        /* 日志回调不得影响结果 */
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      provider = this.deps.getConfig().provider;
      const timeoutMs = this.deps.speakTimeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS;
      const timeout = new Promise<TTSSpeakResult>((resolve) => {
        timer = setTimeout(() => {
          lastCode = 'timeout';
          resolve(silent(`tts timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      const result = await Promise.race([this.route(req), timeout]);
      report(result);
      return result;
    } catch (err) {
      report(null, err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async route(req: TTSSpeakRequest): Promise<TTSSpeakResult> {
    const text = req.text?.trim();
    if (!text) return silent('empty text');

    const cfg = this.deps.getConfig();
    switch (selectEngine(cfg)) {
      case 'fish':
        return this.speakWith(() => this.deps.fish.speak({ ...req, text }));
      case 'legacy':
        return {
          success: false,
          via: 'legacy',
          fallbackToSystem: false,
          message: 'use legacy player',
        };
      default:
        if (!cfg.enabled) return silent('tts disabled');
        if (cfg.provider === 'none') return silent('no realtime TTS engine');
        if (cfg.provider === 'edge' || cfg.provider === 'azure' || cfg.provider === 'openai') {
          return silent(`${cfg.provider} TTS is not implemented yet`);
        }
        return silent('unsupported TTS provider');
    }
  }

  /** 引擎失败一律静默（不回退到其它引擎，也没有系统语音） */
  private async speakWith(run: () => Promise<TTSSpeakResult>): Promise<TTSSpeakResult> {
    try {
      const r = await run();
      if (r.success) return r;
      return silent(r.message || 'tts failed');
    } catch (err) {
      return silent(err instanceof Error ? err.message : String(err));
    }
  }
}
