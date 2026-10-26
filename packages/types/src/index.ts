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

  // 实时朗读（Edge / Azure / OpenAI / 可选 Fish / legacy 外部服务；默认无）；配置在对话窗口的设置里
  /** Main-process TTS synthesize; on failure renderer stays silent */
  ttsSpeak?: (req: TTSSpeakRequest) => Promise<TTSSpeakResult>;
  ttsHealth?: (config?: Partial<TTSConfig>) => Promise<TTSTestResult>;

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
 * Realtime TTS engine: none (default — AI replies are text only), Edge / Azure / OpenAI,
 * optional Fish (advanced), legacy external clone API. No built-in offline engine and no
 * system Web Speech. Nomi's fixed prompt lines use prerecorded clips, not this engine.
 */
export type TTSProvider =
  'none' | 'edge' | 'azure' | 'openai' | 'fish-local' | 'fish-cloud' | 'legacy';

/** Audio format requested from Fish /v1/tts */
export type TTSAudioFormat = 'mp3' | 'wav' | 'opus' | 'pcm';

/**
 * TTS configuration (userData/tts-config.json).
 * Default provider is `none`; `promptVoice` controls Nomi's prerecorded prompt clips.
 * Fish (`fish-local` / `fish-cloud`) is an optional advanced engine with cute Nomi referenceId.
 * `apiKey` for fish-cloud is stored via safeStorage in the main process — never trust
 * a raw key from the renderer as the source of truth.
 * Legacy fields (hostname/port/path/audioUrl/promptText) remain for external TTS.
 * There is no user voice-upload / clone-from-arbitrary-audio path in the product UI.
 */
export interface TTSConfig {
  enabled: boolean;
  /** 诺米提示语音：Nomi 固定台词播放预录音频（默认开）。 */
  promptVoice?: boolean;
  /** Realtime engine. Default: none (text only; failures stay silent). */
  provider: TTSProvider;
  /** fish-local base, default http://127.0.0.1:8080 */
  baseUrl: string;
  /**
   * Fish cloud API key. When reading via IPC, main may return empty string and
   * set hasApiKey instead; when saving, a non-empty value updates safeStorage,
   * empty string leaves existing key unchanged, explicit clearApiKey clears it.
   */
  apiKey?: string;
  /** True when a cloud key is stored (IPC get only). */
  hasApiKey?: boolean;
  /** Clear stored cloud API key on save (IPC save only). */
  clearApiKey?: boolean;
  /**
   * Built-in voice preset / Fish reference_id (e.g. `nomi` for local references/nomi).
   * Not a user-uploaded clone slot.
   */
  referenceId: string;
  format: TTSAudioFormat;
  timeoutMs: number;
  /** Optional Fish cloud model header (e.g. s2.1-pro-free). */
  cloudModel?: string;

  // --- legacy external TTS (hostname/port/path clone API) ---
  hostname: string;
  port: number;
  path: string;
  audioUrl: string;
  promptText: string;

  lastModified: number;
}

/** Public defaults: no realtime engine, prompt voice on (no secrets). */
export const DEFAULT_TTS_CONFIG: Omit<TTSConfig, 'lastModified'> = {
  enabled: true,
  promptVoice: true,
  provider: 'none',
  baseUrl: 'http://127.0.0.1:8080',
  referenceId: 'nomi',
  format: 'mp3',
  timeoutMs: 30000,
  cloudModel: 's2.1-pro-free',
  hostname: '127.0.0.1',
  port: 8080,
  path: '/v1/tts',
  audioUrl: '',
  promptText: '',
};

/** Built-in cute voice presets (no user upload). */
export const BUILTIN_FISH_VOICE_PRESETS = [
  {
    id: 'nomi',
    label: 'Nomi（可爱）',
    description:
      'Built-in kawaii Mandarin preference for Nomi; local fish-speech uses references/nomi.',
  },
] as const;

export interface TTSSpeakRequest {
  text: string;
  /** Override referenceId for this utterance (character binding). */
  referenceId?: string;
  volume?: number;
  /** Per-character speed multiplier (0.5..1.5), mapped to engine speech rate when supported. */
  speed?: number;
}

export interface TTSSpeakResult {
  success: boolean;
  /** base64 audio when success; renderer plays it */
  audioBase64?: string;
  mimeType?: string;
  /** 'fish' | 'legacy' | 'none' — none means no audio was produced */
  via?: 'fish' | 'legacy' | 'none';
  message?: string;
  /** Kept for wire compatibility; always false because system speech is disabled. */
  fallbackToSystem?: boolean;
}

// TTS连接测试结果
export interface TTSTestResult {
  success: boolean;
  message: string;
  latency?: number;
}

export * from './models';

export * from './quality';
