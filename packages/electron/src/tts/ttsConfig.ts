/**
 * TTS 配置归一化 / 校验（纯函数，无 Electron 依赖）。
 * 旧文件里的未知 provider（包括已移除的引擎）一律当作 none，不抛错。
 */
import type { TTSConfig, TTSProvider } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

export const TTS_PROVIDERS: readonly TTSProvider[] = ['none', 'edge', 'azure', 'openai'];

export function normalizeTtsConfig(raw: unknown): TTSConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...DEFAULT_TTS_CONFIG,
    enabled: r.enabled !== false,
    promptVoice: r.promptVoice !== false,
    provider: TTS_PROVIDERS.includes(r.provider as TTSProvider)
      ? (r.provider as TTSProvider)
      : 'none',
    lastModified: typeof r.lastModified === 'number' ? r.lastModified : 0,
  };
}

export function validateTtsConfig(config: unknown): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  if (!TTS_PROVIDERS.includes(c.provider as TTSProvider))
    errors.push(`provider must be one of ${TTS_PROVIDERS.join(', ')}`);
  if (c.enabled != null && typeof c.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (c.promptVoice != null && typeof c.promptVoice !== 'boolean')
    errors.push('promptVoice must be boolean');
  return { isValid: errors.length === 0, errors };
}
