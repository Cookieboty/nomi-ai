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

  // TTS配置相关API（内置 sherpa-onnx 离线 TTS / 可选 Fish / legacy 外部服务）
  getTTSConfig: () => Promise<TTSConfig | null>;
  saveTTSConfig: (config: TTSConfig) => Promise<void>;
  testTTSConnection: (config: TTSConfig) => Promise<TTSTestResult>;
  resetTTSConfig: () => Promise<void>;
  /** Main-process TTS synthesize; on failure renderer stays silent */
  ttsSpeak?: (req: TTSSpeakRequest) => Promise<TTSSpeakResult>;
  ttsHealth?: (config?: Partial<TTSConfig>) => Promise<TTSTestResult>;
  /** sherpa 离线 TTS 模型状态（bundled / env / 缺失） */
  ttsSherpaStatus?: () => Promise<SherpaModelStatus>;

  // AI对话相关API
  openAiChat: () => Promise<{ success: boolean; error?: string }>;

  // TTS配置窗口API
  openTTSConfig: () => Promise<{ success: boolean; error?: string }>;

  /** 主进程 → 看板娘指令：{ type: 'motion' | 'expression' | 'parameter', ... } */
  onMascotCommand?: (callback: (cmd: unknown) => void) => () => void;

  /** 模型注册表 / 商店 / 用户导入（主进程实现） */
  models?: import('./models').ModelsApi;
  /** 看板娘窗口互动 */
  mascotWindow?: import('./models').MascotWindowApi;
  /** 桌面能力（确认 / 拖文件总结） */
  desktop?: import('./models').DesktopApi;
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
 * TTS provider: built-in sherpa-onnx offline (default), optional Fish (advanced),
 * legacy external clone API. System Web Speech is intentionally unsupported.
 */
export type TTSProvider = 'sherpa-theresa' | 'fish-local' | 'fish-cloud' | 'legacy';

/** Audio format requested from Fish /v1/tts */
export type TTSAudioFormat = 'mp3' | 'wav' | 'opus' | 'pcm';

/**
 * TTS configuration (userData/tts-config.json).
 * Built-in default is the offline sherpa-onnx VITS model (`sherpa-theresa`, sid 0, speed 1.0).
 * Fish (`fish-local` / `fish-cloud`) is an optional advanced engine with cute Nomi referenceId.
 * `apiKey` for fish-cloud is stored via safeStorage in the main process — never trust
 * a raw key from the renderer as the source of truth.
 * Legacy fields (hostname/port/path/audioUrl/promptText) remain for external TTS.
 * There is no user voice-upload / clone-from-arbitrary-audio path in the product UI.
 */
export interface TTSConfig {
  enabled: boolean;
  /** Default: sherpa-theresa (offline; missing / failed TTS stays silent). */
  provider: TTSProvider;
  /** sherpa speaker id (default 0). */
  sherpaSid?: number;
  /** sherpa speech speed multiplier (default 1.0 — do not speed up). */
  sherpaSpeed?: number;
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

/** Public defaults: built-in sherpa-onnx offline TTS (no secrets). Fish fields kept for the advanced engine. */
export const DEFAULT_TTS_CONFIG: Omit<TTSConfig, 'lastModified'> = {
  enabled: true,
  provider: 'sherpa-theresa',
  sherpaSid: 0,
  sherpaSpeed: 1.0,
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
  /** Per-character playback speed for local sherpa (0.5..1.5). */
  speed?: number;
}

export interface TTSSpeakResult {
  success: boolean;
  /** base64 audio when success; renderer plays it */
  audioBase64?: string;
  mimeType?: string;
  /** 'sherpa' | 'fish' | 'legacy' | 'none' — none means no audio was produced */
  via?: 'sherpa' | 'fish' | 'legacy' | 'none';
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

/** sherpa-onnx offline TTS model status (extraResources / env / auto-fetched for dev). */
export interface SherpaModelStatus {
  state: 'ready' | 'missing' | 'error';
  /** where the model was found */
  source?: 'env' | 'resources' | 'dev' | 'userData';
  modelId: string;
  message?: string;
}
