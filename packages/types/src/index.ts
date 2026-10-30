// 语音相关类型定义
export interface VoiceContribute {
  keywords: string[];
  voices: string[];
}

export interface VoiceConfig {
  contributes: VoiceContribute[];
}

/** type 而不是 interface：要能直接作为契约 `voice.saveMascotSettings` 的 loose 入参 */
export type VoiceSettings = {
  enabled: boolean;
  volume: number;
  timeAnnouncement: boolean;
  voicePackPath: string;
  voiceMode: 'fixed' | 'tts' | 'mixed';
  /** 桌面角色动作音效（程序合成），默认开 */
  sfxEnabled?: boolean;
};

/**
 * Realtime TTS engine: edge (default — Microsoft Edge online read-aloud, needs network),
 * none (text only), or Azure / OpenAI (not implemented yet: selecting one stays silent).
 * The character's fixed prompt lines use the pack's prerecorded clips, not this engine.
 */
export type TTSProvider = 'none' | 'edge' | 'azure' | 'openai';

/**
 * TTS configuration (userData/tts-config.json).
 * Unknown providers in an old file (e.g. removed engines) load as `none`.
 */
export interface TTSConfig {
  enabled: boolean;
  /** 角色提示语音：角色固定台词播放角色包里的预录音频（默认开）。 */
  promptVoice?: boolean;
  /** Realtime engine. Default: edge (failures stay silent, text only). */
  provider: TTSProvider;
  /** Edge voice short name, e.g. zh-CN-XiaoyiNeural. */
  edgeVoice?: string;
  /**
   * The single read-aloud speech rate, percent (-50..50). Default -5, same as the prompt clips.
   * Used for mascot lines, AI replies and the settings preview.
   */
  rate?: number;
  /** Read Nomi's AI chat replies aloud with the realtime engine (default on). */
  readReplies?: boolean;
  lastModified: number;
}

export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoyiNeural';
export const DEFAULT_TTS_RATE = -5;

/** Public defaults: Edge engine (Xiaoyi, -5%), prompt voice on. */
export const DEFAULT_TTS_CONFIG: Omit<TTSConfig, 'lastModified'> = {
  enabled: true,
  promptVoice: true,
  provider: 'edge',
  edgeVoice: DEFAULT_EDGE_VOICE,
  rate: DEFAULT_TTS_RATE,
  readReplies: true,
};

/** One selectable realtime voice. */
export interface TTSVoice {
  shortName: string;
  locale: string;
  gender?: string;
  /** Friendly name from the service, if any. */
  name?: string;
}

/** Recent realtime-engine health, for a plain-language hint in settings. */
export interface TTSStatus {
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

/** Settings preview ("试听"): synthesize a short sample with an unsaved draft. */
export interface TTSPreviewRequest {
  text: string;
  provider: TTSProvider;
  edgeVoice?: string;
  rate?: number;
}

export interface TTSSpeakRequest {
  text: string;
  volume?: number;
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

export * from './speechText';

export * from './models';

export * from './quality';
export * from './chatBackground';
export * from './userProfile';
export * from './persona';
export * from './brand';
