/**
 * 配置相关IPC处理器
 * 处理应用配置、模型配置等相关的IPC通信
 */

import http from 'http';
import https from 'https';

import {
  type SherpaModelStatus,
  type TTSConfig,
  type TTSSpeakRequest,
  type TTSTestResult,
} from '@nomi-ai/types';
import { app } from 'electron';

import { t } from '../../i18n';
import { type IConfigService } from '../../services/ConfigService';
import { type ILoggerService } from '../../services/LoggerService';
import { getFishTtsService } from '../../tts/fish';
import { validateTtsConfig } from '../../tts/fish/validateTtsConfig';
import { getSherpaTtsService } from '../../tts/sherpa';
import { TtsRouter, applyTtsEnvOverride } from '../../tts/ttsRouter';

import { BaseIpcHandler } from './BaseIpcHandler';

export class ConfigIpcHandler extends BaseIpcHandler {
  private configService: IConfigService;

  constructor(logger: ILoggerService, configService: IConfigService) {
    super(logger);
    this.configService = configService;
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

    // 旧版本的显示模式（Live2D / 自定义图片）已移除：清理持久化的 displayMode，统一为 3D 看板娘
    this.migrateLegacyDisplayMode();

    // 获取应用信息
    this.registerHandler('get-app-info', async () => {
      const appInfo = {
        version: app.getVersion(),
        name: app.getName(),
        userDataPath: app.getPath('userData'),
        isPackaged: app.isPackaged,
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
      const configPath = app.getPath('userData') + '/config.json';
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
          appVersion: app.getVersion(),
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
          throw new Error(t('导入数据格式错误，缺少config字段'));
        }

        // 验证导入的配置
        const validation = this.configService.validateConfig(importData.config);
        if (!validation.isValid) {
          throw new Error(t('配置验证失败: {0}', validation.errors.join(', ')));
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
   * 初始化TTS配置相关IPC处理器
   */
  private initializeTTSHandlers(): void {
    const fish = getFishTtsService();
    const sherpa = getSherpaTtsService();
    const router = new TtsRouter({
      getConfig: () => applyTtsEnvOverride(fish.getConfig()),
      sherpa,
      fish,
      onSherpaFailure: (error) => {
        const code = (error as { code?: string } | null)?.code;
        // downloading / superseded 属预期情形，由逐请求结果日志 + 服务内限频进度日志覆盖，避免刷屏
        if (code === 'downloading' || code === 'superseded') return;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('sherpa TTS 不可用，回退系统语音', { code, message });
      },
      // 每条 tts:speak 都必有一条结果日志：success / fallback / error + provider
      onOutcome: (o) => {
        const meta = {
          provider: o.provider,
          via: o.via,
          ms: o.ms,
          textLength: o.textLength,
          code: o.code,
          message: o.message,
          audioBytes: o.audioBytes,
        };
        if (o.outcome === 'success') this.logger.info('tts:speak success', meta);
        else if (o.outcome === 'fallback') this.logger.warn('tts:speak fallback', meta);
        else this.logger.error('tts:speak error', meta);
      },
    });

    // 获取TTS配置（无文件时返回内置 sherpa 离线默认，便于开箱走 sherpa 路径）
    this.registerHandler('getTTSConfig', async () => {
      try {
        const config = fish.getConfig();
        this.logger.debug('获取TTS配置成功', {
          provider: config.provider,
          enabled: config.enabled,
          hasApiKey: config.hasApiKey,
        });
        return config;
      } catch (error) {
        this.logger.error('获取TTS配置失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    });

    // 保存TTS配置（云 Key 走 safeStorage）
    this.registerHandler('saveTTSConfig', async (_, config: TTSConfig) => {
      this.validateArgs([config], 1, ['object']);

      try {
        const saved = fish.saveConfig(config);
        this.logger.info('TTS配置保存成功', {
          provider: saved.provider,
          enabled: saved.enabled,
          hasApiKey: saved.hasApiKey,
        });
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('TTS配置保存失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 测试连接：sherpa → 模型就绪 + 引擎可加载；Fish → /v1/health；legacy → 原 POST 探测
    this.registerHandler('testTTSConnection', async (_, config: TTSConfig) => {
      this.validateArgs([config], 1, ['object']);

      try {
        const startTime = Date.now();
        let result: TTSTestResult;
        if (config.provider === 'sherpa-theresa') {
          result = await this.checkSherpaHealth();
        } else if (config.provider === 'fish-local' || config.provider === 'fish-cloud') {
          result = await fish.checkHealth(config);
        } else if (config.provider === 'system') {
          result = { success: true, message: t('系统语音模式，无需连接 TTS 服务') };
        } else {
          result = await this.testLegacyTTSConnection(config);
        }
        const latency = result.latency ?? Date.now() - startTime;
        const testResult: TTSTestResult = { ...result, latency };
        this.logger.info('TTS连接测试完成', { testResult });
        return testResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('TTS连接测试失败', { error: errorMessage });
        return {
          success: false,
          message: t('连接测试失败: {0}', errorMessage),
        } as TTSTestResult;
      }
    });

    // 重置TTS配置
    this.registerHandler('resetTTSConfig', async () => {
      try {
        fish.resetConfig();
        this.logger.info('TTS配置已重置');
        return this.createSuccessResponse();
      } catch (error) {
        this.logger.error('重置TTS配置失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.createErrorResponse(error);
      }
    });

    // 合成路由：sherpa（默认）/ Fish（可选）；渲染层播放，失败则回退系统语音
    this.registerHandler('tts:speak', async (_, req: TTSSpeakRequest) => {
      this.validateArgs([req], 1, ['object']);
      try {
        // 结果日志（success / fallback / error）由 router.onOutcome 统一输出，这里不重复
        return await router.speak(req ?? { text: '' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          via: 'none',
          fallbackToSystem: true,
          message: errorMessage,
        };
      }
    });

    // sherpa 模型状态（bundled / env / 缺失）
    this.registerHandler('tts:sherpa:status', async (): Promise<SherpaModelStatus> => {
      return sherpa.getStatus();
    });

    this.registerHandler('tts:health', async (_, config?: Partial<TTSConfig>) => {
      try {
        if ((config?.provider ?? fish.getConfig().provider) === 'sherpa-theresa') {
          return await this.checkSherpaHealth();
        }
        return await fish.checkHealth(config);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, message: errorMessage } as TTSTestResult;
      }
    });

    // 遗留：测试 legacy 语音克隆播放
    this.registerHandler(
      'test-tts-voice',
      async (_, testConfig: TTSConfig & { testText: string }) => {
        this.validateArgs([testConfig], 1, ['object']);

        try {
          if (
            testConfig.provider === 'sherpa-theresa' ||
            testConfig.provider === 'fish-local' ||
            testConfig.provider === 'fish-cloud'
          ) {
            const spoken = await (testConfig.provider === 'sherpa-theresa' ? router : fish).speak({
              text: testConfig.testText,
              referenceId: testConfig.referenceId,
            });
            if (spoken.success) {
              return {
                success: true,
                message: t('语音测试成功'),
                audioBase64: spoken.audioBase64,
                mimeType: spoken.mimeType,
              };
            }
            throw new Error(spoken.message || t('TTS 合成失败'));
          }

          const validation = validateTtsConfig({
            ...testConfig,
            provider: testConfig.provider || 'legacy',
          });
          if (!validation.isValid) {
            throw new Error(t('TTS配置验证失败: {0}', validation.errors.join(', ')));
          }

          const { VoiceService } = await import('../../tts/legacy/LegacyTtsPlayer');
          const voiceService = new VoiceService();
          const { MCPConfigManager } = await import('../../tts/legacy/LegacyVoiceConfig');
          const configManager = MCPConfigManager.getInstance();
          const originalConfig = configManager.getVoiceConfig();

          try {
            configManager.updateVoiceMode('tts');
            if (configManager.getVoiceConfig().ttsApiConfig) {
              configManager.updateTTSApiConfig({
                hostname: testConfig.hostname,
                port: testConfig.port,
                path: testConfig.path,
                audioUrl: testConfig.audioUrl,
                promptText: testConfig.promptText,
              });
            } else {
              const newConfig = { ...configManager.getVoiceConfig() };
              newConfig.ttsApiConfig = {
                hostname: testConfig.hostname,
                port: testConfig.port,
                path: testConfig.path,
                audioUrl: testConfig.audioUrl,
                promptText: testConfig.promptText,
              };
              configManager.updateVoiceMode('tts');
            }

            await voiceService.playTextToSpeech(testConfig.testText);
            this.logger.info('TTS语音测试成功', { testText: testConfig.testText });
            return { success: true, message: t('语音测试成功') };
          } finally {
            configManager.updateVoiceMode(originalConfig.voiceMode);
            if (originalConfig.ttsApiConfig) {
              configManager.updateTTSApiConfig(originalConfig.ttsApiConfig);
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error('TTS语音测试失败', { error: errorMessage });
          return {
            success: false,
            message: t('语音测试失败: {0}', errorMessage),
          };
        }
      },
    );
  }

  /** sherpa：缺模型时会先自动下载，再预热引擎（开发态常见；打包包内已有模型则跳过下载） */
  private async checkSherpaHealth(): Promise<TTSTestResult> {
    const sherpa = getSherpaTtsService();
    try {
      const ms = await sherpa.warmup();
      const status = sherpa.getStatus();
      return {
        success: true,
        message: t('离线语音引擎就绪（模型位置：{0}）', status.source ?? ''),
        latency: ms,
      };
    } catch (error) {
      const status = sherpa.getStatus();
      const msg = error instanceof Error ? error.message : String(error);
      if (status.state === 'missing' || status.state === 'error') {
        return {
          success: false,
          message: status.message
            ? t('离线语音模型不可用: {0}', status.message)
            : t('离线语音模型缺失，当前使用系统语音'),
        };
      }
      return { success: false, message: t('离线语音引擎加载失败，将回退系统语音: {0}', msg) };
    }
  }

  /**
   * 验证TTS配置（委托纯函数，供遗留调用）
   */
  private validateTTSConfig(config: TTSConfig): { isValid: boolean; errors: string[] } {
    return validateTtsConfig(config);
  }

  /**
   * 遗留外部 TTS：POST 探测
   */
  private async testLegacyTTSConnection(config: TTSConfig): Promise<TTSTestResult> {
    return new Promise((resolve) => {
      const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      const protocol = loopbackHosts.has(config.hostname.trim().toLowerCase()) ? http : https;

      const testData = JSON.stringify({
        text: t('TTS连接测试'),
        ref_audio_path: config.audioUrl,
        prompt_text: (config.promptText || '').substring(0, 100),
      });

      const options = {
        hostname: config.hostname,
        port: config.port,
        path: config.path,
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(testData),
        },
      };

      const req = protocol.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve({
            success: true,
            message: t('连接成功，TTS服务可正常访问'),
          });
        } else {
          resolve({
            success: false,
            message: t('服务器返回状态码: {0}', res.statusCode),
          });
        }
      });

      req.on('error', (error) => {
        resolve({
          success: false,
          message: t('连接失败: {0}', error.message),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          message: t('连接超时'),
        });
      });

      req.write(testData);
      req.end();
    });
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
