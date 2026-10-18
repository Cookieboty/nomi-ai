/**
 * TTS config validation (shared by IPC save + unit tests). Pure, no Electron.
 */

import type { TTSConfig, TTSProvider } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

const PROVIDERS: TTSProvider[] = ['sherpa-theresa', 'fish-local', 'fish-cloud', 'legacy'];
const SHERPA_MAX_SID = 803;
const SHERPA_SPEED_MIN = 0.5;
const SHERPA_SPEED_MAX = 1.5;
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

  return {
    ...base,
    ...raw,
    provider,
    sherpaSid:
      typeof raw.sherpaSid === 'number' &&
      Number.isInteger(raw.sherpaSid) &&
      raw.sherpaSid >= 0 &&
      raw.sherpaSid <= SHERPA_MAX_SID
        ? raw.sherpaSid
        : (base.sherpaSid ?? 0),
    sherpaSpeed:
      typeof raw.sherpaSpeed === 'number' &&
      raw.sherpaSpeed >= SHERPA_SPEED_MIN &&
      raw.sherpaSpeed <= SHERPA_SPEED_MAX
        ? raw.sherpaSpeed
        : (base.sherpaSpeed ?? 1),
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
  // Legacy files without provider: if classic clone fields look filled → legacy; else product default
  if (raw.hostname && raw.port && raw.path && raw.audioUrl && raw.promptText) {
    return 'legacy';
  }
  return DEFAULT_TTS_CONFIG.provider;
}

/**
 * Pre-sherpa product default was fish-local + nomi @ 127.0.0.1:8080.
 * Untouched copies of that default should move to sherpa-theresa so `pnpm dev`
 * is not stuck on Fish (unreachable → silent TTS on many Linux setups).
 * Custom Fish baseUrl / referenceId / cloud are left alone.
 */
export function isLegacyFishProductDefault(raw: Partial<TTSConfig> | null | undefined): boolean {
  if (!raw || raw.provider !== 'fish-local') return false;
  const base = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/$/, '') : '';
  if (base && base !== 'http://127.0.0.1:8080' && base !== 'http://localhost:8080') return false;
  const ref = typeof raw.referenceId === 'string' ? raw.referenceId.trim() : '';
  if (ref && ref !== 'nomi') return false;
  if (raw.format != null && raw.format !== 'mp3') return false;
  return true;
}

/** Apply one-shot provider migration; returns whether provider changed. */
export function migrateTtsConfigProvider(raw: Partial<TTSConfig> | null | undefined): {
  config: TTSConfig;
  migrated: boolean;
} {
  const config = normalizeTtsConfig(raw);
  if (isLegacyFishProductDefault(raw)) {
    return { config: { ...config, provider: 'sherpa-theresa' }, migrated: true };
  }
  return { config, migrated: false };
}

export function validateTtsConfig(config: TTSConfig): TtsValidation {
  const errors: string[] = [];

  if (typeof config.enabled !== 'boolean') {
    errors.push('enabled must be boolean');
  }
  if (!PROVIDERS.includes(config.provider)) {
    errors.push('provider must be sherpa-theresa | fish-local | fish-cloud | legacy');
  }

  if (config.provider === 'sherpa-theresa') {
    if (
      config.sherpaSid != null &&
      (!Number.isInteger(config.sherpaSid) ||
        config.sherpaSid < 0 ||
        config.sherpaSid > SHERPA_MAX_SID)
    ) {
      errors.push(`sherpaSid must be an integer 0–${SHERPA_MAX_SID}`);
    }
    if (
      config.sherpaSpeed != null &&
      (typeof config.sherpaSpeed !== 'number' ||
        config.sherpaSpeed < SHERPA_SPEED_MIN ||
        config.sherpaSpeed > SHERPA_SPEED_MAX)
    ) {
      errors.push(`sherpaSpeed must be ${SHERPA_SPEED_MIN}–${SHERPA_SPEED_MAX}`);
    }
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

  // system: no extra fields required
  return { isValid: errors.length === 0, errors };
}
