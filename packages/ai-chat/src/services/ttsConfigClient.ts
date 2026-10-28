/**
 * 朗读引擎配置（userData/tts-config.json，主进程 tts/TtsService）：
 * 设置 → 语音与屏幕 → 语音里的「实时朗读引擎」卡片读写它。经契约 `tts.*`（原 electronAPI.tts）。
 */
import { api, hasTransport } from './api';

/** edge = Edge 在线朗读（默认，需联网）；none = 只显示文字；azure / openai 暂未接入 */
export type TtsProvider = 'none' | 'edge' | 'azure' | 'openai';

export interface TtsEngineConfig {
  enabled: boolean;
  /** 诺米提示语音（预录短句）开关 */
  promptVoice: boolean;
  provider: TtsProvider;
  /** Edge 音色，如 zh-CN-XiaoyiNeural */
  edgeVoice?: string;
  /** 朗读语速百分比，-50..50（提示语以外所有实时朗读共用这一个语速） */
  rate?: number;
  /** 朗读 AI 回复（默认开；实时朗读引擎不可用时不生效） */
  readReplies?: boolean;
  [key: string]: unknown;
}

export interface TtsTestResult {
  success: boolean;
  message: string;
  latency?: number;
}

export const DEFAULT_TTS_CONFIG: TtsEngineConfig = {
  enabled: true,
  promptVoice: true,
  provider: 'edge',
  edgeVoice: 'zh-CN-XiaoyiNeural',
  rate: -5,
  readReplies: true,
};

export interface TtsVoiceOption {
  shortName: string;
  locale: string;
  gender?: string;
  name?: string;
}

export interface TtsVoiceList {
  voices: TtsVoiceOption[];
  source: 'online' | 'builtin';
}

export interface TtsEngineStatus {
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

/** 连续失败到这个次数，设置里显示「暂时连不上」 */
export const TTS_FAILURE_HINT_THRESHOLD = 3;

export const ttsConfigClient = {
  available: () => hasTransport(),
  async get(): Promise<TtsEngineConfig> {
    const raw = hasTransport() ? await api.tts.getConfig() : null;
    return { ...DEFAULT_TTS_CONFIG, ...((raw ?? {}) as Partial<TtsEngineConfig>) };
  },
  /** 主进程拒绝保存时抛错（消息是原因），界面如实显示 */
  async save(cfg: TtsEngineConfig): Promise<void> {
    if (!hasTransport()) return;
    await api.tts.saveConfig(cfg);
  },
  async test(cfg: TtsEngineConfig): Promise<TtsTestResult> {
    if (!hasTransport()) return { success: false, message: '' };
    return api.tts.testConnection(cfg);
  },
  async reset(): Promise<void> {
    if (!hasTransport()) return;
    await api.tts.resetConfig();
  },
  async voices(): Promise<TtsVoiceList | null> {
    if (!hasTransport()) return null;
    try {
      return (await api.tts.voices()) as TtsVoiceList;
    } catch {
      return null;
    }
  },
  async status(): Promise<TtsEngineStatus | null> {
    if (!hasTransport()) return null;
    try {
      return await api.tts.status();
    } catch {
      return null;
    }
  },
  /** 用未保存的草稿合成一句；返回可播放的 data URL，失败返回 null */
  async preview(cfg: TtsEngineConfig, text: string): Promise<string | null> {
    if (!hasTransport()) return null;
    try {
      const r = await api.tts.preview({
        text,
        provider: cfg.provider,
        edgeVoice: cfg.edgeVoice,
        rate: cfg.rate,
      });
      if (!r?.success || !r.audioBase64) return null;
      return `data:${r.mimeType || 'audio/mpeg'};base64,${r.audioBase64}`;
    } catch {
      return null;
    }
  },
};
