import type {
  TtsChunk,
  TtsOptions,
  TtsProvider,
  TtsProviderInfo,
  TtsResult,
  TtsVoice,
} from '../../seams/tts';

/**
 * Azure Cognitive Services Speech：REST /cognitiveservices/v1（SSML in / audio out）。
 * P3-6 真实实现时：
 *   - key 走 ctx.keyStore.get('azure-speech')
 *   - Header：Ocp-Apim-Subscription-Key、X-Microsoft-OutputFormat
 */
export class AzureTtsProvider implements TtsProvider {
  readonly info: TtsProviderInfo = {
    id: 'azure-tts',
    name: 'Azure Speech TTS',
    streaming: true,
    requiresApiKey: true,
  };

  async synth(_text: string, _opts?: TtsOptions): Promise<TtsResult> {
    throw new Error('[AzureTtsProvider] not implemented (P3-6 TODO)');
  }

  async *stream(_text: string, _opts?: TtsOptions): AsyncIterable<TtsChunk> {
    yield await Promise.reject(new Error('[AzureTtsProvider] not implemented (P3-6 TODO)'));
  }

  stop(_reqId: string): void {
    /* no-op in skeleton */
  }

  async listVoices(): Promise<TtsVoice[]> {
    return [];
  }
}
