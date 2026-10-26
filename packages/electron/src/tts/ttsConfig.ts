/**
 * TTS 配置归一化 / 校验（纯函数，无 Electron 依赖）。
 * 旧文件里的未知 provider（包括已移除的引擎）一律当作 none，不抛错；没有配置文件时默认 edge。
 */
import type { TTSConfig, TTSProvider } from '@nomi-ai/types';
import { DEFAULT_EDGE_VOICE, DEFAULT_TTS_CONFIG, DEFAULT_TTS_RATE } from '@nomi-ai/types';

import { VOICE_NAME_RE } from './edge/edgeProtocol';

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
    edgeVoice:
      typeof r.edgeVoice === 'string' && VOICE_NAME_RE.test(r.edgeVoice)
        ? r.edgeVoice
        : DEFAULT_EDGE_VOICE,
    // 统一语速（旧版 edgeRate / 角色语速不再读取：破坏性更新）
    rate:
      typeof r.rate === 'number' && Number.isFinite(r.rate)
        ? Math.round(Math.max(-50, Math.min(50, r.rate)))
        : DEFAULT_TTS_RATE,
    readReplies: r.readReplies !== false,
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
  if (c.edgeVoice != null && (typeof c.edgeVoice !== 'string' || !VOICE_NAME_RE.test(c.edgeVoice)))
    errors.push('edgeVoice must be a voice short name like zh-CN-XiaoyiNeural');
  if (
    c.rate != null &&
    (typeof c.rate !== 'number' || !Number.isFinite(c.rate) || Math.abs(c.rate) > 50)
  )
    errors.push('rate must be a number between -50 and 50');
  if (c.readReplies != null && typeof c.readReplies !== 'boolean')
    errors.push('readReplies must be boolean');
  return { isValid: errors.length === 0, errors };
}
