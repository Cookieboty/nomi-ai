import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { t } from '../i18n';
import { psQuote } from '../security/shellEscape';
import { createMainLogger } from '../utils/log';

const log = createMainLogger('TTS');

/**
 * TTS音色配置接口
 */
export interface TTSVoiceConfig {
  name: string;
  systemVoice: string;
  platform: 'darwin' | 'win32' | 'linux';
  language: string;
  gender: 'male' | 'female' | 'neutral';
  style: string;
}

/**
 * TTS设置接口
 */
export interface TTSSettings {
  speed: number;
  pitch: number;
  volume: number;
  autoSelectByPlatform: boolean;
  fallbackToDefault: boolean;
}

/**
 * TTS配置接口
 */
export interface TTSConfig {
  currentVoice: string;
  voices: Record<string, TTSVoiceConfig>;
  settings: TTSSettings;
}

/**
 * 高级TTS引擎
 * 支持多平台、多音色的文本转语音功能
 */
export class AdvancedTTSEngine {
  private config: TTSConfig | null = null;
  private currentProcess: ChildProcess | null = null;

  constructor() {
    this.loadConfig();
  }

  /**
   * 加载TTS配置
   */
  private loadConfig(): void {
    try {
      const isDev = process.env.NODE_ENV === 'development';
      let configPath: string;

      if (isDev) {
        configPath = path.join(
          process.cwd(),
          'packages',
          'renderer',
          'public',
          'assets',
          'voice',
          'config.json',
        );
      } else {
        configPath = path.join(process.resourcesPath, 'renderer', 'assets', 'voice', 'config.json');
      }

      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        const fullConfig = JSON.parse(configData);
        this.config = fullConfig.tts;
        log.info('AdvancedTTSEngine: 配置加载成功');
      }
    } catch (error) {
      console.error('AdvancedTTSEngine: 配置加载失败:', error);
      this.setDefaultConfig();
    }
  }

  /**
   * 设置默认配置
   */
  private setDefaultConfig(): void {
    // Prefer soft Chinese female system voices; slower rate by default.
    const softByPlatform: Record<string, string> = {
      darwin: 'Meijia', // Taiwan Mandarin soft; Ting-Ting is fallback
      win32: 'Microsoft Huihui Desktop',
      linux: 'zh', // espeak/espeak-ng zh
    };
    const systemVoice = softByPlatform[process.platform] ?? 'default';
    this.config = {
      currentVoice: 'soft-zh-female',
      voices: {
        'soft-zh-female': {
          name: t('electron.common.soft-chinese-female-voice'),
          systemVoice,
          platform: process.platform as 'darwin' | 'win32' | 'linux',
          language: 'zh-CN',
          gender: 'female',
          style: 'soft',
        },
        default: {
          name: t('electron.common.system-default'),
          systemVoice: process.platform === 'darwin' ? 'Meijia' : systemVoice,
          platform: process.platform as 'darwin' | 'win32' | 'linux',
          language: 'zh-CN',
          gender: 'female',
          style: 'standard',
        },
      },
      settings: {
        speed: 0.88,
        pitch: 1.05,
        volume: 0.78,
        autoSelectByPlatform: true,
        fallbackToDefault: true,
      },
    };
  }

  /**
   * 获取可用的音色列表
   */
  public getAvailableVoices(): TTSVoiceConfig[] {
    if (!this.config) return [];

    const currentPlatform = process.platform;
    return Object.values(this.config.voices).filter(
      (voice) => voice.platform === currentPlatform || !this.config!.settings.autoSelectByPlatform,
    );
  }

  /**
   * 获取当前音色配置
   */
  public getCurrentVoice(): TTSVoiceConfig | null {
    if (!this.config) return null;

    const voiceId = this.config.currentVoice;
    let voice = this.config.voices[voiceId];

    // 如果启用了平台自动选择，尝试找到适合当前平台的音色
    if (
      this.config.settings.autoSelectByPlatform &&
      (!voice || voice.platform !== process.platform)
    ) {
      const platformVoices = this.getAvailableVoices();
      if (platformVoices.length > 0) {
        voice = platformVoices[0];
      }
    }

    return voice || null;
  }

  /**
   * 设置当前音色
   */
  public async setCurrentVoice(voiceId: string): Promise<boolean> {
    if (!this.config || !this.config.voices[voiceId]) {
      console.error('AdvancedTTSEngine: 音色不存在:', voiceId);
      return false;
    }

    this.config.currentVoice = voiceId;
    await this.saveConfig();
    log.info(`AdvancedTTSEngine: 切换到音色: ${voiceId}`);
    return true;
  }

  /**
   * 更新TTS设置
   */
  public async updateSettings(settings: Partial<TTSSettings>): Promise<void> {
    if (!this.config) return;

    this.config.settings = { ...this.config.settings, ...settings };
    await this.saveConfig();
    log.info('AdvancedTTSEngine: 设置已更新', settings);
  }

  /**
   * 保存配置
   */
  private async saveConfig(): Promise<void> {
    try {
      const isDev = process.env.NODE_ENV === 'development';
      let configPath: string;

      if (isDev) {
        configPath = path.join(
          process.cwd(),
          'packages',
          'renderer',
          'public',
          'assets',
          'voice',
          'config.json',
        );
      } else {
        configPath = path.join(process.resourcesPath, 'renderer', 'assets', 'voice', 'config.json');
      }

      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        const fullConfig = JSON.parse(configData);
        fullConfig.tts = this.config;
        fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2));
      }
    } catch (error) {
      console.error('AdvancedTTSEngine: 配置保存失败:', error);
    }
  }

  /**
   * 播放文本转语音
   */
  public async speak(text: string, options?: Partial<TTSSettings>): Promise<void> {
    return new Promise((resolve) => {
      try {
        // 停止当前播放
        this.stop();

        const voice = this.getCurrentVoice();
        if (!voice) {
          console.error('AdvancedTTSEngine: 没有可用的音色');
          resolve();
          return;
        }

        const settings = { ...this.config!.settings, ...options };

        log.info(`AdvancedTTSEngine: 使用音色 ${voice.name} 播放: ${text}`);

        // 根据平台选择播放方式
        this.currentProcess = this.createTTSProcess(text, voice, settings);

        if (this.currentProcess) {
          this.currentProcess.on('close', () => {
            this.currentProcess = null;
            resolve();
          });

          this.currentProcess.on('error', (error) => {
            console.error('AdvancedTTSEngine: TTS播放失败:', error);
            this.currentProcess = null;
            resolve();
          });
        } else {
          resolve();
        }
      } catch (error) {
        console.error('AdvancedTTSEngine: 播放失败:', error);
        resolve();
      }
    });
  }

  /**
   * 创建TTS进程
   */
  private createTTSProcess(
    text: string,
    voice: TTSVoiceConfig,
    settings: TTSSettings,
  ): ChildProcess | null {
    const platform = process.platform;

    switch (platform) {
      case 'darwin':
        return this.createMacOSTTSProcess(text, voice, settings);
      case 'win32':
        return this.createWindowsTTSProcess(text, voice, settings);
      case 'linux':
        return this.createLinuxTTSProcess(text, voice, settings);
      default:
        console.error('AdvancedTTSEngine: 不支持的平台:', platform);
        return null;
    }
  }

  /**
   * 创建macOS TTS进程
   */
  private createMacOSTTSProcess(
    text: string,
    voice: TTSVoiceConfig,
    settings: TTSSettings,
  ): ChildProcess {
    // ~175 wpm feels softer than the old 200 default
    const rate = Math.round(Math.max(120, Math.min(220, settings.speed * 200)));
    const preferred = [voice.systemVoice, 'Meijia', 'Ting-Ting', 'Sinji', 'Yu-shu'].filter(
      (v, i, a) => v && a.indexOf(v) === i,
    );
    // argv 经 POSIX 单引号转义后再拼进 bash，避免文本中的 $ ` " 等被 shell 解释
    const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    // bash: try voices until say succeeds
    const script = preferred
      .map((v) => `say -v ${shQuote(v)} -r ${rate} ${shQuote(text)}`)
      .join(' || ');
    return spawn('bash', ['-lc', script]);
  }

  /**
   * 创建Windows TTS进程
   */
  private createWindowsTTSProcess(
    text: string,
    voice: TTSVoiceConfig,
    settings: TTSSettings,
  ): ChildProcess {
    const script = `
      Add-Type -AssemblyName System.speech;
      $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer;
      $speak.SelectVoice(${psQuote(voice.systemVoice)});
      $speak.Rate = ${Math.round((settings.speed - 1) * 10)};
      $speak.Volume = ${Math.round(settings.volume * 100)};
      $speak.Speak(${psQuote(text)});
    `;

    return spawn('powershell', ['-Command', script]);
  }

  /**
   * 创建Linux TTS进程
   */
  private createLinuxTTSProcess(
    text: string,
    voice: TTSVoiceConfig,
    settings: TTSSettings,
  ): ChildProcess {
    // Slower espeak; zh+f3 approximates a softer female when available
    const args = [
      '-v',
      voice.systemVoice.includes('zh') ? voice.systemVoice : 'zh',
      '-s',
      Math.round(Math.max(100, settings.speed * 140)).toString(),
      '-p',
      Math.round(40 + settings.pitch * 20).toString(),
      text,
    ];

    const process = spawn('espeak', args);

    // 如果espeak失败，尝试festival
    process.on('error', () => {
      log.info('AdvancedTTSEngine: espeak失败，尝试festival');
      return spawn('echo', [text, '|', 'festival', '--tts']);
    });

    return process;
  }

  /**
   * 停止当前播放
   */
  public stop(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
      log.info('AdvancedTTSEngine: 停止播放');
    }
  }

  /**
   * 测试音色
   */
  public async testVoice(
    voiceId: string,
    testText: string = t('electron.common.this-is-a-voice-test'),
  ): Promise<boolean> {
    if (!this.config || !this.config.voices[voiceId]) {
      return false;
    }

    const originalVoice = this.config.currentVoice;

    try {
      await this.setCurrentVoice(voiceId);
      await this.speak(testText);
      return true;
    } catch (error) {
      console.error('AdvancedTTSEngine: 音色测试失败:', error);
      return false;
    } finally {
      // 恢复原音色
      this.config.currentVoice = originalVoice;
    }
  }

  /**
   * 获取音色统计信息
   */
  public getVoiceStats(): {
    total: number;
    byPlatform: Record<string, number>;
    byGender: Record<string, number>;
  } {
    if (!this.config) {
      return { total: 0, byPlatform: {}, byGender: {} };
    }

    const voices = Object.values(this.config.voices);
    const stats = {
      total: voices.length,
      byPlatform: {} as Record<string, number>,
      byGender: {} as Record<string, number>,
    };

    voices.forEach((voice) => {
      stats.byPlatform[voice.platform] = (stats.byPlatform[voice.platform] || 0) + 1;
      stats.byGender[voice.gender] = (stats.byGender[voice.gender] || 0) + 1;
    });

    return stats;
  }
}
