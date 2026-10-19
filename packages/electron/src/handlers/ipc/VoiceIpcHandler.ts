/**
 * 语音相关 IPC 处理器（设置存取、播放/测试等）。
 * 全局按键监听彩蛋已移除，不再启动 node-global-key-listener。
 */

import { eventBus } from '../../core/EventBus';
import { t } from '../../i18n';
import { type IConfigService } from '../../services/ConfigService';
import { type ILoggerService } from '../../services/LoggerService';

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
    // 获取语音设置
    this.registerHandler('get-voice-settings', async () => {
      const voiceSettings = this.configService.get('voiceSettings');
      this.logger.debug('获取语音设置', { voiceSettings });
      return voiceSettings;
    });

    // 保存语音设置
    this.registerListener('save-voice-settings', (_, settings) => {
      this.validateArgs([settings], 1, ['object']);

      try {
        const currentSettings = this.configService.get('voiceSettings') || {};
        const updatedSettings = { ...currentSettings, ...settings };
        const prevEnabled = Boolean((currentSettings as { enabled?: boolean }).enabled);

        this.configService.set('voiceSettings', updatedSettings);
        this.configService.save().catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error('保存语音设置失败', { error: errorMessage });
        });

        this.logger.info('语音设置已保存', { settings: updatedSettings });
        // 开关变化交给 TtsModelController：开启时按需下载模型，失败 / 取消则关回去
        if (typeof settings.enabled === 'boolean' && settings.enabled !== prevEnabled) {
          eventBus.emit('voice:enabled-changed', { enabled: settings.enabled });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('保存语音设置失败', { error: errorMessage, settings });
      }
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
          { id: 'voice1', name: t('标准女声'), language: 'zh-CN' },
          { id: 'voice2', name: t('标准男声'), language: 'zh-CN' },
          { id: 'voice3', name: t('英文女声'), language: 'en-US' },
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
          throw new Error(t('音量值必须在0-1之间'));
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
          throw new Error(t('无效的语音模式: {0}，支持的模式: {1}', mode, validModes.join(', ')));
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
