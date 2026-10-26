/**
 * 朗读引擎配置（userData/tts-config.json，主进程 tts/TtsConfigStore）：
 * 设置 → 语音与屏幕 → 语音里的「实时朗读引擎」卡片读写它。
 */
/** edge = Edge 在线朗读（默认，需联网）；none = 只显示文字；azure / openai 暂未接入 */
export type TtsProvider = 'none' | 'edge' | 'azure' | 'openai';

export interface TtsEngineConfig {
  enabled: boolean;
  /** 诺米提示语音（预录短句）开关 */
  promptVoice: boolean;
  provider: TtsProvider;
  /** Edge 音色，如 zh-CN-XiaoyiNeural */
  edgeVoice?: string;
  /** Edge 语速百分比，-50..50 */
  edgeRate?: number;
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
  edgeRate: -5,
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

interface PreviewResult {
  success: boolean;
  audioBase64?: string;
  mimeType?: string;
}

interface Bridge {
  get(): Promise<Partial<TtsEngineConfig> | null>;
  save(cfg: TtsEngineConfig): Promise<{ success?: boolean; error?: string } | undefined>;
  test(cfg: TtsEngineConfig): Promise<TtsTestResult>;
  reset(): Promise<{ success?: boolean; error?: string } | undefined>;
  voices?(): Promise<TtsVoiceList>;
  preview?(req: {
    text: string;
    provider: TtsProvider;
    edgeVoice?: string;
    edgeRate?: number;
  }): Promise<PreviewResult>;
  status?(): Promise<TtsEngineStatus>;
}
const bridge = (): Bridge | undefined =>
  (window as unknown as { electronAPI?: { tts?: Bridge } }).electronAPI?.tts;

export const ttsConfigClient = {
  available: () => Boolean(bridge()),
  async get(): Promise<TtsEngineConfig> {
    const raw = (await bridge()?.get()) ?? null;
    return { ...DEFAULT_TTS_CONFIG, ...(raw ?? {}) };
  },
  /** 主进程拒绝保存时抛错，界面如实显示 */
  async save(cfg: TtsEngineConfig): Promise<void> {
    const r = await bridge()?.save(cfg);
    if (r && r.success === false) throw new Error(r.error || 'save failed');
  },
  async test(cfg: TtsEngineConfig): Promise<TtsTestResult> {
    const b = bridge();
    if (!b) return { success: false, message: '' };
    return b.test(cfg);
  },
  async reset(): Promise<void> {
    const r = await bridge()?.reset();
    if (r && r.success === false) throw new Error(r.error || 'reset failed');
  },
  async voices(): Promise<TtsVoiceList | null> {
    try {
      return (await bridge()?.voices?.()) ?? null;
    } catch {
      return null;
    }
  },
  async status(): Promise<TtsEngineStatus | null> {
    try {
      return (await bridge()?.status?.()) ?? null;
    } catch {
      return null;
    }
  },
  /** 用未保存的草稿合成一句；返回可播放的 data URL，失败返回 null */
  async preview(cfg: TtsEngineConfig, text: string): Promise<string | null> {
    try {
      const r = await bridge()?.preview?.({
        text,
        provider: cfg.provider,
        edgeVoice: cfg.edgeVoice,
        edgeRate: cfg.edgeRate,
      });
      if (!r?.success || !r.audioBase64) return null;
      return `data:${r.mimeType || 'audio/mpeg'};base64,${r.audioBase64}`;
    } catch {
      return null;
    }
  },
};
