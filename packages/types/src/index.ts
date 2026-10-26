import type { DesktopApi, MascotWindowApi } from './models';

// 定义IPC通信接口
export interface IpcApi {
  quit: () => void;
  setAlwaysOnTop: (flag: boolean) => void;
  moveWindow: (deltaX: number, deltaY: number) => void;
  getPosition: () => Promise<[number, number]>;
  setPosition: (x: number, y: number) => void;
  saveModel: (modelName: string) => void;
  getSavedModel: () => Promise<string>;
  getCursorPosition: () => Promise<{ x: number; y: number }>;
  onWindowMouseEnter: (callback: () => void) => void;
  onWindowMouseLeave: (callback: () => void) => void;
  removeWindowMouseListeners: () => void;

  // 语音相关API - 简化后只保留必要的
  getVoiceSettings: () => Promise<VoiceSettings>;
  saveVoiceSettings: (settings: VoiceSettings) => void;
  /** 主进程改了语音开关（TTS 模型下载失败回滚等）；返回取消订阅 */
  onVoiceSettingsChanged?: (callback: (settings: Partial<VoiceSettings>) => void) => () => void;

  // 实时朗读（Edge / Azure / OpenAI，均未接入；默认无）；配置在对话窗口的设置里
  /** Main-process TTS synthesize; on failure renderer stays silent */
  ttsSpeak?: (req: TTSSpeakRequest) => Promise<TTSSpeakResult>;
  ttsHealth?: (config?: Partial<TTSConfig>) => Promise<TTSTestResult>;
  /** 诺米提示语音开关（TTSConfig.promptVoice，默认开） */
  ttsPromptVoice?: () => Promise<boolean>;

  // AI对话相关API
  openAiChat: () => Promise<{ success: boolean; error?: string }>;
  /** 打开对话窗口的日程页（看板娘工具栏「任务看板」） */
  openTaskBoard?: () => Promise<{ success: boolean; error?: string }>;

  /** 打开对话窗口的「设置 → 语音与屏幕 → 语音」（朗读引擎等） */
  openVoiceSettings?: () => Promise<{ success: boolean; error?: string }>;

  /** 主进程 → 看板娘指令：{ type: 'motion' | 'expression' | 'parameter', ... } */
  onMascotCommand?: (callback: (cmd: unknown) => void) => () => void;

  /** 看板娘窗口互动 */
  mascotWindow?: MascotWindowApi;
  /** 桌面能力（确认 / 拖文件总结） */
  desktop?: DesktopApi;
}

// 在渲染进程中可用的Electron API
export interface ElectronApi {
  electronAPI: IpcApi;
}

// 语音相关类型定义
export interface VoiceContribute {
  keywords: string[];
  voices: string[];
}

export interface VoiceConfig {
  contributes: VoiceContribute[];
}

export interface VoiceSettings {
  enabled: boolean;
  volume: number;
  timeAnnouncement: boolean;
  voicePackPath: string;
  voiceMode: 'fixed' | 'tts' | 'mixed';
  /** 看板娘动作音效（程序合成），默认开 */
  sfxEnabled?: boolean;
}

/**
 * Realtime TTS engine: none (default — AI replies are text only) or Edge / Azure / OpenAI
 * (not implemented yet: selecting one stays silent). Nomi's fixed prompt lines use
 * prerecorded clips, not this engine.
 */
export type TTSProvider = 'none' | 'edge' | 'azure' | 'openai';

/**
 * TTS configuration (userData/tts-config.json).
 * Unknown providers in an old file (e.g. removed engines) load as `none`.
 */
export interface TTSConfig {
  enabled: boolean;
  /** 诺米提示语音：Nomi 固定台词播放预录音频（默认开）。 */
  promptVoice?: boolean;
  /** Realtime engine. Default: none (text only; failures stay silent). */
  provider: TTSProvider;
  lastModified: number;
}

/** Public defaults: no realtime engine, prompt voice on. */
export const DEFAULT_TTS_CONFIG: Omit<TTSConfig, 'lastModified'> = {
  enabled: true,
  promptVoice: true,
  provider: 'none',
};

export interface TTSSpeakRequest {
  text: string;
  volume?: number;
  /** Per-character speed multiplier (0.5..1.5), mapped to engine speech rate when supported. */
  speed?: number;
}

export interface TTSSpeakResult {
  success: boolean;
  /** base64 audio when success; renderer plays it */
  audioBase64?: string;
  mimeType?: string;
  /** Engine that produced audio; none means no audio was produced */
  via?: TTSProvider;
  message?: string;
}

// TTS连接测试结果
export interface TTSTestResult {
  success: boolean;
  message: string;
  latency?: number;
}

export * from './models';

export * from './quality';
