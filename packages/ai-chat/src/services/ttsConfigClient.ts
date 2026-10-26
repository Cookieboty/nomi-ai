/**
 * 朗读引擎配置（userData/tts-config.json，主进程 tts/fish/FishTtsConfigStore）：
 * 设置 → 语音与屏幕 → 语音里的「朗读引擎」卡片读写它。云端 Key 只在主进程用 safeStorage 保存，
 * 这里只会写入（留空 = 保留），读回来只有 `hasApiKey`。
 */
/** none = 不朗读 AI 回复（默认）；edge / azure / openai 暂未接入；fish-* / legacy 只保留给旧配置 */
export type TtsProvider =
  'none' | 'edge' | 'azure' | 'openai' | 'fish-local' | 'fish-cloud' | 'legacy';

export interface TtsEngineConfig {
  enabled: boolean;
  /** 诺米提示语音（预录短句）开关 */
  promptVoice: boolean;
  provider: TtsProvider;
  baseUrl: string;
  referenceId: string;
  format: string;
  hostname: string;
  port: number;
  path: string;
  audioUrl: string;
  promptText: string;
  hasApiKey?: boolean;
  /** 只写：新的云端 Key */
  apiKey?: string;
  /** 只写：清除已保存的 Key */
  clearApiKey?: boolean;
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
  baseUrl: 'http://127.0.0.1:8080',
  referenceId: 'nomi',
  format: 'mp3',
  hostname: '127.0.0.1',
  port: 8080,
  path: '/v1/tts',
  audioUrl: '',
  promptText: '',
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
  /** 主进程拒绝保存（如系统安全存储不可用时不明文落盘 Key）时抛错，界面如实显示 */
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
