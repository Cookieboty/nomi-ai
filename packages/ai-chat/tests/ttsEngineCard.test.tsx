// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TtsEngineCard } from '../src/components/SettingsView/TtsEngineCard';

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

function mockTts(initial: Record<string, unknown>) {
  let stored = { ...initial };
  const tts = {
    get: vi.fn(async () => ({ ...stored })),
    save: vi.fn(async (cfg: Record<string, unknown>) => {
      stored = { ...stored, ...cfg, apiKey: undefined, hasApiKey: Boolean(cfg.apiKey) };
      return { success: true };
    }),
    test: vi.fn(async () => ({ success: true, message: '可达', latency: 12 })),
    reset: vi.fn(async () => ({ success: true })),
  };
  (window as { electronAPI?: unknown }).electronAPI = { tts };
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

  it('旧配置的自建 legacy 仍可修改保存；语音开关沿用主进程里的最新值', async () => {
    const { tts, setEnabled } = mockTts({ enabled: true, provider: 'legacy' });
    render(<TtsEngineCard />);
    await screen.findByTestId('tts-provider');
    expect((screen.getByTestId('tts-engine-save') as HTMLButtonElement).disabled).toBe(true);

    const host = await screen.findByLabelText('hostname');
    fireEvent.change(host, { target: { value: 'tts.example.com' } });

    // 用户在上方卡片里刚关掉了语音
    setEnabled(false);
    fireEvent.click(screen.getByTestId('tts-engine-save'));
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({
      provider: 'legacy',
      hostname: 'tts.example.com',
      enabled: false,
    });
    expect((await screen.findByTestId('tts-engine-result')).textContent).toContain('配置已保存');
  });

  it('Fish 云：Key 只写不回显，检测连接显示结果与延迟', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'fish-cloud', hasApiKey: true });
    render(<TtsEngineCard />);
    const key = await screen.findByTestId('tts-api-key');
    expect((key as HTMLInputElement).value).toBe('');
    expect(screen.getByText('已保存云端 Key')).toBeTruthy();

    fireEvent.change(key, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('tts-engine-test'));
    await waitFor(() => expect(tts.test).toHaveBeenCalledTimes(1));
    expect(tts.test.mock.calls[0][0]).toMatchObject({ provider: 'fish-cloud', apiKey: 'sk-new' });
    expect((await screen.findByTestId('tts-engine-result')).textContent).toContain('可达 · 12ms');
  });

  it('默认引擎为「无」；选项只有 无 / Edge / Azure / OpenAI，后三者提示暂未接入', async () => {
    const { tts } = mockTts({ enabled: true, provider: 'none', promptVoice: true });
    render(<TtsEngineCard />);
    const provider = (await screen.findByTestId('tts-provider')) as HTMLSelectElement;
    expect(provider.value).toBe('none');
    expect([...provider.options].map((o) => o.value)).toEqual(['none', 'edge', 'azure', 'openai']);
    expect(screen.queryByTestId('tts-api-key')).toBeNull();
    expect(screen.queryByTestId('tts-engine-pending')).toBeNull();

    fireEvent.change(provider, { target: { value: 'azure' } });
    expect(await screen.findByTestId('tts-engine-pending')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tts-engine-save'));
    await waitFor(() => expect(tts.save).toHaveBeenCalledTimes(1));
    expect(tts.save.mock.calls[0][0]).toMatchObject({ provider: 'azure' });
  });

  it('旧配置里的 Fish 引擎仍显示在列表里', async () => {
    mockTts({ enabled: true, provider: 'fish-local' });
    render(<TtsEngineCard />);
    const provider = (await screen.findByTestId('tts-provider')) as HTMLSelectElement;
    expect([...provider.options].map((o) => o.value)).toEqual([
      'none',
      'edge',
      'azure',
      'openai',
      'fish-local',
    ]);
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
});
