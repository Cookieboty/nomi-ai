import type {
  AsrOptions,
  AsrProvider,
  AsrProviderInfo,
  AsrResult,
  AsrStreamEvent,
  PcmChunk,
} from '../../seams/asr';

/**
 * OpenAI whisper-1 / gpt-4o-transcribe（`POST /v1/audio/transcriptions`）。
 * P3-5 真实实现时：
 *   - 走 https://api.openai.com/v1/audio/transcriptions
 *   - 认证：Authorization: Bearer <ctx.keyStore.get('openai')>
 *   - 请求：multipart/form-data，file 字段传 wav
 */
export class OpenAIWhisperProvider implements AsrProvider {
  readonly info: AsrProviderInfo = {
    id: 'openai-whisper',
    name: 'OpenAI Whisper',
    streaming: false,
    requiresApiKey: true,
    supportedLanguages: ['auto', 'zh', 'en', 'ja', 'ko'],
  };

  async transcribe(_pcm: PcmChunk, _opts?: AsrOptions): Promise<AsrResult> {
    throw new Error('[OpenAIWhisperProvider] not implemented (P3-5 TODO)');
  }

  async *stream(
    _pcmStream: AsyncIterable<PcmChunk>,
    _opts?: AsrOptions,
  ): AsyncIterable<AsrStreamEvent> {
    yield { type: 'error', error: '[OpenAIWhisperProvider] not implemented (P3-5 TODO)' };
  }
}
