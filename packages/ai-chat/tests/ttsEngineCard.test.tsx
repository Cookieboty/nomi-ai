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

describe('TtsEngineCard（设置 → 语音：朗读引擎）', () => {
  it('不在桌面应用里时不渲染', () => {
    const { container } = render(<TtsEngineCard />);
    expect(container.innerHTML).toBe('');
  });

  it('切到自建 legacy、填写后保存；语音开关沿用主进程里的最新值', async () => {
    const { tts, setEnabled } = mockTts({ enabled: true, provider: 'sherpa-theresa' });
    render(<TtsEngineCard />);
    const provider = await screen.findByTestId('tts-provider');
    expect((screen.getByTestId('tts-engine-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(provider, { target: { value: 'legacy' } });
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
});
