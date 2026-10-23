/**
 * 配置服务 - 统一管理应用配置
 * 支持多环境配置、配置验证和热更新
 */

import * as fs from 'fs';
import * as path from 'path';

import { app } from 'electron';

import { t } from '../i18n';
import { DEFAULT_MASCOT_SCALE, migrateMascotSize } from '../mascot/mascotSize';
import { writePrivateFileAtomic } from '../utils/privateFile';

import { type ILoggerService } from './LoggerService';

export interface VoiceSettings {
  enabled: boolean;
  volume: number;
  timeAnnouncement: boolean;
  voicePackPath: string;
  voiceMode: 'fixed' | 'tts' | 'mixed';
  /** 看板娘动作音效，默认 true */
  sfxEnabled?: boolean;
}

export interface WindowSettings {
  position: { x: number; y: number };
  alwaysOnTop: boolean;
  transparent: boolean;
}

export interface AppConfig {
  windowPosition: { x: number; y: number };
  /** 对话窗口（主界面）上次关闭时的位置与大小（见 core/chatWindowBounds.ts）；没有时居中默认尺寸 */
  chatWindowBounds?: { x: number; y: number; width: number; height: number; maximized?: boolean };
  /** mascot on-screen size relative to the original 420×450 (default 0.5, see mascotSize.ts) */
  mascotScale: number;
  modelName: string;
  voiceSettings: VoiceSettings;
  window: WindowSettings;
  debug: boolean;
  environment: 'development' | 'production';
}

export interface IConfigService {
  load(): Promise<void>;
  get<T>(key: string, defaultValue?: T): T;
  set(key: string, value: any): void;
  save(): Promise<void>;
  getConfig(): AppConfig;
  updateConfig(updates: Partial<AppConfig>): void;
  reload(): Promise<void>;
  reset(): void;
  backup(): Promise<string>;
  validateConfig(config: any): { isValid: boolean; errors: string[]; warnings: string[] };
}

export class ConfigService implements IConfigService {
  private config: AppConfig;
  private configPath: string;
  private logger?: ILoggerService;
  private defaultConfig: AppConfig;

  constructor(logger?: ILoggerService) {
    this.logger = logger;
    this.configPath = path.join(app.getPath('userData'), 'config.json');

    // 默认配置
    this.defaultConfig = {
      windowPosition: { x: 0, y: 0 },
      mascotScale: DEFAULT_MASCOT_SCALE,
      modelName: '',
      voiceSettings: {
        // 新安装默认关闭：离线 TTS 模型不再随安装包分发，开启时才下载（docs/design/tts-on-demand.md）。
        // 老用户 config.json 里已保存 enabled=true，会保持开启并在启动时自动下载模型。
        enabled: false,
        volume: 0.8,
        timeAnnouncement: true,
        voicePackPath: 'packages/renderer/public/assets/voice',
        voiceMode: 'fixed',
        sfxEnabled: true,
      },
      window: {
        position: { x: 0, y: 0 },
        alwaysOnTop: true,
        transparent: true,
      },
      debug: false,
      environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    };

    this.config = { ...this.defaultConfig };
  }

  /**
   * 加载配置
   */
  async load(): Promise<void> {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const loadedConfig = JSON.parse(configData);

        // 合并默认配置和加载的配置
        this.config = this.mergeConfigs(this.defaultConfig, loadedConfig);
        // mascotScale 之前的配置：迁移到新的半尺寸默认值，并保持角色底部中心位置
        const mig = migrateMascotSize(loadedConfig);
        this.config.mascotScale = mig.mascotScale;
        if (mig.windowPosition) this.config.windowPosition = mig.windowPosition;
        if (mig.migrated) {
          this.logger?.info('mascot size migrated to half-size default', mig);
          await this.save();
        }

        this.logger?.info('配置加载成功', { path: this.configPath });
      } else {
        this.logger?.info('配置文件不存在，使用默认配置');
        await this.save(); // 创建默认配置文件
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('配置加载失败', { error: errorMessage, path: this.configPath });
      this.config = { ...this.defaultConfig };
    }
  }

  /**
   * 获取配置值
   */
  get<T>(key: string, defaultValue?: T): T {
    const keys = key.split('.');
    let value: any = this.config;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue as T;
      }
    }

    return value as T;
  }

  /**
   * 设置配置值
   */
  set(key: string, value: any): void {
    const keys = key.split('.');
    let target: any = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in target) || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }

    target[keys[keys.length - 1]] = value;
    this.logger?.debug('配置更新', { key, value });
  }

  /**
   * 保存配置
   */
  async save(): Promise<void> {
    try {
      const configData = JSON.stringify(this.config, null, 2);
      writePrivateFileAtomic(this.configPath, configData);
      this.logger?.debug('配置保存成功', { path: this.configPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('配置保存失败', { error: errorMessage, path: this.configPath });
      throw error;
    }
  }

  /**
   * 获取完整配置
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<AppConfig>): void {
    this.config = this.mergeConfigs(this.config, updates);
    this.logger?.info('配置已更新', { updates });
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<void> {
    await this.load();
    this.logger?.info('配置已重新加载');
  }

  /**
   * 合并配置对象
   */
  private mergeConfigs(base: any, override: any): any {
    const result = { ...base };

    for (const key in override) {
      if (Object.prototype.hasOwnProperty.call(override, key)) {
        if (
          typeof override[key] === 'object' &&
          override[key] !== null &&
          !Array.isArray(override[key])
        ) {
          result[key] = this.mergeConfigs(result[key] || {}, override[key]);
        } else {
          result[key] = override[key];
        }
      }
    }

    return result;
  }

  /**
   * 验证配置
   */
  validateConfig(config: any): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 基本类型检查
    if (typeof config !== 'object' || config === null) {
      errors.push(t('配置必须是一个对象'));
      return { isValid: false, errors, warnings };
    }

    // 验证窗口位置
    if (config.windowPosition) {
      if (
        typeof config.windowPosition.x !== 'number' ||
        typeof config.windowPosition.y !== 'number'
      ) {
        errors.push(t('窗口位置必须是数字'));
      }
    }

    // 验证语音设置
    if (config.voiceSettings) {
      const voice = config.voiceSettings;
      if (typeof voice.enabled !== 'boolean') {
        errors.push(t('语音设置enabled必须是布尔值'));
      }
      if (typeof voice.volume !== 'number' || voice.volume < 0 || voice.volume > 1) {
        errors.push(t('音量必须是0-1之间的数字'));
      }
      if (!['fixed', 'tts', 'mixed'].includes(voice.voiceMode)) {
        errors.push(t('语音模式必须是fixed、tts或mixed'));
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * 重置为默认配置
   */
  reset(): void {
    this.config = { ...this.defaultConfig };
    this.logger?.info('配置已重置为默认值');
  }

  /**
   * 备份当前配置
   */
  async backup(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(app.getPath('userData'), `config-backup-${timestamp}.json`);

    try {
      fs.copyFileSync(this.configPath, backupPath);
      try {
        fs.chmodSync(backupPath, 0o600);
      } catch {
        /* Windows 等平台忽略 */
      }
      this.logger?.info('配置备份成功', { backupPath });
      return backupPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('配置备份失败', { error: errorMessage });
      throw error;
    }
  }
}
