/**
 * TTS config validation (shared by IPC save + unit tests). Pure, no Electron.
 */

import type { TTSConfig, TTSProvider } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

const PROVIDERS: TTSProvider[] = [
  'none',
  'edge',
  'azure',
  'openai',
  'fish-local',
  'fish-cloud',
  'legacy',
];
const FORMATS = ['mp3', 'wav', 'opus', 'pcm'] as const;

export interface TtsValidation {
  isValid: boolean;
  errors: string[];
}

export function normalizeTtsConfig(raw: Partial<TTSConfig> | null | undefined): TTSConfig {
  const base = { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
  if (!raw || typeof raw !== 'object') return base;

  const provider = PROVIDERS.includes(raw.provider as TTSProvider)
    ? (raw.provider as TTSProvider)
    : inferProvider(raw);

  // 只保留已知字段：旧版本里已移除引擎的私有字段等直接丢弃
  const passThrough: Partial<TTSConfig> = {};
  if (raw.apiKey !== undefined) passThrough.apiKey = raw.apiKey;
  if (raw.hasApiKey !== undefined) passThrough.hasApiKey = raw.hasApiKey;
  if (raw.clearApiKey !== undefined) passThrough.clearApiKey = raw.clearApiKey;
  return {
    ...base,
    ...passThrough,
    provider,
    promptVoice: raw.promptVoice !== false,
    enabled: raw.enabled !== false,
    baseUrl:
      typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : base.baseUrl,
    referenceId:
      typeof raw.referenceId === 'string' && raw.referenceId.trim()
        ? raw.referenceId.trim()
        : base.referenceId,
    format: FORMATS.includes(raw.format as (typeof FORMATS)[number])
      ? (raw.format as TTSConfig['format'])
      : base.format,
    timeoutMs:
      typeof raw.timeoutMs === 'number' && raw.timeoutMs >= 1000 && raw.timeoutMs <= 120000
        ? raw.timeoutMs
        : base.timeoutMs,
    cloudModel: typeof raw.cloudModel === 'string' ? raw.cloudModel : base.cloudModel,
    hostname: typeof raw.hostname === 'string' ? raw.hostname : base.hostname,
    port: typeof raw.port === 'number' ? raw.port : base.port,
    path: typeof raw.path === 'string' ? raw.path : base.path,
    audioUrl: typeof raw.audioUrl === 'string' ? raw.audioUrl : base.audioUrl,
    promptText: typeof raw.promptText === 'string' ? raw.promptText : base.promptText,
    lastModified: typeof raw.lastModified === 'number' ? raw.lastModified : 0,
  };
}

function inferProvider(raw: Partial<TTSConfig>): TTSProvider {
  // 旧文件：没有 provider 且经典克隆字段齐全 → legacy；其余（含已移除的内置离线引擎）→ none
  if (
    raw.provider === undefined &&
    raw.hostname &&
    raw.port &&
    raw.path &&
    raw.audioUrl &&
    raw.promptText
  ) {
    return 'legacy';
  }
  return 'none';
}

export function validateTtsConfig(config: TTSConfig): TtsValidation {
  const errors: string[] = [];

  if (typeof config.enabled !== 'boolean') {
    errors.push('enabled must be boolean');
  }
  if (!PROVIDERS.includes(config.provider)) {
    errors.push('provider must be none | edge | azure | openai | fish-local | fish-cloud | legacy');
  }

  if (config.promptVoice != null && typeof config.promptVoice !== 'boolean') {
    errors.push('promptVoice must be boolean');
  }

  if (config.provider === 'fish-local' || config.provider === 'fish-cloud') {
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      errors.push('baseUrl is required for Fish providers');
    } else {
      try {
        const u = new URL(config.baseUrl);
        if (!['http:', 'https:'].includes(u.protocol)) {
          errors.push('baseUrl must be http(s)');
        }
      } catch {
        errors.push('baseUrl is not a valid URL');
      }
    }
    if (config.referenceId != null && typeof config.referenceId !== 'string') {
      errors.push('referenceId must be a string');
    }
    if (config.referenceId && !/^[a-zA-Z0-9\-_ ]{1,255}$/.test(config.referenceId)) {
      errors.push('referenceId has invalid characters');
    }
    if (!FORMATS.includes(config.format as (typeof FORMATS)[number])) {
      errors.push('format must be mp3|wav|opus|pcm');
    }
    if (
      typeof config.timeoutMs !== 'number' ||
      config.timeoutMs < 1000 ||
      config.timeoutMs > 120000
    ) {
      errors.push('timeoutMs must be 1000–120000');
    }
  }

  if (config.provider === 'legacy') {
    if (!config.hostname || typeof config.hostname !== 'string' || !config.hostname.trim()) {
      errors.push('hostname is required for legacy TTS');
    }
    if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
      errors.push('port must be 1–65535 for legacy TTS');
    }
    if (!config.path || typeof config.path !== 'string' || !config.path.startsWith('/')) {
      errors.push('path must start with / for legacy TTS');
    }
    if (!config.audioUrl || typeof config.audioUrl !== 'string') {
      errors.push('audioUrl is required for legacy TTS');
    } else {
      try {
        const url = new URL(config.audioUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('audioUrl must be http(s)');
        }
      } catch {
        errors.push('audioUrl is invalid');
      }
    }
    if (!config.promptText || typeof config.promptText !== 'string' || !config.promptText.trim()) {
      errors.push('promptText is required for legacy TTS');
    } else if (config.promptText.length > 500) {
      errors.push('promptText must be ≤500 chars');
    }
  }

  return { isValid: errors.length === 0, errors };
}
