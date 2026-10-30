/**
 * 朗读 AI 回复：对话窗口发来的整句（tts:reply）→ 看板娘窗口的 mascot.command。
 * 纯函数：是否转发由配置决定（引擎可用 + 开关打开）；stop 总是转发，CD_TTS=off 时一律不转发。
 */
import type { TTSConfig } from '@nomi-ai/types';

export type ReplySpeechCommand =
  | { type: 'reply-speech'; op: 'say'; id: string; text: string }
  | { type: 'reply-speech'; op: 'end'; id: string }
  | { type: 'reply-speech'; op: 'stop'; id?: string };

/** 引擎能朗读 AI 回复：已启用、选了已接入的引擎（目前只有 edge）、开关没关 */
export function canReadReplies(cfg: TTSConfig | null | undefined): boolean {
  return !!cfg && cfg.enabled !== false && cfg.provider === 'edge' && cfg.readReplies !== false;
}

export function replySpeechCommand(
  raw: unknown,
  cfg: TTSConfig | null | undefined,
  env: Record<string, string | undefined> = {},
): ReplySpeechCommand | null {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.slice(0, 80) : undefined;
  if (m.op === 'stop') return { type: 'reply-speech', op: 'stop', ...(id ? { id } : {}) };
  if (env.CD_TTS === 'off' || !id || !canReadReplies(cfg)) return null;
  if (m.op === 'end') return { type: 'reply-speech', op: 'end', id };
  if (m.op === 'say' && typeof m.text === 'string' && m.text.trim())
    return { type: 'reply-speech', op: 'say', id, text: m.text.slice(0, 600) };
  return null;
}
