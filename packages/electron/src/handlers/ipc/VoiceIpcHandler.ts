/**
 * 语音相关 IPC 处理器（设置存取、播放/测试等）。
 * 全局按键监听彩蛋已移除，不再启动 node-global-key-listener。
 */

import { t } from '../../i18n';
import { type IConfigService } from '../../services/ConfigService';
import { type ILoggerService } from '../../services/LoggerService';
import { getMascotVoiceSettings, saveMascotVoiceSettings } from '../../voice/mascotVoiceSettings';

import { BaseIpcHandler } from './BaseIpcHandler';

export class VoiceIpcHandler extends BaseIpcHandler {
  private configService: IConfigService;

  constructor(logger: ILoggerService, configService: IConfigService) {
    super(logger);
    this.configService = configService;
  }

  /**
   * 初始化语音相关IPC处理器
   */
  initialize(): void {
    // 获取语音设置（逻辑在 voice/mascotVoiceSettings.ts，与契约 voice.getMascotSettings 共用）
    this.registerHandler('get-voice-settings', async () =>
      getMascotVoiceSettings(this.configService, this.logger),
    );

    // 保存语音设置
    this.registerListener('save-voice-settings', (_, settings) => {
      this.validateArgs([settings], 1, ['object']);
      saveMascotVoiceSettings(this.configService, settings, this.logger);
    });

    // 播放语音（模拟）
    this.registerHandler('play-voice', async (_, voiceConfig: any) => {
      this.validateArgs([voiceConfig], 1, ['object']);

      try {
        const { text, voice, speed = 1.0, volume = 1.0 } = voiceConfig;

        this.logger.info('播放语音', { text, voice, speed, volume });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        this.logger.info('语音播放完成');
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('语音播放失败', { error: errorMessage, voiceConfig });
        return this.createErrorResponse(error);
      }
    });

    // 获取可用语音列表
    this.registerHandler('get-available-voices', async () => {
      try {
        const voices = [
          { id: 'voice1', name: t('electron.common.standard-female-voice'), language: 'zh-CN' },
          { id: 'voice2', name: t('electron.common.standard-male-voice'), language: 'zh-CN' },
          { id: 'voice3', name: t('electron.common.english-female-voice'), language: 'en-US' },
        ];

        this.logger.debug('获取可用语音列表', { voices });
        return voices;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('获取可用语音列表失败', { error: errorMessage });
        return [];
      }
    });

    // 测试语音播放
    this.registerHandler('test-voice', async (_, voiceId: string) => {
      this.validateArgs([voiceId], 1, ['string']);

      try {
        this.logger.info('测试语音播放', { voiceId });

        await new Promise((resolve) => setTimeout(resolve, 500));

        this.logger.info('语音测试完成');
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('语音测试失败', { error: errorMessage, voiceId });
        return this.createErrorResponse(error);
      }
    });

    // 设置语音音量
    this.registerHandler('set-voice-volume', async (_, volume: number) => {
      this.validateArgs([volume], 1, ['number']);

      try {
        if (volume < 0 || volume > 1) {
          throw new Error(t('electron.common.volume-must-be-between-0-and-1'));
        }

        this.configService.set('voiceSettings.volume', volume);
        await this.configService.save();

        this.logger.info('语音音量已设置', { volume });
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('设置语音音量失败', { error: errorMessage, volume });
        return this.createErrorResponse(error);
      }
    });

    // 切换语音模式
    this.registerHandler('set-voice-mode', async (_, mode: string) => {
      this.validateArgs([mode], 1, ['string']);

      try {
        const validModes = ['fixed', 'tts', 'mixed'];
        if (!validModes.includes(mode)) {
          throw new Error(
            t('electron.common.invalid-voice-mode-supported-modes', mode, validModes.join(', ')),
          );
        }

        this.configService.set('voiceSettings.voiceMode', mode);
        await this.configService.save();

        this.logger.info('语音模式已设置', { mode });
        return this.createSuccessResponse();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('设置语音模式失败', { error: errorMessage, mode });
        return this.createErrorResponse(error);
      }
    });

    this.logger.info('VoiceIpcHandler 初始化完成', {
      registeredChannels: this.getRegisteredChannels().length,
    });
  }

  cleanup(): void {
    super.cleanup();
  }
}
