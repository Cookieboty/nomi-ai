import type {
  TtsChunk,
  TtsOptions,
  TtsProvider,
  TtsProviderInfo,
  TtsResult,
  TtsVoice,
} from '../../seams/tts';

/**
 * 微软 Edge Read Aloud 免费 TTS（wss://speech.platform.bing.com）。
 * P3-6 真实实现时：
 *   - 走 WebSocket 双工，SSML 请求
 *   - 分块 audio/mpeg → 计算 rms → yield TtsChunk
 */
export class EdgeTtsProvider implements TtsProvider {
  readonly info: TtsProviderInfo = {
    id: 'edge-tts',
    name: 'Edge TTS',
    streaming: true,
    requiresApiKey: false,
  };

  async synth(_text: string, _opts?: TtsOptions): Promise<TtsResult> {
    throw new Error('[EdgeTtsProvider] not implemented (P3-6 TODO)');
  }

  async *stream(_text: string, _opts?: TtsOptions): AsyncIterable<TtsChunk> {
    yield await Promise.reject(new Error('[EdgeTtsProvider] not implemented (P3-6 TODO)'));
  }

  stop(_reqId: string): void {
    /* no-op in skeleton */
  }

  async listVoices(): Promise<TtsVoice[]> {
    return [];
  }
}
