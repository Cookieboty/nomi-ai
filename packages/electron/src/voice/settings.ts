/** 语音设置（纯逻辑，可单测）。只存本机 userData/voice/settings.json。 */
export type AsrEngine = 'whisper-cpp' | 'openai-compat';

export interface VoiceSettings {
  engine: AsrEngine;
  /** auto / zh / en / ja … */
  language: string;
  whisperModel: string;
  /** 用户指定的 whisper-cli 路径（可选） */
  whisperCliPath: string;
  /** openai-compat：使用哪个已保存的 provider；或自定义地址（如本地 whisper.cpp server） */
  providerId: string;
  customBaseURL: string;
  cloudModel: string;
  /** 已确认可以把录音发给哪些云端服务 */
  cloudAcked: string[];
  /** 识别后自动发送 */
  autoSend: boolean;
  /** 开始说话时打断正在播放的语音 */
  bargeIn: boolean;
  /** 免按键（VAD）灵敏度 0.3..0.9：越高越不容易误触发 */
  vadThreshold: number;
  /** 唤醒词（默认关；需本地 whisper.cpp + Silero VAD；从不上传） */
  wakeWord: { enabled: boolean; phrase: string; windowSec: number };
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  engine: 'whisper-cpp',
  language: 'auto',
  whisperModel: 'ggml-base',
  whisperCliPath: '',
  providerId: '',
  customBaseURL: '',
  cloudModel: 'whisper-1',
  cloudAcked: [],
  autoSend: true,
  bargeIn: true,
  vadThreshold: 0.5,
  wakeWord: { enabled: false, phrase: '你好，诺米', windowSec: 8 },
};

const str = (v: unknown, d: string, max = 300) =>
  typeof v === 'string' ? v.trim().slice(0, max) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

export function sanitizeVoiceSettings(
  raw: unknown,
  base: VoiceSettings = DEFAULT_VOICE_SETTINGS,
): VoiceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ww = (r.wakeWord && typeof r.wakeWord === 'object' ? r.wakeWord : {}) as Record<
    string,
    unknown
  >;
  const lang = str(r.language, base.language, 8);
  const url = str(r.customBaseURL, base.customBaseURL, 500);
  return {
    engine: r.engine === 'openai-compat' || r.engine === 'whisper-cpp' ? r.engine : base.engine,
    language: /^(auto|[a-z]{2,3})$/.test(lang) ? lang : base.language,
    whisperModel: str(r.whisperModel, base.whisperModel, 64),
    whisperCliPath: str(r.whisperCliPath, base.whisperCliPath, 1000),
    providerId: str(r.providerId, base.providerId, 128),
    customBaseURL: url === '' || /^https?:\/\//i.test(url) ? url : base.customBaseURL,
    cloudModel: str(r.cloudModel, base.cloudModel, 128) || 'whisper-1',
    cloudAcked: Array.isArray(r.cloudAcked)
      ? r.cloudAcked.filter((x): x is string => typeof x === 'string').slice(0, 50)
      : base.cloudAcked,
    autoSend: bool(r.autoSend, base.autoSend),
    bargeIn: bool(r.bargeIn, base.bargeIn),
    vadThreshold: num(r.vadThreshold, base.vadThreshold, 0.3, 0.9),
    wakeWord: {
      enabled: bool(ww.enabled, base.wakeWord.enabled),
      phrase: str(ww.phrase, base.wakeWord.phrase, 24) || DEFAULT_VOICE_SETTINGS.wakeWord.phrase,
      windowSec: num(ww.windowSec, base.wakeWord.windowSec, 3, 30),
    },
  };
}

/** 识别目标的标识（用于云端同意记录）：provider id 或自定义地址的 origin */
export function cloudTargetId(s: VoiceSettings): string {
  if (s.customBaseURL) {
    try {
      return `url:${new URL(s.customBaseURL).origin}`;
    } catch {
      return 'url:invalid';
    }
  }
  return s.providerId;
}
