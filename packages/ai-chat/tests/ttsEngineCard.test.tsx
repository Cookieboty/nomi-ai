// @vitest-environment happy-dom
import type { Handlers } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createTestClient, type TestClient } from '@nomi-ai/contract/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 朗读配置经契约 tts.*（D1，原 electronAPI.tts）：假宿主走 createTestClient 的完整线协议
const host = vi.hoisted(() => ({ client: null as null | { api: unknown } }));
vi.mock('../src/services/api', () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!host.client) throw new Error('no fake host');
        const v = (host.client.api as Record<PropertyKey, unknown>)[key];
        return typeof v === 'function'
          ? (v as (...a: unknown[]) => unknown).bind(host.client.api)
          : v;
      },
    },
  ),
  hasTransport: () => host.client !== null,
}));

import { TtsEngineCard } from '../src/components/SettingsView/TtsEngineCard';

afterEach(() => {
  cleanup();
  (host.client as TestClient<AppContract> | null)?.close();
  host.client = null;
});

type Fn = (...a: never[]) => unknown;

function mockTts(initial: Record<string, unknown>) {
  let stored = { ...initial };
  const tts: Record<string, ReturnType<typeof vi.fn> | undefined> & {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    test: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  } = {
    get: vi.fn(async () => ({ ...stored })),
    save: vi.fn(async (cfg: Record<string, unknown>) => {
      stored = { ...stored, ...cfg };
      return { success: true };
    }),
    test: vi.fn(async () => ({ success: true, message: '可达', latency: 12 })),
    reset: vi.fn(async () => ({ success: true })),
  };
  // 没有给的过程（voices / status / preview）与旧 bridge 缺方法一样：调用失败，客户端退回 null
  const optional = (key: string) => (input: unknown) => {
    const fn = tts[key] as Fn | undefined;
    if (!fn) throw new Error(`${key} not provided`);
    return fn(input as never);
  };
  const handlers: Partial<Handlers<AppContract>> = {
    // 主进程读配置时会补齐默认值（TtsService.getConfig → TtsConfigStore.load）
    'tts.getConfig': async () => ({
      enabled: true,
      provider: 'edge',
      lastModified: 0,
      ...((await tts.get()) as Record<string, unknown>),
    }),
    'tts.saveConfig': async (cfg) => {
      await tts.save(cfg);
    },
    'tts.testConnection': (cfg) => tts.test(cfg) as never,
    'tts.resetConfig': async () => {
      await tts.reset();
    },
    'tts.voices': optional('voices') as never,
    'tts.status': optional('status') as never,
    'tts.preview': optional('preview') as never,
  };
  host.client = createTestClient(appContract, handlers, {
    caller: { surface: 'chat', trusted: true },
  });
  return {
    tts,
    setEnabled: (on: boolean) => {
      stored.enabled = on;
    },
  };
}

describe('TtsEngineCard（设置 → 语音：提示语音 + 实时朗读引擎）', () => {
  it('不在桌面应用里时不渲染', () => {
    const { container } = render(<TtsEngineCard />);
    expect(container.innerHTML).toBe('');
  });

  it('保存时语音开关沿用主进程里的最新值', async () => {
    const { tts, setEnabled } = mockTts({ enabled: true, provider: 'none' });
    render(<TtsEngineCard />);
    const provider = await screen.findByTestId('tts-provider');
    expect((screen.getByTestId('tts-engine-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(provider, { target: { value: 'edge' } });

    // 用户在上方卡片里刚关掉了语音
    setEnabled(false);
    fireEvent.click(screen.getByTestId('tts-engine-save'));
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({ provider: 'edge', enabled: false });
    expect((await screen.findByTestId('tts-engine-result')).textContent).toContain('配置已保存');
  });

  it('检测连接显示结果与延迟', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'none' });
    render(<TtsEngineCard />);
    await screen.findByTestId('tts-provider');
    fireEvent.click(screen.getByTestId('tts-engine-test'));
    await waitFor(() => expect(tts.test).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('tts-engine-result')).textContent).toContain('可达 · 12ms');
  });

  it('选项为 Edge / 无 / Azure / OpenAI；Azure / OpenAI 提示暂未接入', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'none', promptVoice: true });
    render(<TtsEngineCard />);
    const provider = (await screen.findByTestId('tts-provider')) as HTMLSelectElement;
    expect(provider.value).toBe('none');
    expect([...provider.options].map((o) => o.value)).toEqual(['edge', 'none', 'azure', 'openai']);
    expect(screen.queryByTestId('tts-engine-pending')).toBeNull();
    expect(screen.queryByTestId('tts-edge-voice')).toBeNull();

    fireEvent.change(provider, { target: { value: 'azure' } });
    expect(await screen.findByTestId('tts-engine-pending')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tts-engine-save'));
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({ provider: 'azure' });
  });

  it('没有保存过时默认 Edge：可选音色、调语速、试听，保存带上音色和语速', async () => {
    const { tts } = mockTts({});
    const play = vi.fn(async () => undefined);
    vi.stubGlobal(
      'Audio',
      class {
        constructor(public src: string) {}
        play = play;
        pause = vi.fn();
      },
    );
    Object.assign(tts, {
      voices: vi.fn(async () => ({
        source: 'online',
        voices: [
          { shortName: 'zh-CN-XiaoyiNeural', locale: 'zh-CN', gender: 'Female' },
          { shortName: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male' },
        ],
      })),
      status: vi.fn(async () => ({ consecutiveFailures: 0 })),
      preview: vi.fn(async () => ({ success: true, audioBase64: 'QUJD', mimeType: 'audio/mpeg' })),
    });
    render(<TtsEngineCard />);
    const provider = (await screen.findByTestId('tts-provider')) as HTMLSelectElement;
    expect(provider.value).toBe('edge');
    expect(screen.queryByTestId('tts-engine-pending')).toBeNull();
    expect(screen.getByTestId('tts-edge-note')).toBeTruthy();
    const voice = screen.getByTestId('tts-edge-voice') as HTMLSelectElement;
    await waitFor(() => expect(voice.options.length).toBe(2));
    expect(voice.value).toBe('zh-CN-XiaoyiNeural');
    fireEvent.change(voice, { target: { value: 'zh-CN-YunxiNeural' } });
    fireEvent.change(screen.getByTestId('tts-edge-rate'), { target: { value: '10' } });

    fireEvent.click(screen.getByTestId('tts-engine-preview'));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(
      (tts as unknown as { preview: ReturnType<typeof vi.fn> }).preview.mock.calls[0][0],
    ).toMatchObject({
      provider: 'edge',
      edgeVoice: 'zh-CN-YunxiNeural',
      rate: 10,
    });

    fireEvent.click(screen.getByTestId('tts-engine-save'));
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({
      provider: 'edge',
      edgeVoice: 'zh-CN-YunxiNeural',
      rate: 10,
    });
    vi.unstubAllGlobals();
  });

  it('连续失败后显示白话提示；试听失败不弹开发者错误', async () => {
    const { tts } = mockTts({ provider: 'edge' });
    Object.assign(tts, {
      status: vi.fn(async () => ({ consecutiveFailures: 3 })),
      preview: vi.fn(async () => ({ success: false, via: 'none', message: 'edge: offline' })),
    });
    render(<TtsEngineCard />);
    expect((await screen.findByTestId('tts-edge-failing')).textContent).toContain('连不上');
    fireEvent.click(screen.getByTestId('tts-engine-preview'));
    const res = await screen.findByTestId('tts-engine-result');
    expect(res.textContent).toContain('没法试听');
    expect(res.textContent).not.toContain('offline');
  });

  it('诺米提示语音开关立即保存，且不带上未保存的引擎草稿', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'none', promptVoice: true });
    render(<TtsEngineCard />);
    const provider = await screen.findByTestId('tts-provider');
    fireEvent.change(provider, { target: { value: 'openai' } });
    const sw = screen.getByTestId('prompt-voice-switch');
    const input = (sw.querySelector('input') ?? sw) as HTMLElement;
    fireEvent.click(input);
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({ provider: 'none', promptVoice: false });
  });

  it('朗读 AI 回复开关：默认开、立即保存；引擎不可用时禁用', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'edge' });
    render(<TtsEngineCard />);
    const sw = await screen.findByTestId('read-replies-switch');
    const input = (sw.querySelector('input') ?? sw) as HTMLInputElement;
    expect(input.checked ?? input.getAttribute('aria-checked') === 'true').toBeTruthy();
    fireEvent.click(input);
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({ readReplies: false });
    fireEvent.change(screen.getByTestId('tts-provider'), { target: { value: 'none' } });
    const off = screen.getByTestId('read-replies-switch');
    const offInput = (off.querySelector('input') ?? off) as HTMLInputElement;
    expect(offInput.disabled || off.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});
