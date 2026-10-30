/**
 * Chinese voice list for the settings picker: fetched from the read-aloud voices endpoint,
 * cached for the session; a small built-in list is used when the request fails.
 */
import type { TTSVoice } from '@nomi-ai/types';

import { httpHeaders, voicesUrl, VOICE_NAME_RE } from './edgeProtocol';
import { nowSeconds } from './secMsGec';

export const BUILTIN_ZH_VOICES: readonly TTSVoice[] = [
  { shortName: 'zh-CN-XiaoyiNeural', locale: 'zh-CN', gender: 'Female' },
  { shortName: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female' },
  { shortName: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male' },
  { shortName: 'zh-CN-YunjianNeural', locale: 'zh-CN', gender: 'Male' },
  { shortName: 'zh-CN-YunyangNeural', locale: 'zh-CN', gender: 'Male' },
  { shortName: 'zh-CN-YunxiaNeural', locale: 'zh-CN', gender: 'Male' },
  { shortName: 'zh-TW-HsiaoChenNeural', locale: 'zh-TW', gender: 'Female' },
  { shortName: 'zh-HK-HiuGaaiNeural', locale: 'zh-HK', gender: 'Female' },
];

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface VoiceList {
  voices: TTSVoice[];
  source: 'online' | 'builtin';
}

let cache: TTSVoice[] | null = null;

export function clearVoiceCacheForTests(): void {
  cache = null;
}

export async function listChineseVoices(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 8000,
): Promise<VoiceList> {
  if (cache) return { voices: cache, source: 'online' };
  try {
    const res = await fetchImpl(voicesUrl(nowSeconds()), {
      headers: httpHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('unexpected voice list');
    const voices = raw
      .map((v) => v as Record<string, unknown>)
      .filter((v) => typeof v.ShortName === 'string' && /^zh-/.test(v.ShortName as string))
      .filter((v) => VOICE_NAME_RE.test(v.ShortName as string))
      .map((v) => ({
        shortName: v.ShortName as string,
        locale: typeof v.Locale === 'string' ? v.Locale : (v.ShortName as string).slice(0, 5),
        gender: typeof v.Gender === 'string' ? v.Gender : undefined,
        name: typeof v.FriendlyName === 'string' ? v.FriendlyName : undefined,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale) || a.shortName.localeCompare(b.shortName));
    if (!voices.length) throw new Error('no chinese voices');
    cache = voices;
    return { voices, source: 'online' };
  } catch {
    return { voices: [...BUILTIN_ZH_VOICES], source: 'builtin' };
  }
}
