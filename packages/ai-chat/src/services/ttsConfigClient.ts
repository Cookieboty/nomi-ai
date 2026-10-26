/**
 * 朗读引擎配置（userData/tts-config.json，主进程 tts/TtsConfigStore）：
 * 设置 → 语音与屏幕 → 语音里的「实时朗读引擎」卡片读写它。
 */
/** none = 不朗读 AI 回复（默认）；edge / azure / openai 暂未接入 */
export type TtsProvider = 'none' | 'edge' | 'azure' | 'openai';

export interface TtsEngineConfig {
  enabled: boolean;
  /** 诺米提示语音（预录短句）开关 */
  promptVoice: boolean;
  provider: TtsProvider;
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
  provider: 'none',
};

interface Bridge {
  get(): Promise<Partial<TtsEngineConfig> | null>;
  save(cfg: TtsEngineConfig): Promise<{ success?: boolean; error?: string } | undefined>;
  test(cfg: TtsEngineConfig): Promise<TtsTestResult>;
  reset(): Promise<{ success?: boolean; error?: string } | undefined>;
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
};
