/* eslint-disable @typescript-eslint/no-explicit-any -- legacy untyped window.electronAPI bridge */
import { type VoiceConfig, type VoiceSettings, type VoiceContribute } from '@nomi-ai/types';
import { createLogger, t } from '@nomi-ai/ui';

import { HOURLY_LINES } from '../mascot/tips';

const log = createLogger('voice');

/**
 * 语音服务类
 * 负责管理语音播放与定时播报（按键序列彩蛋已移除）。
 */
const TIME_KEYWORDS: Array<[string, number]> = [
  ['$time_morning', 7],
  ['$time_before_noon', 10],
  ['$time_noon', 12],
  ['$time_evening', 19],
  ['$time_midnight', 23],
  ['$time_each_hour', 15],
];
const TIME_KEYWORD_LINES = TIME_KEYWORDS.map(([keyword, hour]) => ({
  keywords: [keyword],
  voices: HOURLY_LINES.find((h) => hour >= h.from && hour <= h.to)?.lines ?? [],
}));

export class VoiceService {
  /** 立即停止当前音频（语音打断） */
  stop(): void {
    try {
      this.currentAudio?.pause();
    } catch {
      /* ignore */
    }
    this.currentAudio = null;
  }

  private voiceConfig: VoiceConfig | null = null;
  private voiceSettings: VoiceSettings | null = null;
  private timeAnnouncementInterval: NodeJS.Timeout | null = null;
  private lastAnnouncementTime: number = 0;
  private currentAudio: HTMLAudioElement | null = null;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.initPromise = this.init();
  }

  /**
   * 等待初始化完成
   */
  public async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * 检查是否已初始化
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * 初始化语音服务
   */
  private async init() {
    try {
      // 0. 等待electronAPI准备就绪
      await this.waitForElectronAPI();

      // 1. 加载语音配置
      await this.loadVoiceConfig();

      // 2. 加载语音设置
      await this.loadVoiceSettings();

      // 3. 启动定时播报
      this.startTimeAnnouncement();

      this.isInitialized = true;
    } catch (error) {
      log.error('初始化失败:', error);
      this.isInitialized = false;
    }
  }

  /**
   * 等待electronAPI准备就绪
   */
  private async waitForElectronAPI(): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50; // 最多等待5秒

      const checkAPI = () => {
        attempts++;
        const electronAPI = (window as any).electronAPI;

        if (electronAPI) {
          resolve();
        } else if (attempts >= maxAttempts) {
          log.error('等待electronAPI超时');
          reject(new Error(t('electronAPI准备超时')));
        } else {
          setTimeout(checkAPI, 100);
        }
      };

      checkAPI();
    });
  }

  /**
   * 加载语音配置：使用内置原创台词（src/mascot/tips.ts），由系统语音朗读。
   * （旧版的第三方 mp3 语音包许可不明，已移除）
   */
  private async loadVoiceConfig() {
    // 仅保留定时播报台词；按键关键词彩蛋已移除
    this.voiceConfig = {
      contributes: [...TIME_KEYWORD_LINES],
    };
  }

  /**
   * 加载语音设置
   */
  private async loadVoiceSettings() {
    try {
      const electronAPI = (window as any).electronAPI;
      if (electronAPI) {
        this.voiceSettings = await electronAPI.getVoiceSettings();
      } else {
        log.error('electronAPI 不可用，无法加载语音设置');
      }
    } catch (error) {
      log.error('加载语音设置失败:', error);
    }
  }

  /**
   * 播放随机语音
   */
  private playRandomVoice(voices: string[]) {
    if (voices.length === 0) return;

    const randomIndex = Math.floor(Math.random() * voices.length);
    const selectedVoice = voices[randomIndex];

    this.playVoice(selectedVoice);
  }

  /**
   * 朗读一句台词（Web Speech API，系统自带语音，无需音频资源）。
   */
  private async playVoice(line: string) {
    try {
      window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: line } }));
      const { speakForActiveCharacter, resolvePrefsForCharacter } =
        await import('../mascot/characterVoice');
      const prefs = resolvePrefsForCharacter();
      if (this.voiceSettings?.volume != null) prefs.volume = this.voiceSettings.volume;
      speakForActiveCharacter(line, { prefs });
    } catch (error) {
      log.error('朗读失败:', error);
    }
  }

  /**
   * 启动定时播报
   */
  private startTimeAnnouncement() {
    if (!this.voiceSettings?.timeAnnouncement) return;

    // 每分钟检查一次是否需要播报
    this.timeAnnouncementInterval = setInterval(() => {
      this.checkTimeAnnouncement();
    }, 60000); // 60秒

    // 立即检查一次
    this.checkTimeAnnouncement();
  }

  /**
   * 检查时间播报
   */
  private checkTimeAnnouncement() {
    if (!this.voiceConfig || !this.voiceSettings?.enabled) return;

    const now = new Date();
    const currentTime = now.getTime();

    // 避免频繁播报（至少间隔30分钟）
    if (currentTime - this.lastAnnouncementTime < 30 * 60 * 1000) {
      return;
    }

    const hour = now.getHours();
    let timeKeyword = '';

    // 根据时间确定关键词
    if (hour >= 6 && hour < 11) {
      timeKeyword = '$time_morning';
    } else if (hour >= 11 && hour < 13) {
      timeKeyword = '$time_before_noon';
    } else if (hour >= 13 && hour < 14) {
      timeKeyword = '$time_noon';
    } else if (hour >= 17 && hour < 22) {
      timeKeyword = '$time_evening';
    } else if (hour >= 22 || hour < 6) {
      timeKeyword = '$time_midnight';
    }

    // 每小时播报
    if (now.getMinutes() === 0) {
      timeKeyword = '$time_each_hour';
    }

    if (timeKeyword) {
      const contribute = this.voiceConfig.contributes.find((c: VoiceContribute) =>
        c.keywords.includes(timeKeyword),
      );

      if (contribute) {
        this.playRandomVoice(contribute.voices);
        this.lastAnnouncementTime = currentTime;
      }
    }
  }

  /**
   * 更新语音设置
   */
  public async updateSettings(newSettings: Partial<VoiceSettings>) {
    try {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI) return;

      // 合并设置
      this.voiceSettings = { ...this.voiceSettings, ...newSettings } as VoiceSettings;

      // 保存设置
      electronAPI.saveVoiceSettings(this.voiceSettings);
      window.dispatchEvent(
        new CustomEvent('mascot:voice-settings', { detail: { ...this.voiceSettings } }),
      );

      if (newSettings.timeAnnouncement !== undefined) {
        if (this.timeAnnouncementInterval) {
          clearInterval(this.timeAnnouncementInterval);
          this.timeAnnouncementInterval = null;
        }

        if (newSettings.timeAnnouncement) {
          this.startTimeAnnouncement();
        }
      }
    } catch (error) {
      log.error('更新语音设置失败:', error);
    }
  }

  /**
   * 获取当前设置
   */
  public getSettings(): VoiceSettings | null {
    return this.voiceSettings;
  }

  /**
   * 销毁服务
   */
  public destroy() {
    const electronAPI = (window as any).electronAPI;

    if (electronAPI) {
      electronAPI.removeAudioListeners?.();
    }

    if (this.timeAnnouncementInterval) {
      clearInterval(this.timeAnnouncementInterval);
    }

    // 停止当前音频
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }
}
