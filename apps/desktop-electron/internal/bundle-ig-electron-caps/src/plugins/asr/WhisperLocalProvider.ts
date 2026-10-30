import type {
  AsrOptions,
  AsrProvider,
  AsrProviderInfo,
  AsrResult,
  AsrStreamEvent,
  PcmChunk,
} from '../../seams/asr';

/**
 * 本地 whisper.cpp 绑定（nodejs-whisper）骨架。
 * P3-5 真实实现时：
 *   - 首启动向导下载模型到 models/whisper/
 *   - transcribe: 将 pcm 转 wav（内存）→ 送 whisper → 拿 text
 *   - stream: VAD 切片 → 顺序 transcribe → yield partial/final
 */
export class WhisperLocalProvider implements AsrProvider {
  readonly info: AsrProviderInfo = {
    id: 'whisper-local',
    name: 'Whisper (Local)',
    streaming: false,
    requiresApiKey: false,
    supportedLanguages: ['auto', 'zh', 'en', 'ja'],
  };

  async transcribe(_pcm: PcmChunk, _opts?: AsrOptions): Promise<AsrResult> {
    throw new Error('[WhisperLocalProvider] not implemented (P3-5 TODO)');
  }

  async *stream(
    _pcmStream: AsyncIterable<PcmChunk>,
    _opts?: AsrOptions,
  ): AsyncIterable<AsrStreamEvent> {
    yield { type: 'error', error: '[WhisperLocalProvider] not implemented (P3-5 TODO)' };
  }
}
