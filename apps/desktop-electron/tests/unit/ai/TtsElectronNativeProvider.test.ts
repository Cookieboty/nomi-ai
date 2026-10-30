/**
 * TtsElectronNativeProvider 单测
 *
 * 覆盖：
 *   - `info` 元信息（id / streaming / requiresApiKey）
 *   - `synth`：默认 reqId + voiceId fallback + settings 归一化
 *   - `stream`：一次性 yield 一个 `isFinal=true` 的 chunk
 *   - `stop`：转发到 engine.stop()
 *   - `listVoices`：仅返回当前 platform 的项，映射 gender 兜底
 *   - `applyVoice`：未知 voiceId 抛错
 */

import {
  ELECTRON_NATIVE_TTS_PROVIDER_ID,
  TtsElectronNativeProvider,
} from '../../../src/ai/TtsElectronNativeProvider';
import type { TTSVoiceConfig, TTSSettings } from '../../../src/services/AdvancedTTSEngine';

type EngineMock = {
  speak: jest.Mock<Promise<void>, [string, Partial<TTSSettings>?]>;
  stop: jest.Mock<void, []>;
  getAvailableVoices: jest.Mock<TTSVoiceConfig[], []>;
  setCurrentVoice: jest.Mock<Promise<boolean>, [string]>;
  getCurrentVoice: jest.Mock<TTSVoiceConfig | null, []>;
};

function makeEngine(overrides?: Partial<EngineMock>): EngineMock {
  return {
    speak: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    getAvailableVoices: jest.fn().mockReturnValue([]),
    setCurrentVoice: jest.fn().mockResolvedValue(true),
    getCurrentVoice: jest.fn().mockReturnValue(null),
    ...overrides,
  } as EngineMock;
}

function makeVoice(overrides?: Partial<TTSVoiceConfig>): TTSVoiceConfig {
  return {
    name: '系统默认',
    systemVoice: 'Ting-Ting',
    platform: 'darwin',
    language: 'zh-CN',
    gender: 'female',
    style: 'standard',
    ...overrides,
  };
}

describe('TtsElectronNativeProvider', () => {
  describe('info', () => {
    it('返回稳定的 provider 元信息', () => {
      const provider = new TtsElectronNativeProvider({
        engine: makeEngine(),
        platform: 'darwin',
      });
      expect(provider.info).toEqual({
        id: ELECTRON_NATIVE_TTS_PROVIDER_ID,
        name: 'Electron Native TTS',
        streaming: false,
        requiresApiKey: false,
      });
    });
  });

  describe('synth', () => {
    it('返回带 durationMs 的 TtsResult，voiceId 从 opts 优先', async () => {
      const engine = makeEngine({
        getCurrentVoice: jest.fn().mockReturnValue(makeVoice({ name: 'default' })),
      });
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => 'req-1',
        platform: 'darwin',
      });
      const res = await provider.synth('你好', { voiceId: 'Ting-Ting', rate: 1.2 });
      expect(res.reqId).toBe('req-1');
      expect(res.providerId).toBe(ELECTRON_NATIVE_TTS_PROVIDER_ID);
      expect(res.voiceId).toBe('Ting-Ting');
      expect(res.mime).toBe('application/x-electron-native-tts');
      expect(res.data).toBeInstanceOf(Uint8Array);
      expect(res.data.byteLength).toBe(0);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(engine.setCurrentVoice).toHaveBeenCalledWith('Ting-Ting');
      expect(engine.speak).toHaveBeenCalledWith('你好', { speed: 1.2 });
    });

    it('未提供 voiceId 时，voiceId 回退到当前 engine voice name', async () => {
      const engine = makeEngine({
        getCurrentVoice: jest.fn().mockReturnValue(makeVoice({ name: '默认音色' })),
      });
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => 'req-2',
      });
      const res = await provider.synth('测试');
      expect(engine.setCurrentVoice).not.toHaveBeenCalled();
      expect(engine.speak).toHaveBeenCalledWith('测试', undefined);
      expect(res.voiceId).toBe('默认音色');
    });

    it('未知 voiceId 抛出可辨识的错误', async () => {
      const engine = makeEngine({
        setCurrentVoice: jest.fn().mockResolvedValue(false),
      });
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => 'req-3',
      });
      await expect(provider.synth('文本', { voiceId: '不存在' })).rejects.toThrow(
        '[electron-native-tts] unknown voiceId: 不存在',
      );
      expect(engine.speak).not.toHaveBeenCalled();
    });

    it('归一化 rate / pitch / volume 到 engine settings', async () => {
      const engine = makeEngine();
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => 'req-4',
      });
      await provider.synth('文本', { rate: 0.9, pitch: 1.1, volume: 0.5 });
      expect(engine.speak).toHaveBeenCalledWith('文本', {
        speed: 0.9,
        pitch: 1.1,
        volume: 0.5,
      });
    });
  });

  describe('stream', () => {
    it('yield 单个 isFinal chunk', async () => {
      const engine = makeEngine();
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => 'req-stream',
      });
      const chunks: Array<{ reqId: string; seq: number; isFinal?: boolean }> = [];
      for await (const chunk of provider.stream('文本')) {
        chunks.push({ reqId: chunk.reqId, seq: chunk.seq, isFinal: chunk.isFinal });
      }
      expect(chunks).toEqual([{ reqId: 'req-stream', seq: 0, isFinal: true }]);
      expect(engine.speak).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('转发到 engine.stop()（不关心 reqId）', () => {
      const engine = makeEngine();
      const provider = new TtsElectronNativeProvider({ engine });
      provider.stop('any-req-id');
      expect(engine.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('listVoices', () => {
    it('只保留匹配当前 platform 的项，并映射 gender/id', async () => {
      const voices: TTSVoiceConfig[] = [
        makeVoice({
          name: '中文-女',
          systemVoice: 'Ting-Ting',
          platform: 'darwin',
          gender: 'female',
        }),
        makeVoice({ name: '英文-男', systemVoice: 'Alex', platform: 'darwin', gender: 'male' }),
        makeVoice({ name: 'Win Zira', systemVoice: 'Zira', platform: 'win32', gender: 'female' }),
        makeVoice({ name: '中性', systemVoice: 'Neutral', platform: 'darwin', gender: 'neutral' }),
      ];
      const engine = makeEngine({
        getAvailableVoices: jest.fn().mockReturnValue(voices),
      });
      const provider = new TtsElectronNativeProvider({ engine, platform: 'darwin' });
      const list = await provider.listVoices();
      expect(list).toEqual([
        {
          id: 'Ting-Ting',
          providerId: ELECTRON_NATIVE_TTS_PROVIDER_ID,
          name: '中文-女',
          language: 'zh-CN',
          gender: 'female',
        },
        {
          id: 'Alex',
          providerId: ELECTRON_NATIVE_TTS_PROVIDER_ID,
          name: '英文-男',
          language: 'zh-CN',
          gender: 'male',
        },
        {
          id: 'Neutral',
          providerId: ELECTRON_NATIVE_TTS_PROVIDER_ID,
          name: '中性',
          language: 'zh-CN',
          gender: 'unknown',
        },
      ]);
    });

    it('平台无匹配项时返回空数组', async () => {
      const engine = makeEngine({
        getAvailableVoices: jest.fn().mockReturnValue([makeVoice({ platform: 'win32' })]),
      });
      const provider = new TtsElectronNativeProvider({ engine, platform: 'darwin' });
      const list = await provider.listVoices();
      expect(list).toEqual([]);
    });
  });

  describe('makeReqId', () => {
    it('未传 opts.reqId 时使用注入的生成器', async () => {
      let seq = 0;
      const engine = makeEngine();
      const provider = new TtsElectronNativeProvider({
        engine,
        makeReqId: () => `auto-${++seq}`,
      });
      const r1 = await provider.synth('a');
      const r2 = await provider.synth('b');
      expect(r1.reqId).toBe('auto-1');
      expect(r2.reqId).toBe('auto-2');
    });
  });

  describe('contract shape (对齐 @nomi-ai/bundle-ig-electron-caps/seams TtsProvider)', () => {
    it('runtime shape 具备 info / synth / stream / stop / listVoices，且 info 字段完整', () => {
      const provider = new TtsElectronNativeProvider({ engine: makeEngine() });
      expect(typeof provider.synth).toBe('function');
      expect(typeof provider.stream).toBe('function');
      expect(typeof provider.stop).toBe('function');
      expect(typeof provider.listVoices).toBe('function');
      expect(provider.info).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          streaming: expect.any(Boolean),
          requiresApiKey: expect.any(Boolean),
        }),
      );
    });
  });
});
