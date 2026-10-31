/**
 * 配置服务 - 统一管理应用配置
 * 支持多环境配置、配置验证和热更新
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HostPorts } from '@nomi-ai/host-ports';

import { t } from '../i18n';
import { DEFAULT_MASCOT_SCALE, migrateMascotSize } from '../mascot/mascotSize';
import { writePrivateFileAtomic, writePrivateFileAtomicAsync } from '../utils/privateFile';

import { type ILoggerService } from './LoggerService';

export interface VoiceSettings {
  enabled: boolean;
  volume: number;
  timeAnnouncement: boolean;
  voicePackPath: string;
  voiceMode: 'fixed' | 'tts' | 'mixed';
  /** 桌面角色动作音效，默认 true */
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
  /** Windows：开机时自动启动（静默启动，只出现在托盘区），默认 false */
  openAtLogin?: boolean;
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
  /** 配置被 set / updateConfig 修改时的订阅；返回取消订阅函数 */
  onChange(listener: (config: AppConfig) => void): () => void;
}

export interface ConfigServiceDeps {
  /** 只用到 paths.userData（config.json 与备份都在 userData 根） */
  ports: Pick<HostPorts, 'paths'>;
  logger?: ILoggerService;
}

export class ConfigService implements IConfigService {
  private config: AppConfig;
  private configPath: string;
  private readonly userData: string;
  private logger?: ILoggerService;
  private defaultConfig: AppConfig;
  /**
   * 写盘队列（最后一次写赢）：同一时刻最多一个写入在跑（inflight）、一个在排队（queued）。
   * 运行中再 save() 的合并到排队的那一次，排队的那次开始时才序列化当时最新的配置，
   * 所以旧内容不会在新内容之后落盘，窗口拖动 / 缩放的连续保存也不会堆积。
   */
  private inflight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  /** 配置被 set / updateConfig 修改时的回调列表（宿主用于同步系统级设置，如开机自启动） */
  private readonly changeListeners: Array<(config: AppConfig) => void> = [];

  /** 订阅配置变更；返回取消订阅函数 */
  onChange(listener: (config: AppConfig) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    };
  }

  private notifyChange(): void {
    const cfg = this.getConfig();
    for (const fn of this.changeListeners) {
      try {
        fn(cfg);
      } catch {
        /* 回调错误不影响主流程 */
      }
    }
  }

  constructor(deps: ConfigServiceDeps) {
    this.logger = deps.logger;
    this.userData = deps.ports.paths.userData();
    this.configPath = path.join(this.userData, 'config.json');

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
    // reload 时先等还没落盘的保存写完，免得读到旧文件
    await this.whenIdle();
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
    this.notifyChange();
  }

  /**
   * 保存配置（异步原子写）。窗口移动 / 缩放防抖后频繁调用：Windows 上 config.json 在 userData 根，
   * 不在自动收紧的私有子目录里，每次原子写都要对新文件跑一次 icacls；异步版本不挡主进程。
   * 返回的 Promise 在包含本次改动的那次写入落盘后 resolve，失败时 reject。
   */
  save(): Promise<void> {
    if (this.queued) return this.queued;
    const prev = this.inflight;
    const job: Promise<void> = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
      this.runQueued(job),
    );
    this.queued = job;
    return job;
  }

  private async runQueued(job: Promise<void>): Promise<void> {
    // 被 flushOnQuit 接管（改为同步写）的排队写入：直接结束
    if (this.queued !== job) return;
    this.queued = null;
    this.inflight = job;
    try {
      const configData = JSON.stringify(this.config, null, 2);
      await writePrivateFileAtomicAsync(this.configPath, configData);
      this.logger?.debug('配置保存成功', { path: this.configPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('配置保存失败', { error: errorMessage, path: this.configPath });
      throw error;
    } finally {
      if (this.inflight === job) this.inflight = null;
    }
  }

  /** 等排队 / 进行中的异步保存都结束（不管成败） */
  private async whenIdle(): Promise<void> {
    while (this.inflight || this.queued) {
      await (this.queued ?? this.inflight)?.catch(() => undefined);
    }
  }

  /** 同步保存：只给退出路径用（之后进程马上退出，异步写来不及） */
  saveSync(): void {
    try {
      writePrivateFileAtomic(this.configPath, JSON.stringify(this.config, null, 2));
      this.logger?.debug('配置保存成功（同步）', { path: this.configPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error('配置保存失败', { error: errorMessage, path: this.configPath });
      throw error;
    }
  }

  /**
   * 退出时落盘最新配置：丢掉还没开始的排队写入，等进行中的那次结束（最多 waitMs，免得它在同步写之后
   * 才 rename、把旧内容盖回去），再同步写一次最新配置。
   */
  async flushOnQuit(waitMs = 2_000): Promise<void> {
    this.queued = null;
    const running = this.inflight;
    let settled = !running;
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = running
        .catch(() => undefined)
        .then(() => {
          settled = true;
        });
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      // 等超时了：那次写入若在同步写之后才落盘（进程还没退出时），再同步写一次把最新配置盖回去
      if (!settled) {
        void done.then(() => {
          try {
            this.saveSync();
          } catch {
            /* saveSync 已记日志 */
          }
        });
      }
    }
    this.saveSync();
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
    this.notifyChange();
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
      errors.push(t('electron.common.config-must-be-an-object'));
      return { isValid: false, errors, warnings };
    }

    // 验证窗口位置
    if (config.windowPosition) {
      if (
        typeof config.windowPosition.x !== 'number' ||
        typeof config.windowPosition.y !== 'number'
      ) {
        errors.push(t('electron.common.window-position-must-be-a-number'));
      }
    }

    // 验证语音设置
    if (config.voiceSettings) {
      const voice = config.voiceSettings;
      if (typeof voice.enabled !== 'boolean') {
        errors.push(t('electron.common.voice-setting-enabled-must-be-a-boolean'));
      }
      if (typeof voice.volume !== 'number' || voice.volume < 0 || voice.volume > 1) {
        errors.push(t('electron.common.volume-must-be-a-number-between-0-and'));
      }
      if (!['fixed', 'tts', 'mixed'].includes(voice.voiceMode)) {
        errors.push(t('electron.common.voice-mode-must-be-fixed-tts-or-mixed'));
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
    const backupPath = path.join(this.userData, `config-backup-${timestamp}.json`);

    try {
      // 备份的是磁盘上的文件：先等还没落盘的保存写完
      await this.whenIdle();
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
