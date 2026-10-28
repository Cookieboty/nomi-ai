/**
 * 看板娘的旧语音设置（config.json 的 `voiceSettings`：音量、整点报时、音效开关…）。
 *
 * 契约 `voice.getMascotSettings` / `voice.saveMascotSettings`（host/contract/media.ts）用。
 */
import type { VoiceSettings } from '@nomi-ai/types';

import type { IConfigService } from '../services/ConfigService';

type ConfigLike = Pick<IConfigService, 'get' | 'set' | 'save'>;

interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function getMascotVoiceSettings(
  config: ConfigLike,
  logger?: Pick<Logger, 'debug'>,
): VoiceSettings | undefined {
  const voiceSettings = config.get<VoiceSettings | undefined>('voiceSettings');
  logger?.debug('获取语音设置', { voiceSettings });
  return voiceSettings;
}

/** 与当前设置合并后保存（落盘失败只记日志，与旧的 send 通道一致：调用方不等结果） */
export function saveMascotVoiceSettings(
  config: ConfigLike,
  settings: Partial<VoiceSettings>,
  logger: Pick<Logger, 'info' | 'error'>,
): void {
  try {
    const currentSettings = config.get<Partial<VoiceSettings> | undefined>('voiceSettings') || {};
    const updatedSettings = { ...currentSettings, ...settings };

    config.set('voiceSettings', updatedSettings);
    config.save().catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('保存语音设置失败', { error: errorMessage });
    });

    logger.info('语音设置已保存', { settings: updatedSettings });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('保存语音设置失败', { error: errorMessage, settings });
  }
}
