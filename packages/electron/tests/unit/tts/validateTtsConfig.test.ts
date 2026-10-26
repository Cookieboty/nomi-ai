import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

import { normalizeTtsConfig, validateTtsConfig } from '../../../src/tts/fish/validateTtsConfig';

/** 代表旧 tts-config.json 里已移除的内置离线引擎 provider：任何未知值都按 none 处理 */
const REMOVED_OFFLINE_PROVIDER = 'offline-theresa-removed';

describe('validateTtsConfig', () => {
  it('accepts defaults: no realtime engine, prompt voice on', () => {
    const cfg = normalizeTtsConfig({ ...DEFAULT_TTS_CONFIG, lastModified: 1 });
    const v = validateTtsConfig(cfg);
    expect(v.isValid).toBe(true);
    expect(cfg.provider).toBe('none');
    expect(cfg.promptVoice).toBe(true);
    expect(cfg.referenceId).toBe('nomi');
  });

  it('defaults to none when no file / no provider; keeps explicit choices', () => {
    expect(normalizeTtsConfig(null).provider).toBe('none');
    expect(normalizeTtsConfig({}).provider).toBe('none');
    for (const p of ['edge', 'azure', 'openai'] as const) {
      expect(normalizeTtsConfig({ provider: p }).provider).toBe(p);
    }
    expect(normalizeTtsConfig({ provider: 'unknown-engine' } as any).provider).toBe('none');
    expect(normalizeTtsConfig({ provider: 'fish-local' }).provider).toBe('fish-local');
    expect(normalizeTtsConfig({ provider: 'fish-cloud' }).provider).toBe('fish-cloud');
  });

  it('old configs with the removed built-in engine start as none and drop its fields', () => {
    const cfg = normalizeTtsConfig({
      provider: REMOVED_OFFLINE_PROVIDER,
      oldEngineSid: 3,
      oldEngineSpeed: 1.2,
      enabled: true,
    } as any);
    expect(cfg.provider).toBe('none');
    expect(cfg).not.toHaveProperty('oldEngineSid');
    expect(cfg).not.toHaveProperty('oldEngineSpeed');
    expect(validateTtsConfig(cfg).isValid).toBe(true);
  });

  it('keeps promptVoice off when explicitly disabled', () => {
    expect(normalizeTtsConfig({ promptVoice: false }).promptVoice).toBe(false);
    expect(normalizeTtsConfig({ promptVoice: 'x' as any }).promptVoice).toBe(true);
  });

  it('rejects invalid fish baseUrl', () => {
    const cfg = normalizeTtsConfig({
      ...DEFAULT_TTS_CONFIG,
      provider: 'fish-local',
      baseUrl: 'not-a-url',
      lastModified: 1,
    });
    // normalize keeps the string; validate catches it
    cfg.baseUrl = 'not-a-url';
    const v = validateTtsConfig(cfg);
    expect(v.isValid).toBe(false);
    expect(v.errors.some((e) => /baseUrl/.test(e))).toBe(true);
  });

  it('requires legacy clone fields when provider=legacy', () => {
    const cfg = normalizeTtsConfig({
      enabled: true,
      provider: 'legacy',
      baseUrl: 'http://127.0.0.1:8080',
      referenceId: 'nomi',
      format: 'mp3',
      timeoutMs: 30000,
      hostname: '',
      port: 0,
      path: 'bad',
      audioUrl: '',
      promptText: '',
      lastModified: 1,
    });
    const v = validateTtsConfig(cfg);
    expect(v.isValid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('legacy system provider becomes none', () => {
    const cfg = normalizeTtsConfig({
      ...DEFAULT_TTS_CONFIG,
      provider: 'system',
      enabled: true,
      lastModified: 1,
    } as any);
    expect(cfg.provider).toBe('none');
    expect(validateTtsConfig(cfg).isValid).toBe(true);
  });

  it('infers legacy provider from classic filled fields', () => {
    const cfg = normalizeTtsConfig({
      enabled: true,
      hostname: 'example.com',
      port: 8443,
      path: '/voice_clone_direct',
      audioUrl: 'https://example.com/a.wav',
      promptText: 'hello',
    } as any);
    expect(cfg.provider).toBe('legacy');
  });
});
