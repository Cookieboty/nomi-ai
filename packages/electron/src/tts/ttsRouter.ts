/**
 * TTS 路由（纯逻辑，无 electron 依赖，便于单测）：
 *   none（默认）→ 不合成，AI 回复只出文字
 *   edge / azure / openai → 尚未实现，静默
 * 失败 / 超时一律静默，没有系统朗读兜底。
 */
import type { TTSConfig, TTSSpeakRequest, TTSSpeakResult } from '@nomi-ai/types';

/**
 * CD_TTS=off（e2e）：不调用任何实时朗读引擎，tts:speak 直接静默。
 */
export function applyTtsEnvOverride<T extends Pick<TTSConfig, 'enabled'>>(
  cfg: T,
  env: Record<string, string | undefined> = process.env,
): T {
  return env.CD_TTS === 'off' ? { ...cfg, enabled: false } : cfg;
}

/** 每条 tts:speak 请求的结果摘要，供主进程打日志 */
export interface TtsSpeakOutcome {
  outcome: 'success' | 'fallback' | 'error';
  provider: string;
  via: TTSSpeakResult['via'];
  ms: number;
  textLength: number;
  message?: string;
}

export interface TtsRouterDeps {
  getConfig: () => TTSConfig;
  onOutcome?: (o: TtsSpeakOutcome) => void;
  now?: () => number;
}

const silent = (message: string): TTSSpeakResult => ({ success: false, via: 'none', message });

export class TtsRouter {
  constructor(private readonly deps: TtsRouterDeps) {}

  async speak(req: TTSSpeakRequest): Promise<TTSSpeakResult> {
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    let provider = 'unknown';
    let result: TTSSpeakResult;
    let error: unknown;
    try {
      const cfg = this.deps.getConfig();
      provider = cfg.provider;
      result = this.route(req, cfg);
    } catch (err) {
      error = err;
      result = silent(err instanceof Error ? err.message : String(err));
    }
    try {
      this.deps.onOutcome?.({
        outcome: error ? 'error' : result.success ? 'success' : 'fallback',
        provider,
        via: result.via ?? 'none',
        ms: now() - t0,
        textLength: req?.text?.length ?? 0,
        message: result.message,
      });
    } catch {
      /* 日志回调不得影响结果 */
    }
    return result;
  }

  private route(req: TTSSpeakRequest, cfg: TTSConfig): TTSSpeakResult {
    if (!req?.text?.trim()) return silent('empty text');
    if (!cfg.enabled) return silent('tts disabled');
    if (cfg.provider === 'none') return silent('no realtime TTS engine');
    return silent(`${cfg.provider} TTS is not implemented yet`);
  }
}
