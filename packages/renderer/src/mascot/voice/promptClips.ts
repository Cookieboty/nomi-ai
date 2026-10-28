/**
 * 角色提示语音：固定台词的预录音频（public/voice/<id>/<locale>）。
 *
 * 播放顺序：预录片段 → 已配置的实时朗读引擎 → 仅气泡。
 * 只在「当前模型是活动角色 + 界面中文 + 提示语音开启 + 看板娘未静音」时播放。
 * 口型同步与打断复用 audioPlayback 的播放会话（AnalyserNode RMS → lipSyncStore）。
 *
 * Clip ids are name-agnostic (stable-v1). Manifest entries expose id + i18nKey;
 * legacy i18n keys resolve for one release via legacyClipIds.json.
 */
import { createLogger, getLocale, t } from '@nomi-ai/ui';

import { api, hasTransport } from '../../services/api';
import {
  ensureCharacterPackOverlay,
  getCharacterId,
  getPromptClipBase,
  isActivePackModel,
} from '../characterConfig';
import { isMascotMuted } from '../presence';

import legacyMap from './legacyClipIds.json';

const log = createLogger('prompt-clips');

/** @deprecated Prefer getPromptClipBase(); kept for tests / callers. */
export const PROMPT_CLIP_BASE = getPromptClipBase();
/** @deprecated Prefer getCharacterId(); default remains nomi for official builds. */
export const PROMPT_CLIP_MODEL = getCharacterId();

/** 保留文字气泡、但不播放任何音频的台词（i18n keys） */
export const NO_AUDIO_KEYS: ReadonlySet<string> = new Set([
  'ui.voice-mascot.canvas-not-found-can-t-take-a-screenshot',
  'ui.voice-mascot.ai-chat-requires-the-electron-environment',
]);

/** 带变量的台词：气泡显示完整文字，语音改播固定句（stable clip ids） */
export const CLIP_HINTS = {
  modeFixed: 'mode-fixed',
  modeTts: 'mode-tts',
  openFailed: 'err-couldnt-open',
  micFailed: 'err-mic-open',
  reminder: 'remind-time',
  missedReminders: 'remind-missed',
} as const;

export interface PromptClipEntry {
  /** Stable name-agnostic id (preferred lookup key). */
  id?: string;
  /** Manifest primary key; equals id under stable-v1. */
  key: string;
  /** Original i18n key for bubble text / legacy callers. */
  i18nKey?: string;
  text: string;
  file: string;
  duration_s?: number;
}

interface Manifest {
  idSchema?: string;
  clips: PromptClipEntry[];
}

type ClipIndex = Map<string, PromptClipEntry>;

let manifest: Promise<ClipIndex | null> | null = null;
let promptVoiceCache: { value: boolean; at: number } | null = null;
const PROMPT_VOICE_TTL_MS = 3000;
const DEDUPE_MS = 1500;
let last: { key: string; at: number } | null = null;

const LEGACY_TO_ID = (legacyMap as { byLegacyKey: Record<string, string> }).byLegacyKey;

function indexClips(clips: PromptClipEntry[]): ClipIndex {
  const map: ClipIndex = new Map();
  const add = (k: string | undefined, c: PromptClipEntry) => {
    if (k && !map.has(k)) map.set(k, c);
  };
  for (const c of clips) {
    const id = c.id || c.key;
    add(id, c);
    add(c.key, c);
    add(c.i18nKey, c);
  }
  // One-release legacy aliases → same entry
  for (const [legacy, id] of Object.entries(LEGACY_TO_ID)) {
    const entry = map.get(id);
    if (entry) add(legacy, entry);
  }
  return map;
}

function loadManifest(): Promise<ClipIndex | null> {
  if (!manifest) {
    manifest = (async () => {
      try {
        // The cached index must match the base clips are played from — wait for the overlay.
        await ensureCharacterPackOverlay();
        const res = await fetch(`${getPromptClipBase()}manifest.json`);
        if (!res.ok) return null;
        const m = (await res.json()) as Manifest;
        return indexClips(m.clips ?? []);
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
    if (hasTransport()) value = (await api.tts.promptVoice()) !== false;
  } catch {
    /* keep default */
  }
  promptVoiceCache = { value, at: now };
  return value;
}

/** 预录片段是否适用于当前模型与界面语言（同步部分）。 */
export function promptClipsApplicable(modelName: string | null | undefined): boolean {
  return isActivePackModel(modelName) && getLocale() === 'zh-CN' && !isMascotMuted();
}

/**
 * 把 key / stable id / 已翻译的中文文本解析成清单里的片段 id。
 * 返回 null 表示没有片段（交给实时朗读或保持静默）。
 */
export function resolveClipKey(keyOrText: string, clips: ClipIndex): string | null {
  const s = keyOrText.trim();
  if (!s || NO_AUDIO_KEYS.has(s)) return null;
  const direct = clips.get(s);
  if (direct) return direct.id || direct.key;
  const viaLegacy = LEGACY_TO_ID[s];
  if (viaLegacy && clips.has(viaLegacy)) return viaLegacy;
  for (const k of NO_AUDIO_KEYS) if (t(k) === s) return null;
  for (const c of clips.values()) {
    const i18n = c.i18nKey || c.key;
    if (c.text === s || t(i18n) === s) return c.id || c.key;
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
  /** 优先使用的片段 id / key（变量台词） */
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
  let key: string | null = null;
  if (opts.clip) {
    const hinted = clips.get(opts.clip) || clips.get(LEGACY_TO_ID[opts.clip] || '');
    if (hinted) key = hinted.id || hinted.key;
  }
  if (!key) key = resolveClipKey(keyOrText, clips);
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
  const ok = await playAudioClip(`${getPromptClipBase()}${entry.file}`, {
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
