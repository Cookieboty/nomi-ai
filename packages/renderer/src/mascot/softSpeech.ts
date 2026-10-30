/**
 * Speech preference helpers shared by the mascot voice paths.
 *
 * 2.0.3 起不再使用系统 speechSynthesis 朗读：提示语走预录音频，其余走设置里的实时朗读引擎，
 * 都没有时只显示气泡。这里只保留语速 / 音量等偏好与停止入口，供旧调用方继续工作。
 */

const STORAGE_KEY = 'mascot.softSpeech.v1';

export interface SoftSpeechPrefs {
  /** Legacy field kept for stored prefs; no longer used for playback. */
  voiceURI: string;
  /** 0.5..1.5 — speaking rate passed to the realtime engine */
  rate: number;
  /** Legacy field kept for stored prefs. */
  pitch: number;
  /** Legacy field kept for stored prefs. */
  preferNeural: boolean;
  volume: number;
}

export const DEFAULT_SOFT_SPEECH: SoftSpeechPrefs = {
  voiceURI: '',
  rate: 0.88,
  pitch: 1.06,
  preferNeural: true,
  volume: 0.78,
};

export function loadSoftSpeechPrefs(): SoftSpeechPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SoftSpeechPrefs>;
    return {
      ...DEFAULT_SOFT_SPEECH,
      ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null)),
    } as SoftSpeechPrefs;
  } catch {
    return { ...DEFAULT_SOFT_SPEECH };
  }
}

export function saveSoftSpeechPrefs(patch: Partial<SoftSpeechPrefs>): SoftSpeechPrefs {
  const next = { ...loadSoftSpeechPrefs(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

/** Split on Chinese/English clause punctuation for gentle pauses. */
export function clausePauseParts(text: string): string[] {
  const parts = text
    .split(/(?<=[，。！？；、,…~～])/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

export interface SpeakSoftOptions {
  prefs?: SoftSpeechPrefs;
  /** Cancel any current utterance first (default true) */
  cancel?: boolean;
  onEnd?: () => void;
  /**
   * 角色提示语音片段 key（变量台词用固定句）；null 表示不播预录片段。
   * 未提供时按台词 key / 文本自动匹配。
   */
  clip?: string | null;
}

/** 语音打断入口：系统朗读已移除，保留为空操作以兼容 speechStop 等调用方 */
export function stopSoftSpeech(): void {
  /* no system speech to stop */
}
