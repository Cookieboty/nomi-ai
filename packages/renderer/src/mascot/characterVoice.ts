/**
 * Per-character voice binding (rate / volume).
 * Merge order: global soft prefs → built-in character defaults → model.config.voice → user override.
 * Overrides persist in localStorage.
 */
import type { ModelConfig, ModelVoiceConfig } from '@nomi-ai/types';

import { BUNDLED_PACK, isActivePackModel } from './characterConfig';
import { bubbleText } from './characterCopy';
import { isMascotMuted } from './presence';
import {
  DEFAULT_SOFT_SPEECH,
  loadSoftSpeechPrefs,
  saveSoftSpeechPrefs,
  type SoftSpeechPrefs,
  type SpeakSoftOptions,
} from './softSpeech';
import { isNoAudioLine, playPromptClip } from './voice/promptClips';

const OVERRIDE_KEY = 'mascot.characterVoice.v1';

/**
 * Built-in softer defaults keyed by the bundled pack id (manifest.defaults). Keyed statically —
 * the Scheme B overlay settles asynchronously; lookups go through isActivePackModel instead.
 */
const PACK_ID = BUNDLED_PACK.id;
export const CHARACTER_VOICE_DEFAULTS: Record<string, ModelVoiceConfig> = {
  [PACK_ID]: {
    voiceHint: BUNDLED_PACK.defaults.voiceHint || 'xiaoxiao',
    rate: BUNDLED_PACK.defaults.voiceRate ?? 0.92,
    pitch: BUNDLED_PACK.defaults.voicePitch ?? 1.1,
  },
};

/** fallbacks for user-imported / store models (no bundled defaults besides Nomi) */
export const SOFT_2D_VOICE: ModelVoiceConfig = { voiceHint: 'xiaoxiao', rate: 0.9, pitch: 1.08 };
export const GENERIC_VOICE: ModelVoiceConfig = { voiceHint: 'xiaoxiao', rate: 0.88, pitch: 1.06 };

type OverrideMap = Record<string, ModelVoiceConfig>;

let activeModelName: string | null = null;
let activeModelConfig: ModelConfig | undefined;

/** 当前看板娘模型名（角色提示语音据此判断是否适用） */
export function getActiveModelName(): string | null {
  return activeModelName;
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function readOverrides(): OverrideMap {
  try {
    const raw = JSON.parse(storage()?.getItem(OVERRIDE_KEY) ?? '{}') as OverrideMap;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeOverrides(map: OverrideMap): void {
  try {
    storage()?.setItem(OVERRIDE_KEY, JSON.stringify(map));
  } catch {
    /* private mode */
  }
}

export function setActiveCharacter(modelName: string | null, config?: ModelConfig): void {
  activeModelName = modelName;
  activeModelConfig = config;
}

export function getActiveCharacter(): { name: string | null; config?: ModelConfig } {
  return { name: activeModelName, config: activeModelConfig };
}

export function defaultsForCharacter(
  modelName: string | null | undefined,
  tags?: string[],
): ModelVoiceConfig {
  if (modelName && CHARACTER_VOICE_DEFAULTS[modelName])
    return { ...CHARACTER_VOICE_DEFAULTS[modelName] };
  if (isActivePackModel(modelName)) return { ...CHARACTER_VOICE_DEFAULTS[PACK_ID] };
  if (tags?.includes('sprite') || tags?.includes('soft') || tags?.includes('2d'))
    return { ...SOFT_2D_VOICE };
  return { ...GENERIC_VOICE };
}

export function getCharacterVoiceOverride(modelName: string): ModelVoiceConfig | undefined {
  const v = readOverrides()[modelName];
  return v && typeof v === 'object' ? { ...v } : undefined;
}

/** Merge voice binding for a character (no speech prefs preferNeural/volume). */
export function resolveCharacterVoice(
  modelName: string | null,
  modelConfig?: ModelConfig,
  tags?: string[],
): ModelVoiceConfig {
  const base = defaultsForCharacter(modelName, tags);
  const fromConfig = modelConfig?.voice ?? {};
  const override = modelName ? (getCharacterVoiceOverride(modelName) ?? {}) : {};
  return { ...base, ...fromConfig, ...override };
}

/** Resolve full SoftSpeechPrefs for the active (or named) character. */
export function resolvePrefsForCharacter(
  modelName: string | null = activeModelName,
  modelConfig: ModelConfig | undefined = activeModelConfig,
  tags?: string[],
): SoftSpeechPrefs {
  const global = loadSoftSpeechPrefs();
  const voice = resolveCharacterVoice(modelName, modelConfig, tags);
  const prefs: SoftSpeechPrefs = {
    ...global,
    voiceURI: voice.voiceURI ?? '',
    rate: voice.rate ?? global.rate,
    pitch: voice.pitch ?? global.pitch,
  };
  return prefs;
}

export function speakForActiveCharacter(key: string, opts: SpeakSoftOptions = {}): boolean {
  // 模块常量里的台词（提示音 / 触摸反应 / 整点报时）存的是 key，朗读前晚翻译；普通文本原样返回
  const text = bubbleText(key);
  if (!text) {
    opts.onEnd?.();
    return false;
  }
  // 看板娘已关闭：不再播放语音
  if (isMascotMuted()) {
    opts.onEnd?.();
    return false;
  }
  const prefs = resolvePrefsForCharacter();
  const merged = opts.prefs ? { ...prefs, ...opts.prefs } : prefs;

  // 保留文字、不播音频的台词
  if (isNoAudioLine(key)) {
    opts.onEnd?.();
    return false;
  }

  // 顺序：角色预录片段 → 已配置的实时朗读引擎 → 静默（只剩气泡）
  void (async () => {
    try {
      const clip = await playPromptClip(key, {
        modelName: activeModelName,
        clip: opts.clip,
        volume: merged.volume,
        onEnd: opts.onEnd,
      });
      if (clip !== 'none') return;
      const { speakRealtime } = await import('./tts/audioPlayback');
      await speakRealtime(text, {
        volume: merged.volume,
        onEnd: opts.onEnd,
      });
    } catch {
      // Keep the cue state consistent if the TTS module itself cannot load.
      opts.onEnd?.();
    }
  })();
  return true;
}

/**
 * Save per-character override. Also patches model.config via Electron when possible.
 * Returns the merged voice config for that character.
 */
export async function saveCharacterVoice(
  modelName: string,
  patch: ModelVoiceConfig,
  currentConfig?: ModelConfig,
): Promise<ModelVoiceConfig> {
  const map = readOverrides();
  const merged: ModelVoiceConfig = { ...(map[modelName] ?? {}), ...patch };
  // Drop empty strings
  if (merged.voiceURI === '') delete merged.voiceURI;
  if (merged.voiceHint === '') delete merged.voiceHint;
  map[modelName] = merged;
  writeOverrides(map);

  const nextConfig: ModelConfig = {
    ...(currentConfig ?? activeModelConfig ?? {}),
    voice: resolveCharacterVoice(modelName, { ...(currentConfig ?? {}), voice: merged }),
  };
  if (activeModelName === modelName) activeModelConfig = nextConfig;
  return nextConfig.voice ?? merged;
}

export function clearCharacterVoiceOverride(modelName: string): void {
  const map = readOverrides();
  delete map[modelName];
  writeOverrides(map);
}

// Keep the preference types available to existing settings integrations.
export { saveSoftSpeechPrefs, loadSoftSpeechPrefs, DEFAULT_SOFT_SPEECH };
export type { SoftSpeechPrefs, SpeakSoftOptions };
