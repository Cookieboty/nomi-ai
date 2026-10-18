import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

import {
  isLegacyFishProductDefault,
  migrateTtsConfigProvider,
  normalizeTtsConfig,
  validateTtsConfig,
} from '../../../src/tts/fish/validateTtsConfig';

describe('validateTtsConfig', () => {
  it('accepts built-in sherpa defaults (sid 0, speed 1.0)', () => {
    const cfg = normalizeTtsConfig({ ...DEFAULT_TTS_CONFIG, lastModified: 1 });
    const v = validateTtsConfig(cfg);
    expect(v.isValid).toBe(true);
    expect(cfg.provider).toBe('sherpa-theresa');
    expect(cfg.sherpaSid).toBe(0);
    expect(cfg.sherpaSpeed).toBe(1.0);
    expect(cfg.referenceId).toBe('nomi');
  });

  it('defaults to sherpa when no file / no provider; keeps explicit Fish choice', () => {
    expect(normalizeTtsConfig(null).provider).toBe('sherpa-theresa');
    expect(normalizeTtsConfig({}).provider).toBe('sherpa-theresa');
    expect(normalizeTtsConfig({ provider: 'fish-local' }).provider).toBe('fish-local');
    expect(normalizeTtsConfig({ provider: 'fish-cloud' }).provider).toBe('fish-cloud');
  });

  it('sanitizes sherpa sid / speed and validates ranges', () => {
    const cfg = normalizeTtsConfig({ sherpaSid: -1, sherpaSpeed: 9 });
    expect(cfg.sherpaSid).toBe(0);
    expect(cfg.sherpaSpeed).toBe(1.0);
    expect(normalizeTtsConfig({ sherpaSid: 5, sherpaSpeed: 1.2 })).toMatchObject({
      sherpaSid: 5,
      sherpaSpeed: 1.2,
    });
    const bad = { ...cfg, sherpaSid: 1000 };
    expect(validateTtsConfig(bad).errors.some((e) => /sherpaSid/.test(e))).toBe(true);
    expect(
      validateTtsConfig({ ...cfg, sherpaSpeed: 3 }).errors.some((e) => /sherpaSpeed/.test(e)),
    ).toBe(true);
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

  it('legacy system provider is migrated to the local TTS default', () => {
    const cfg = normalizeTtsConfig({
      ...DEFAULT_TTS_CONFIG,
      provider: 'system',
      enabled: true,
      lastModified: 1,
    } as any);
    expect(cfg.provider).toBe('sherpa-theresa');
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

  it('migrates untouched fish-local product default to sherpa-theresa', () => {
    expect(
      isLegacyFishProductDefault({
        provider: 'fish-local',
        baseUrl: 'http://127.0.0.1:8080',
        referenceId: 'nomi',
        format: 'mp3',
      }),
    ).toBe(true);
    expect(
      isLegacyFishProductDefault({
        provider: 'fish-local',
        baseUrl: 'http://192.168.1.5:8080',
        referenceId: 'nomi',
      }),
    ).toBe(false);
    const { config, migrated } = migrateTtsConfigProvider({
      provider: 'fish-local',
      baseUrl: 'http://127.0.0.1:8080/',
      referenceId: 'nomi',
    });
    expect(migrated).toBe(true);
    expect(config.provider).toBe('sherpa-theresa');
    expect(migrateTtsConfigProvider({ provider: 'fish-cloud' }).migrated).toBe(false);
    expect(migrateTtsConfigProvider({ provider: 'sherpa-theresa' }).migrated).toBe(false);
  });
});
