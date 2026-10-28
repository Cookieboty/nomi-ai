import type { TTSConfig } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

import { normalizeTtsConfig, validateTtsConfig } from '../../../src/tts/ttsConfig';
import { TtsRouter, applyTtsEnvOverride } from '../../../src/tts/ttsRouter';

const cfg = (patch: Partial<TTSConfig> = {}): TTSConfig => ({
  ...DEFAULT_TTS_CONFIG,
  lastModified: 0,
  ...patch,
});

describe('TtsRouter', () => {
  it('默认是 edge：返回 mp3 base64，带上音色和语速', async () => {
    const speak = jest.fn(async () => ({ ok: true as const, audio: Buffer.from('mp3') }));
    const r = await new TtsRouter({ getConfig: () => cfg(), edge: { speak } }).speak({
      text: '你好',
    });
    expect(r).toEqual({
      success: true,
      audioBase64: Buffer.from('mp3').toString('base64'),
      mimeType: 'audio/mpeg',
      via: 'edge',
    });
    expect(speak).toHaveBeenCalledWith({ text: '你好', voice: 'zh-CN-XiaoyiNeural', rate: -5 });
  });

  it('edge 失败（离线 / 超时 / 403）静默', async () => {
    for (const kind of ['offline', 'timeout', 'forbidden', 'protocol'] as const) {
      const edge = { speak: jest.fn(async () => ({ ok: false as const, kind, message: kind })) };
      const r = await new TtsRouter({ getConfig: () => cfg(), edge }).speak({ text: '你好' });
      expect(r).toMatchObject({ success: false, via: 'none', message: `edge: ${kind}` });
    }
  });

  it('none 静默', async () => {
    const edge = { speak: jest.fn() };
    const r = await new TtsRouter({ getConfig: () => cfg({ provider: 'none' }), edge }).speak({
      text: '你好',
    });
    expect(r).toMatchObject({ success: false, via: 'none' });
    expect(edge.speak).not.toHaveBeenCalled();
  });

  it.each(['azure', 'openai'] as const)('%s 尚未实现：静默', async (provider) => {
    const r = await new TtsRouter({ getConfig: () => cfg({ provider }) }).speak({ text: '你好' });
    expect(r).toMatchObject({ success: false, via: 'none' });
    expect(r.message).toMatch(/not implemented/);
  });

  it('空文本 / 关闭 / CD_TTS=off 静默', async () => {
    expect((await new TtsRouter({ getConfig: () => cfg() }).speak({ text: '  ' })).message).toBe(
      'empty text',
    );
    const off = applyTtsEnvOverride(cfg({ provider: 'edge' }), { CD_TTS: 'off' });
    expect((await new TtsRouter({ getConfig: () => off }).speak({ text: 'x' })).message).toBe(
      'tts disabled',
    );
  });

  it('每条请求恰好上报一次结果；getConfig 抛错也静默', async () => {
    const onOutcome = jest.fn();
    const r = await new TtsRouter({
      getConfig: () => {
        throw new Error('boom');
      },
      onOutcome,
    }).speak({ text: 'x' });
    expect(r).toMatchObject({ success: false, via: 'none', message: 'boom' });
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'error' });
  });
});

describe('normalizeTtsConfig', () => {
  it('旧配置里已移除的引擎当作 none，不抛错；丢弃未知字段', () => {
    for (const provider of ['fish-local', 'fish-cloud', 'legacy', 'sherpa-theresa', 42]) {
      const c = normalizeTtsConfig({
        provider,
        enabled: true,
        baseUrl: 'http://x',
        promptVoice: false,
      });
      expect(c.provider).toBe('none');
      expect(c.promptVoice).toBe(false);
      expect(c).not.toHaveProperty('baseUrl');
    }
    expect(normalizeTtsConfig(null)).toMatchObject({ provider: 'none', promptVoice: true });
    expect(normalizeTtsConfig({ provider: 'none' }).provider).toBe('none');
    expect(DEFAULT_TTS_CONFIG).toMatchObject({ provider: 'edge', enabled: true });
    expect(normalizeTtsConfig({ provider: 'azure' }).provider).toBe('azure');
  });

  it('edge 音色 / 语速归一化', () => {
    expect(
      normalizeTtsConfig({ provider: 'edge', edgeVoice: 'zh-CN-YunxiNeural', rate: 12.4 }),
    ).toMatchObject({ edgeVoice: 'zh-CN-YunxiNeural', rate: 12 });
    expect(normalizeTtsConfig({ edgeVoice: "x'/><evil", rate: 999 })).toMatchObject({
      edgeVoice: 'zh-CN-XiaoyiNeural',
      rate: 50,
    });
    expect(normalizeTtsConfig({ rate: 'fast' }).rate).toBe(-5);
    expect(validateTtsConfig(cfg({ provider: 'edge', edgeVoice: 'bad' })).isValid).toBe(false);
    expect(validateTtsConfig(cfg({ provider: 'edge', rate: 80 })).isValid).toBe(false);
  });

  it('保存时只接受 none / edge / azure / openai', () => {
    expect(validateTtsConfig(cfg({ provider: 'openai' })).isValid).toBe(true);
    expect(validateTtsConfig({ ...cfg(), provider: 'legacy' }).isValid).toBe(false);
  });
});
