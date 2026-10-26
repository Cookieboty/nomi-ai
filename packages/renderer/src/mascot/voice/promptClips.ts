/**
 * 诺米提示语音：Nomi 固定台词的预录音频（public/voice/nomi/zh，Edge zh-CN-XiaoyiNeural 生成）。
 *
 * 播放顺序：预录片段 → 已配置的实时朗读引擎 → 仅气泡。
 * 只在「当前模型是 Nomi + 界面中文 + 提示语音开启 + 看板娘未静音」时播放。
 * 口型同步与打断复用 audioPlayback 的播放会话（AnalyserNode RMS → lipSyncStore）。
 */
import { createLogger, getLocale, t } from '@nomi-ai/ui';

import { isMascotMuted } from '../presence';

const log = createLogger('prompt-clips');

export const PROMPT_CLIP_BASE = './voice/nomi/zh/';
export const PROMPT_CLIP_MODEL = 'nomi';

/** 保留文字气泡、但不播放任何音频的台词 */
export const NO_AUDIO_KEYS: ReadonlySet<string> = new Set([
  'ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot',
  'ui.voice-mascot.ai-chat-requires-the-electron-environment',
]);

/** 带变量的台词：气泡显示完整文字，语音改播固定句 */
export const CLIP_HINTS = {
  modeFixed: 'ui.voice-mascot.switched-to-mode.fixed',
  modeTts: 'ui.voice-mascot.switched-to-mode.tts',
  openFailed: 'ui.voice-mascot.couldn-t-open',
  micFailed: 'ui.voice-mascot.couldn-t-open-the-microphone',
  reminder: 'ui.cli-monitor.reminder-time',
  missedReminders: 'ui.voice-mascot.you-missed-reminders-while-away',
} as const;

export interface PromptClipEntry {
  key: string;
  text: string;
  file: string;
  duration_s?: number;
}

interface Manifest {
  clips: PromptClipEntry[];
}

let manifest: Promise<Map<string, PromptClipEntry> | null> | null = null;
let promptVoiceCache: { value: boolean; at: number } | null = null;
const PROMPT_VOICE_TTL_MS = 3000;
const DEDUPE_MS = 1500;
let last: { key: string; at: number } | null = null;

function loadManifest(): Promise<Map<string, PromptClipEntry> | null> {
  if (!manifest) {
    manifest = (async () => {
      try {
        const res = await fetch(`${PROMPT_CLIP_BASE}manifest.json`);
        if (!res.ok) return null;
        const m = (await res.json()) as Manifest;
        return new Map((m.clips ?? []).map((c) => [c.key, c]));
      } catch (e) {
        log.warn('prompt clip manifest unavailable', e);
        return null;
      }
    })();
  }
  return manifest;
}

async function promptVoiceOn(): Promise<boolean> {
  const now = Date.now();
  if (promptVoiceCache && now - promptVoiceCache.at < PROMPT_VOICE_TTL_MS) {
    return promptVoiceCache.value;
  }
  let value = true; // 默认开
  try {
    const fn = typeof window !== 'undefined' ? window.electronAPI?.ttsPromptVoice : undefined;
    if (fn) value = (await fn()) !== false;
  } catch {
    /* keep default */
  }
  promptVoiceCache = { value, at: now };
  return value;
}

/** 预录片段是否适用于当前模型与界面语言（同步部分）。 */
export function promptClipsApplicable(modelName: string | null | undefined): boolean {
  return (
    (modelName ?? '').toLowerCase() === PROMPT_CLIP_MODEL &&
    getLocale() === 'zh-CN' &&
    !isMascotMuted()
  );
}

/**
 * 把 key 或已翻译的中文文本解析成清单里的片段 key。
 * 返回 null 表示没有片段（交给实时朗读或保持静默）。
 */
export function resolveClipKey(
  keyOrText: string,
  clips: Map<string, PromptClipEntry>,
): string | null {
  const s = keyOrText.trim();
  if (!s || NO_AUDIO_KEYS.has(s)) return null;
  if (clips.has(s)) return s;
  for (const k of NO_AUDIO_KEYS) if (t(k) === s) return null;
  for (const c of clips.values()) {
    if (c.text === s || t(c.key) === s) return c.key;
  }
  return null;
}

/** 这句是否明确不播音频（只显示气泡）。 */
export function isNoAudioLine(keyOrText: string): boolean {
  const s = keyOrText.trim();
  if (NO_AUDIO_KEYS.has(s)) return true;
  for (const k of NO_AUDIO_KEYS) if (t(k) === s) return true;
  return false;
}

export type PromptClipResult = 'played' | 'duplicate' | 'none';

export interface PlayPromptClipOptions {
  modelName: string | null | undefined;
  /** 优先使用的片段 key（变量台词） */
  clip?: string | null;
  volume?: number;
  onEnd?: () => void;
}

/**
 * 尝试播放预录片段。'played'：已开始播放；'duplicate'：同一句刚播过（气泡与朗读两条路径同时触发）；
 * 'none'：不适用 / 没有片段 / 播放失败，onEnd 不会被调用，由调用方继续兜底。
 */
export async function playPromptClip(
  keyOrText: string,
  opts: PlayPromptClipOptions,
): Promise<PromptClipResult> {
  if (opts.clip === null) return 'none';
  if (!promptClipsApplicable(opts.modelName)) return 'none';
  const clips = await loadManifest();
  if (!clips) return 'none';
  const key = opts.clip && clips.has(opts.clip) ? opts.clip : resolveClipKey(keyOrText, clips);
  if (!key) return 'none';
  if (!(await promptVoiceOn())) return 'none';
  if (!promptClipsApplicable(opts.modelName)) return 'none';
  const now = Date.now();
  if (last && last.key === key && now - last.at < DEDUPE_MS) {
    opts.onEnd?.();
    return 'duplicate';
  }
  last = { key, at: now };
  const entry = clips.get(key)!;
  const { playAudioClip } = await import('../tts/audioPlayback');
  const ok = await playAudioClip(`${PROMPT_CLIP_BASE}${entry.file}`, {
    volume: opts.volume,
    onEnd: opts.onEnd,
  });
  if (!ok) last = null;
  return ok ? 'played' : 'none';
}

/** 测试用：清空缓存 */
export function __resetPromptClipsForTests(): void {
  manifest = null;
  promptVoiceCache = null;
  last = null;
}
