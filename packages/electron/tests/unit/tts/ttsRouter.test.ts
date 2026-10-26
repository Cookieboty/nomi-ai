import { DEFAULT_TTS_CONFIG, type TTSConfig, type TTSSpeakResult } from '@nomi-ai/types';

import { TtsRouter, applyTtsEnvOverride, selectEngine } from '../../../src/tts/ttsRouter';

/** 代表旧 tts-config.json 里已移除的内置离线引擎 provider：任何未知值都按 none 处理 */
const REMOVED_OFFLINE_PROVIDER = 'offline-theresa-removed';

const cfg = (patch: Partial<TTSConfig> = {}): TTSConfig => ({
  ...DEFAULT_TTS_CONFIG,
  lastModified: 1,
  ...patch,
});

const ok = (): TTSSpeakResult => ({
  success: true,
  via: 'fish',
  audioBase64: Buffer.from('fish').toString('base64'),
  mimeType: 'audio/mpeg',
  fallbackToSystem: false,
});

function setup(config: TTSConfig) {
  const fish = { speak: jest.fn(async () => ok()) };
  const router = new TtsRouter({ getConfig: () => config, fish });
  return { router, fish };
}

describe('selectEngine', () => {
  it('defaults to none (AI replies are text only)', () => {
    expect(DEFAULT_TTS_CONFIG.provider).toBe('none');
    expect(selectEngine(cfg())).toBe('none');
  });

  it('maps every provider', () => {
    expect(selectEngine(cfg({ provider: 'fish-local' }))).toBe('fish');
    expect(selectEngine(cfg({ provider: 'fish-cloud' }))).toBe('fish');
    expect(selectEngine(cfg({ provider: 'legacy' }))).toBe('legacy');
    for (const p of ['edge', 'azure', 'openai'] as const) {
      expect(selectEngine(cfg({ provider: p }))).toBe('none');
    }
    expect(selectEngine(cfg({ provider: 'fish-local', enabled: false }))).toBe('none');
    expect(selectEngine({ enabled: true, provider: REMOVED_OFFLINE_PROVIDER as never })).toBe(
      'none',
    );
  });
});

describe('TtsRouter.speak', () => {
  it('none → silent, no engine called', async () => {
    const { router, fish } = setup(cfg());
    const r = await router.speak({ text: '你好' });
    expect(r).toMatchObject({ success: false, via: 'none', fallbackToSystem: false });
    expect(r.message).toMatch(/no realtime TTS engine/);
    expect(fish.speak).not.toHaveBeenCalled();
  });

  it('edge / azure / openai are not wired yet → silent', async () => {
    for (const p of ['edge', 'azure', 'openai'] as const) {
      const { router, fish } = setup(cfg({ provider: p }));
      const r = await router.speak({ text: '你好' });
      expect(r).toMatchObject({ success: false, via: 'none', fallbackToSystem: false });
      expect(r.message).toMatch(/not implemented/);
      expect(fish.speak).not.toHaveBeenCalled();
    }
  });

  it('routes Fish providers to Fish with trimmed text; failure / throw stays silent', async () => {
    const { router, fish } = setup(cfg({ provider: 'fish-local' }));
    const r = await router.speak({ text: ' 你好 ', referenceId: 'nomi' });
    expect(r.via).toBe('fish');
    expect(fish.speak).toHaveBeenCalledWith({ text: '你好', referenceId: 'nomi' });
    fish.speak.mockResolvedValueOnce({
      success: false,
      via: 'none',
      fallbackToSystem: false,
      message: 'Fish TTS unreachable',
    });
    const r2 = await router.speak({ text: '你好' });
    expect(r2).toMatchObject({ success: false, via: 'none', message: 'Fish TTS unreachable' });
    fish.speak.mockRejectedValueOnce(new Error('boom'));
    const r3 = await router.speak({ text: '你好' });
    expect(r3).toMatchObject({ success: false, via: 'none', message: 'boom' });
  });

  it('disabled / legacy / empty text never synthesize', async () => {
    for (const patch of [
      { enabled: false, provider: 'fish-local' as const },
      { provider: 'legacy' as const },
    ]) {
      const { router, fish } = setup(cfg(patch));
      const r = await router.speak({ text: '你好' });
      expect(r.success).toBe(false);
      expect(r.fallbackToSystem).toBe(false);
      expect(fish.speak).not.toHaveBeenCalled();
    }
    const { router, fish } = setup(cfg({ provider: 'fish-local' }));
    expect((await router.speak({ text: '   ' })).fallbackToSystem).toBe(false);
    expect(fish.speak).not.toHaveBeenCalled();
  });

  describe('per-request outcome log + timeout', () => {
    it('reports success / fallback with provider, exactly once each', async () => {
      const onOutcome = jest.fn();
      const fish = { speak: jest.fn() };
      const router = new TtsRouter({
        getConfig: () => cfg({ provider: 'fish-cloud' }),
        fish,
        onOutcome,
      });
      fish.speak.mockResolvedValueOnce(ok());
      await router.speak({ text: '你好' });
      fish.speak.mockResolvedValueOnce({ success: false, via: 'none', message: 'HTTP 401' });
      await router.speak({ text: '你好' });
      await router.speak({ text: '  ' });
      expect(onOutcome).toHaveBeenCalledTimes(3);
      expect(onOutcome.mock.calls[0]![0]).toMatchObject({
        outcome: 'success',
        provider: 'fish-cloud',
        via: 'fish',
      });
      expect(onOutcome.mock.calls[1]![0]).toMatchObject({
        outcome: 'fallback',
        provider: 'fish-cloud',
        message: 'HTTP 401',
      });
      expect(onOutcome.mock.calls[2]![0]).toMatchObject({ outcome: 'fallback' });
    });

    it('a hung synthesize cannot hang the IPC: times out → stays silent + logged', async () => {
      const onOutcome = jest.fn();
      const router = new TtsRouter({
        getConfig: () => cfg({ provider: 'fish-local' }),
        fish: { speak: jest.fn(() => new Promise<never>(() => undefined)) },
        onOutcome,
        speakTimeoutMs: 30,
      });
      const r = await router.speak({ text: '你好' });
      expect(r).toMatchObject({ success: false, fallbackToSystem: false });
      expect(onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'fallback', code: 'timeout' }),
      );
    });

    it('thrown errors are reported as error and rethrown', async () => {
      const onOutcome = jest.fn();
      const router = new TtsRouter({
        getConfig: () => {
          throw new Error('cfg boom');
        },
        fish: { speak: jest.fn() },
        onOutcome,
      });
      await expect(router.speak({ text: 'x' })).rejects.toThrow('cfg boom');
      expect(onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', message: 'cfg boom' }),
      );
    });
  });
});

describe('applyTtsEnvOverride (CD_TTS=off for e2e)', () => {
  it('leaves config untouched by default', () => {
    const c = cfg();
    expect(applyTtsEnvOverride(c, {})).toBe(c);
  });

  it('disables synthesis: no engine call, stays silent', async () => {
    const fish = { speak: jest.fn(async () => ok()) };
    const router = new TtsRouter({
      getConfig: () => applyTtsEnvOverride(cfg({ provider: 'fish-local' }), { CD_TTS: 'off' }),
      fish,
    });
    const r = await router.speak({ text: '你好' });
    expect(r.fallbackToSystem).toBe(false);
    expect(fish.speak).not.toHaveBeenCalled();
  });
});
