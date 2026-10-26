/**
 * TTS 路由（纯逻辑，无 electron 依赖，便于单测）：
 *   edge（默认）→ 微软 Edge 在线朗读（需联网）
 *   none → 不合成，只出文字
 *   azure / openai → 尚未实现，静默
 * 失败 / 超时 / 离线一律静默（渲染层只显示文字），没有系统朗读兜底。
 */
import type { TTSConfig, TTSSpeakRequest, TTSSpeakResult } from '@nomi-ai/types';

import type { EdgeSpeakFail, EdgeSpeakOk, EdgeSpeakParams } from './edge/EdgeTtsService';

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

export interface TtsEdgeEngine {
  speak(p: EdgeSpeakParams): Promise<EdgeSpeakOk | EdgeSpeakFail>;
}

export interface TtsRouterDeps {
  getConfig: () => TTSConfig;
  edge?: TtsEdgeEngine;
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
      result = await this.route(req, cfg);
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

  private async route(req: TTSSpeakRequest, cfg: TTSConfig): Promise<TTSSpeakResult> {
    if (!req?.text?.trim()) return silent('empty text');
    if (!cfg.enabled) return silent('tts disabled');
    if (cfg.provider === 'none') return silent('no realtime TTS engine');
    if (cfg.provider === 'edge' && this.deps.edge) {
      const r = await this.deps.edge.speak({
        text: req.text,
        voice: cfg.edgeVoice,
        rate: cfg.rate,
      });
      if (!r.ok) return silent(`edge: ${r.kind}`);
      return {
        success: true,
        audioBase64: r.audio.toString('base64'),
        mimeType: 'audio/mpeg',
        via: 'edge',
      };
    }
    return silent(`${cfg.provider} TTS is not implemented yet`);
  }
}
