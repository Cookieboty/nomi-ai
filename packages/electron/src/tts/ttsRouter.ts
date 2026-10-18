/**
 * TTS 路由（纯逻辑，无 electron 依赖，便于单测）：
 *   sherpa-theresa（默认）→ 本地离线；失败 / 模型未就绪 → 静默
 *   fish-local / fish-cloud（可选高级）→ Fish；失败 → 再试 sherpa → 仍失败则静默
 *   legacy → 交给 legacy 播放器；禁用 / 未知 → 静默
 */
import type { TTSConfig, TTSSpeakRequest, TTSSpeakResult } from '@nomi-ai/types';

export type TtsEngineKind = 'sherpa' | 'fish' | 'legacy' | 'none';

export function selectEngine(cfg: Pick<TTSConfig, 'enabled' | 'provider'>): TtsEngineKind {
  if (!cfg.enabled) return 'none';
  switch (cfg.provider) {
    case 'sherpa-theresa':
      return 'sherpa';
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
 * CD_TTS=off（e2e）：不跑离线 sherpa / Fish 合成，tts:speak 直接静默。
 * 4 线程 ONNX 合成 + 自动下载解压模型会和 swiftshader 渲染抢 CPU，拖垮 Windows runner
 * （气泡事件迟到、对话窗渲染进程 crash）。真实 sherpa 行为由单测覆盖。
 */
export function applyTtsEnvOverride<T extends Pick<TTSConfig, 'enabled'>>(
  cfg: T,
  env: Record<string, string | undefined> = process.env,
): T {
  return env.CD_TTS === 'off' ? { ...cfg, enabled: false } : cfg;
}

export interface SherpaSpeaker {
  synthesize(
    text: string,
    opts: { sid?: number; speed?: number },
  ): Promise<{ wav: Buffer; durationMs?: number }>;
}

export interface FishSpeaker {
  speak(req: TTSSpeakRequest): Promise<TTSSpeakResult>;
}

/** 每条 tts:speak 请求的结果摘要（success / fallback / error + provider），供主进程打日志 */
export interface TtsSpeakOutcome {
  outcome: 'success' | 'fallback' | 'error';
  /** 配置里选的 provider（sherpa-theresa / fish-local / fish-cloud / legacy） */
  provider: string;
  /** 实际出声的引擎；none = 没有生成音频 */
  via: TTSSpeakResult['via'];
  ms: number;
  textLength: number;
  /** sherpa 失败码（downloading / not_ready / engine_failed …） */
  code?: string;
  message?: string;
  audioBytes?: number;
}

export interface TtsRouterDeps {
  getConfig: () => TTSConfig;
  sherpa: SherpaSpeaker;
  fish: FishSpeaker;
  onSherpaFailure?: (err: unknown) => void;
  /** 每条请求结束时调用一次（成功 / 回退 / 异常） */
  onOutcome?: (o: TtsSpeakOutcome) => void;
  /** 单次请求总超时（默认 90s）：超时静默，避免 IPC 永久挂起 */
  speakTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_SPEAK_TIMEOUT_MS = 90_000;
const SHERPA_SPEED_MIN = 0.5;
const SHERPA_SPEED_MAX = 1.5;

function normalizeSherpaSpeed(value: number | undefined, fallback: number): number {
  const speed = Number.isFinite(value) ? value! : fallback;
  return Math.min(SHERPA_SPEED_MAX, Math.max(SHERPA_SPEED_MIN, speed));
}

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
      const result = await Promise.race([
        this.route(req, (c) => {
          lastCode = c;
        }),
        timeout,
      ]);
      report(result);
      return result;
    } catch (err) {
      report(null, err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async route(
    req: TTSSpeakRequest,
    noteCode: (code: string | undefined) => void,
  ): Promise<TTSSpeakResult> {
    const text = req.text?.trim();
    if (!text) return silent('empty text');

    const cfg = this.deps.getConfig();
    switch (selectEngine(cfg)) {
      case 'sherpa':
        return this.speakSherpa(text, cfg, noteCode, req.speed);
      case 'fish':
        return this.speakFishThenSherpa(req, text, cfg, noteCode);
      case 'legacy':
        return {
          success: false,
          via: 'legacy',
          fallbackToSystem: false,
          message: 'use legacy player',
        };
      default:
        return silent(cfg.enabled ? 'unsupported TTS provider' : 'tts disabled');
    }
  }

  /** Fish first; on failure try offline sherpa so old fish-local configs still have voice. */
  private async speakFishThenSherpa(
    req: TTSSpeakRequest,
    text: string,
    cfg: TTSConfig,
    noteCode: (code: string | undefined) => void,
  ): Promise<TTSSpeakResult> {
    const fishResult = await this.deps.fish.speak({ ...req, text });
    if (fishResult.success) return fishResult;
    const sherpaResult = await this.speakSherpa(text, cfg, noteCode, req.speed);
    if (sherpaResult.success) return sherpaResult;
    // Prefer Fish's message (e.g. unreachable) when both fail, while remaining silent.
    if (fishResult.fallbackToSystem || sherpaResult.fallbackToSystem) {
      return silent(fishResult.message || sherpaResult.message || 'fish and sherpa failed');
    }
    return fishResult;
  }

  private async speakSherpa(
    text: string,
    cfg: TTSConfig,
    noteCode: (code: string | undefined) => void,
    speed?: number,
  ): Promise<TTSSpeakResult> {
    try {
      const out = await this.deps.sherpa.synthesize(text, {
        sid: cfg.sherpaSid,
        speed: normalizeSherpaSpeed(speed, cfg.sherpaSpeed ?? 1),
      });
      return {
        success: true,
        via: 'sherpa',
        audioBase64: out.wav.toString('base64'),
        mimeType: 'audio/wav',
        fallbackToSystem: false,
      };
    } catch (err) {
      this.deps.onSherpaFailure?.(err);
      const code = (err as { code?: string } | null)?.code;
      noteCode(code);
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'superseded') {
        // 被更新的请求取代：渲染进程已丢弃该次结果，不需要产生音频
        return { success: false, via: 'none', fallbackToSystem: false, message };
      }
      return silent(message);
    }
  }
}
