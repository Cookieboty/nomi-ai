/**
 * 配置相关IPC处理器
 * 处理应用配置、模型配置等相关的IPC通信
 */

import type { HostPorts } from '@nomi-ai/host-ports';
import {
  type TTSConfig,
  type TTSPreviewRequest,
  type TTSSpeakRequest,
  type TTSSpeakResult,
} from '@nomi-ai/types';

import { t } from '../../i18n';
import { type IConfigService } from '../../services/ConfigService';
import { type ILoggerService } from '../../services/LoggerService';
import { initTtsService } from '../../tts/TtsService';

import { BaseIpcHandler } from './BaseIpcHandler';

/** 应用信息与 userData 路径来自宿主端口 */
export type ConfigIpcPorts = Pick<HostPorts, 'paths' | 'app'>;

export class ConfigIpcHandler extends BaseIpcHandler {
  private configService: IConfigService;
  private readonly ports: ConfigIpcPorts;

  constructor(logger: ILoggerService, configService: IConfigService, ports: ConfigIpcPorts) {
    super(logger);
    this.configService = configService;
    this.ports = ports;
  }

  /**
   * 初始化配置相关IPC处理器
   */
  initialize(): void {
    // 获取完整配置
    this.registerHandler('get-config', async () => {
      const config = this.configService.getConfig();
      this.logger.debug('获取配置', { config });
      return config;
    });

    // 更新配置
    this.registerHandler('update-config', async (_, updates) => {
      this.validateArgs([updates], 1, ['object']);

      try {
        this.configService.updateConfig(updates);
        await this.configService.save();
        this.logger.info('配置更新成功', { updates });
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('配置更新失败', {
          error: error instanceof Error ? error.message : String(error),
          updates,
        });
        return this.createErrorResponse(error);
      }
    });

    // 重新加载配置
    this.registerHandler('reload-config', async () => {
      try {
        await this.configService.reload();
        this.logger.info('配置重新加载成功');
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('配置重新加载失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 保存当前模型
    this.registerListener('save-model', (_, modelName: string) => {
      this.validateArgs([modelName], 1, ['string']);

      try {
        this.configService.set('modelName', modelName);
        this.configService.save().catch((error) => {
          this.logger.error('保存模型配置失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.logger.info('模型配置已保存', { modelName });
      } catch (error) {
        this.logger.error('保存模型配置失败', {
          error: error instanceof Error ? error.message : String(error),
          modelName,
        });
      }
    });

    // 获取保存的模型
    this.registerHandler('get-saved-model', async () => {
      const modelName = this.configService.get('modelName', '');
      this.logger.debug('获取保存的模型', { modelName });
      return modelName;
    });

    // 获取语音设置 - 已移至VoiceIpcHandler

    // 保存语音设置：由 VoiceIpcHandler 统一注册（同名通道只能有一个所有者）

    // 旧版本的显示模式（Live2D / 自定义图片）已移除：清理用户磁盘上持久化的 displayMode
    this.migrateLegacyDisplayMode();

    // 获取应用信息
    this.registerHandler('get-app-info', async () => {
      const appInfo = {
        version: this.ports.app.version(),
        name: this.ports.app.name(),
        userDataPath: this.ports.paths.userData(),
        isPackaged: this.ports.app.isPackaged(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
      };

      this.logger.debug('获取应用信息', { appInfo });
      return appInfo;
    });

    // 重置配置为默认值
    this.registerHandler('reset-config', async () => {
      try {
        this.configService.reset();
        await this.configService.save();
        this.logger.info('配置已重置为默认值');
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('重置配置失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 备份配置
    this.registerHandler('backup-config', async () => {
      try {
        const backupPath = await this.configService.backup();
        this.logger.info('配置备份成功', { backupPath });
        return this.createSuccessResponse(backupPath);
      } catch (error) {
        this.logger.error('配置备份失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 验证配置
    this.registerHandler('validate-config', async (_, config?: any) => {
      try {
        const targetConfig = config || this.configService.getConfig();
        const validation = this.configService.validateConfig(targetConfig);

        this.logger.debug('配置验证结果', { validation });
        return validation;
      } catch (error) {
        this.logger.error('配置验证失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          isValid: false,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    });

    // 获取配置文件路径
    this.registerHandler('get-config-path', async () => {
      const configPath = this.ports.paths.userData() + '/config.json';
      this.logger.debug('获取配置文件路径', { configPath });
      return configPath;
    });

    // 导出配置
    this.registerHandler('export-config', async () => {
      try {
        const config = this.configService.getConfig();
        const exportData = {
          config,
          timestamp: new Date().toISOString(),
          appVersion: this.ports.app.version(),
        };

        this.logger.info('配置导出成功');
        return this.createSuccessResponse(exportData);
      } catch (error) {
        this.logger.error('配置导出失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 导入配置
    this.registerHandler('import-config', async (_, importData: any) => {
      this.validateArgs([importData], 1, ['object']);

      try {
        if (!importData.config) {
          throw new Error(t('electron.common.invalid-import-data-missing-config-field'));
        }

        // 验证导入的配置
        const validation = this.configService.validateConfig(importData.config);
        if (!validation.isValid) {
          throw new Error(
            t('electron.common.config-validation-failed', validation.errors.join(', ')),
          );
        }

        // 更新配置
        this.configService.updateConfig(importData.config);
        await this.configService.save();

        this.logger.info('配置导入成功', { timestamp: importData.timestamp });
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('配置导入失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // TTS配置相关处理器
    this.initializeTTSHandlers();

    this.logger.info('ConfigIpcHandler 初始化完成', {
      registeredChannels: this.getRegisteredChannels().length,
    });
  }

  /**
   * 初始化TTS配置相关IPC处理器。逻辑在 tts/TtsService.ts（与契约 `tts.*` 共用同一个实例）；
   * 这里只保留旧通道（e2e-headed 与旧 preload 仍在用，P1b 收尾批次删除）。
   */
  private initializeTTSHandlers(): void {
    const tts = initTtsService({ paths: this.ports.paths, logger: this.logger });

    this.registerHandler('getTTSConfig', async () => tts.getConfig());

    this.registerHandler('saveTTSConfig', async (_, config: TTSConfig) => {
      this.validateArgs([config], 1, ['object']);
      try {
        tts.saveConfig(config);
        return this.createSuccessResponse();
      } catch (error) {
        return this.createErrorResponse(error);
      }
    });

    this.registerHandler('testTTSConnection', async (_, config: TTSConfig) => {
      this.validateArgs([config], 1, ['object']);
      return tts.testConnection(config);
    });

    this.registerHandler(
      'tts:preview',
      async (_, req: TTSPreviewRequest): Promise<TTSSpeakResult> => {
        this.validateArgs([req], 1, ['object']);
        return tts.preview(req);
      },
    );

    this.registerHandler('tts:voices', async () => tts.voices());

    this.registerHandler('tts:status', async () => tts.status());

    this.registerHandler('tts:stop', async () => tts.stop());

    this.registerHandler('resetTTSConfig', async () => {
      try {
        tts.resetConfig();
        return this.createSuccessResponse();
      } catch (error) {
        return this.createErrorResponse(error);
      }
    });

    this.registerHandler('tts:speak', async (_, req: TTSSpeakRequest) => {
      this.validateArgs([req], 1, ['object']);
      return tts.speak(req);
    });

    this.registerHandler('tts:reply', async (_, msg: unknown) => tts.reply(msg));

    this.registerHandler('tts:prompt-voice', async () => tts.promptVoice());

    this.registerHandler('tts:health', async (_, config?: Partial<TTSConfig>) =>
      tts.health(config),
    );
  }

  /** 旧版 displayMode（'live2d' / 'custom-image'）不再使用：读取到就删掉，避免残留配置。 */
  private migrateLegacyDisplayMode(): void {
    try {
      const legacy = this.configService.get<unknown>('displayMode', undefined);
      if (legacy !== undefined) {
        this.configService.set('displayMode', undefined);
        void this.configService.save();
        this.logger.info('已迁移旧的显示模式配置到 3D Nomi', { legacy });
      }
    } catch (error) {
      this.logger.warn('迁移旧显示模式配置失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
