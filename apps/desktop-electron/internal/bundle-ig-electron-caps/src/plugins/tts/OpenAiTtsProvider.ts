import type {
  TtsChunk,
  TtsOptions,
  TtsProvider,
  TtsProviderInfo,
  TtsResult,
  TtsVoice,
} from '../../seams/tts';

/**
 * OpenAI TTS：`POST /v1/audio/speech`。
 * P3-6 真实实现时：
 *   - key 走 ctx.keyStore.get('openai')
 *   - 请求 stream_format: 'chunked'，边收边分片计算 rms
 */
export class OpenAiTtsProvider implements TtsProvider {
  readonly info: TtsProviderInfo = {
    id: 'openai-tts',
    name: 'OpenAI TTS',
    streaming: true,
    requiresApiKey: true,
  };

  async synth(_text: string, _opts?: TtsOptions): Promise<TtsResult> {
    throw new Error('[OpenAiTtsProvider] not implemented (P3-6 TODO)');
  }

  async *stream(_text: string, _opts?: TtsOptions): AsyncIterable<TtsChunk> {
    yield await Promise.reject(new Error('[OpenAiTtsProvider] not implemented (P3-6 TODO)'));
  }

  stop(_reqId: string): void {
    /* no-op in skeleton */
  }

  async listVoices(): Promise<TtsVoice[]> {
    return [];
  }
}
