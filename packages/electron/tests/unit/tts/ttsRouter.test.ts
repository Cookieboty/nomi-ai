import { DEFAULT_TTS_CONFIG, type TTSConfig, type TTSSpeakResult } from '@nomi-ai/types';

import { SherpaTtsError } from '../../../src/tts/sherpa/SherpaTtsService';
import { TtsRouter, applyTtsEnvOverride, selectEngine } from '../../../src/tts/ttsRouter';

const cfg = (patch: Partial<TTSConfig> = {}): TTSConfig => ({
  ...DEFAULT_TTS_CONFIG,
  lastModified: 1,
  ...patch,
});

function setup(config: TTSConfig) {
  const sherpa = {
    synthesize: jest.fn(async () => ({ wav: Buffer.from('RIFFwav'), durationMs: 10 })),
  };
  const fishResult: TTSSpeakResult = {
    success: true,
    via: 'fish',
    audioBase64: 'ZmlzaA==',
    mimeType: 'audio/mpeg',
    fallbackToSystem: false,
  };
  const fish = { speak: jest.fn(async () => fishResult) };
  const onSherpaFailure = jest.fn();
  const router = new TtsRouter({ getConfig: () => config, sherpa, fish, onSherpaFailure });
  return { router, sherpa, fish, onSherpaFailure };
}

describe('selectEngine', () => {
  it('defaults to sherpa (offline), not Fish', () => {
    expect(DEFAULT_TTS_CONFIG.provider).toBe('sherpa-theresa');
    expect(DEFAULT_TTS_CONFIG.sherpaSid).toBe(0);
    expect(DEFAULT_TTS_CONFIG.sherpaSpeed).toBe(1.0);
    expect(selectEngine(cfg())).toBe('sherpa');
  });

  it('maps every provider', () => {
    expect(selectEngine(cfg({ provider: 'fish-local' }))).toBe('fish');
    expect(selectEngine(cfg({ provider: 'fish-cloud' }))).toBe('fish');
    expect(selectEngine(cfg({ provider: 'legacy' }))).toBe('legacy');
    expect(selectEngine(cfg({ enabled: false }))).toBe('none');
    expect(selectEngine({ enabled: true, provider: 'nope' as never })).toBe('none');
  });
});

describe('TtsRouter.speak', () => {
  it('sherpa success → wav base64 with sid/speed from config', async () => {
    const { router, sherpa, fish } = setup(cfg({ sherpaSid: 3, sherpaSpeed: 1.0 }));
    const r = await router.speak({ text: ' 你好 ' });
    expect(r).toEqual({
      success: true,
      via: 'sherpa',
      audioBase64: Buffer.from('RIFFwav').toString('base64'),
      mimeType: 'audio/wav',
      fallbackToSystem: false,
    });
    expect(sherpa.synthesize).toHaveBeenCalledWith('你好', { sid: 3, speed: 1.0 });
    expect(fish.speak).not.toHaveBeenCalled();
  });

  it('uses per-request speed when supplied by the active character', async () => {
    const { router, sherpa } = setup(cfg({ sherpaSpeed: 1.0 }));
    await router.speak({ text: '你好', speed: 0.82 });
    expect(sherpa.synthesize).toHaveBeenCalledWith('你好', { sid: 0, speed: 0.82 });
  });

  it('clamps malformed per-request speed before it reaches sherpa', async () => {
    const { router, sherpa } = setup(cfg({ sherpaSpeed: 1.0 }));
    await router.speak({ text: '你好', speed: 99 });
    expect(sherpa.synthesize).toHaveBeenCalledWith('你好', { sid: 0, speed: 1.5 });
  });

  it('sherpa not ready / failure stays silent (never Fish)', async () => {
    const { router, sherpa, fish, onSherpaFailure } = setup(cfg());
    sherpa.synthesize.mockRejectedValueOnce(new SherpaTtsError('not_ready', 'model missing'));
    const r = await router.speak({ text: '你好' });
    expect(r).toMatchObject({ success: false, via: 'none', fallbackToSystem: false });
    expect(r.message).toMatch(/model missing/);
    expect(onSherpaFailure).toHaveBeenCalledTimes(1);

    sherpa.synthesize.mockRejectedValueOnce(new Error('addon dlopen failed'));
    const r2 = await router.speak({ text: '你好' });
    expect(r2.fallbackToSystem).toBe(false);
    expect(fish.speak).not.toHaveBeenCalled();
  });

  it('superseded sherpa request stays silent', async () => {
    const { router, sherpa } = setup(cfg());
    sherpa.synthesize.mockRejectedValueOnce(new SherpaTtsError('superseded', 'newer'));
    const r = await router.speak({ text: '你好' });
    expect(r).toMatchObject({ success: false, fallbackToSystem: false });
  });

  it('routes Fish providers to Fish when explicitly selected and reachable', async () => {
    const { router, sherpa, fish } = setup(cfg({ provider: 'fish-local' }));
    const r = await router.speak({ text: '你好', referenceId: 'nomi' });
    expect(r.via).toBe('fish');
    expect(fish.speak).toHaveBeenCalledWith({ text: '你好', referenceId: 'nomi' });
    expect(sherpa.synthesize).not.toHaveBeenCalled();
  });

  it('Fish failure → try sherpa before staying silent (legacy fish-local configs)', async () => {
    const { router, sherpa, fish } = setup(cfg({ provider: 'fish-local' }));
    fish.speak.mockResolvedValueOnce({
      success: false,
      via: 'none',
      fallbackToSystem: false,
      message: 'Fish TTS unreachable',
    });
    const r = await router.speak({ text: '你好' });
    expect(fish.speak).toHaveBeenCalled();
    expect(sherpa.synthesize).toHaveBeenCalledWith('你好', { sid: 0, speed: 1.0 });
    expect(r).toMatchObject({ success: true, via: 'sherpa', fallbackToSystem: false });
  });

  it('Fish and sherpa both fail → stay silent', async () => {
    const { router, sherpa, fish } = setup(cfg({ provider: 'fish-local' }));
    fish.speak.mockResolvedValueOnce({
      success: false,
      via: 'none',
      fallbackToSystem: false,
      message: 'Fish TTS unreachable',
    });
    sherpa.synthesize.mockRejectedValueOnce(new SherpaTtsError('not_ready', 'model missing'));
    const r = await router.speak({ text: '你好' });
    expect(r).toMatchObject({ success: false, fallbackToSystem: false });
    expect(r.message).toMatch(/Fish TTS unreachable|model missing/);
  });

  it('disabled / legacy / empty text never synthesize', async () => {
    for (const patch of [{ enabled: false }, { provider: 'legacy' as const }]) {
      const { router, sherpa, fish } = setup(cfg(patch));
      const r = await router.speak({ text: '你好' });
      expect(r.success).toBe(false);
      expect(r.fallbackToSystem).toBe(false);
      expect(sherpa.synthesize).not.toHaveBeenCalled();
      expect(fish.speak).not.toHaveBeenCalled();
    }
    const { router, sherpa } = setup(cfg());
    expect((await router.speak({ text: '   ' })).fallbackToSystem).toBe(false);
    expect(sherpa.synthesize).not.toHaveBeenCalled();
  });

  describe('per-request outcome log + timeout', () => {
    it('reports success / fallback(downloading) / error with provider, exactly once each', async () => {
      const onOutcome = jest.fn();
      const sherpa = { synthesize: jest.fn() };
      const fish = { speak: jest.fn() };
      const router = new TtsRouter({ getConfig: () => cfg(), sherpa, fish, onOutcome });
      sherpa.synthesize.mockResolvedValueOnce({ wav: Buffer.from('RIFFwav') });
      await router.speak({ text: '你好' });
      sherpa.synthesize.mockRejectedValueOnce(new SherpaTtsError('downloading', '模型下载中 37%'));
      const r = await router.speak({ text: '你好' });
      expect(r).toMatchObject({ success: false, fallbackToSystem: false, via: 'none' });
      await router.speak({ text: '  ' });
      expect(onOutcome).toHaveBeenCalledTimes(3);
      expect(onOutcome.mock.calls[0]![0]).toMatchObject({
        outcome: 'success',
        provider: 'sherpa-theresa',
        via: 'sherpa',
      });
      expect(onOutcome.mock.calls[1]![0]).toMatchObject({
        outcome: 'fallback',
        provider: 'sherpa-theresa',
        code: 'downloading',
        message: '模型下载中 37%',
      });
      expect(onOutcome.mock.calls[2]![0]).toMatchObject({ outcome: 'fallback' });
    });

    it('a hung synthesize cannot hang the IPC: times out → stays silent + logged', async () => {
      const onOutcome = jest.fn();
      const sherpa = { synthesize: jest.fn(() => new Promise<never>(() => undefined)) };
      const router = new TtsRouter({
        getConfig: () => cfg(),
        sherpa,
        fish: { speak: jest.fn() },
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
        sherpa: { synthesize: jest.fn() },
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

  it('disables synthesis: no sherpa call, stays silent', async () => {
    const { sherpa, fish } = setup(cfg());
    const router = new TtsRouter({
      getConfig: () => applyTtsEnvOverride(cfg(), { CD_TTS: 'off' }),
      sherpa,
      fish,
    });
    const r = await router.speak({ text: '你好' });
    expect(r.fallbackToSystem).toBe(false);
    expect(sherpa.synthesize).not.toHaveBeenCalled();
    expect(fish.speak).not.toHaveBeenCalled();
  });
});
