// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScreenPanel } from '../src/components/ScreenPanel';
import { buildProviderMessages } from '../src/services/history';
import { describeSkip, likelyVision } from '../src/services/screenClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const state = (enabled = false) => ({
  settings: {
    enabled,
    intervalSec: 60,
    retentionDays: 7,
    exclusions: ['1Password', '无痕'],
    pausedUntil: 0,
    snipHotkey: true,
  },
  active: enabled,
  count: enabled ? 1 : 0,
  ocrReady: true,
  lastSkip: '',
  chat: { id: 'p', name: 'Ollama', local: true, model: 'qwen2.5vl:3b' },
  localOnly: false,
});

function mockIpc(enabled = false) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ai:screen:state') return state(enabled);
    if (ch === 'ai:screen:search')
      return enabled
        ? [{ id: 'e1', at: Date.now(), windows: ['终端'], text: 'npm run build 成功' }]
        : [];
    return true;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

describe('ScreenPanel', () => {
  it('shows vision badge for the current local model', async () => {
    mockIpc();
    const r = render(<ScreenPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('支持看图')).toBeTruthy());
    expect(r.getByText('本地')).toBeTruthy();
  });

  it('initialTab 指定首次落在哪个内层标签', async () => {
    mockIpc();
    const r = render(<ScreenPanel isVisible onClose={() => undefined} initialTab="privacy" />);
    await waitFor(() => expect(r.getByRole('tab', { name: '隐私与排除' })).toBeTruthy());
    expect(r.getByRole('tab', { name: '隐私与排除' }).getAttribute('aria-selected')).toBe('true');
    expect(r.getByRole('tab', { name: '截图提问' }).getAttribute('aria-selected')).toBe('false');
  });

  it('screen memory is off by default and can be enabled', async () => {
    const invoke = mockIpc();
    const r = render(<ScreenPanel isVisible onClose={() => undefined} />);
    await waitFor(() => r.getByText(/屏幕记忆/, { selector: '[role=tab], button' }));
    fireEvent.click(r.getAllByRole('tab')[1]);
    await waitFor(() => expect(r.getByText('还没有屏幕记录')).toBeTruthy());
    fireEvent.click(r.getByRole('switch', { name: /开启屏幕记忆/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:screen:set-settings', {
        enabled: true,
        pausedUntil: 0,
      }),
    );
  });

  it('shows the indicator and timeline when enabled; edits exclusions', async () => {
    const invoke = mockIpc(true);
    const r = render(<ScreenPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('screen-indicator')).toBeTruthy());
    fireEvent.click(r.getAllByRole('tab')[1]);
    await waitFor(() => expect(r.getByText(/npm run build/)).toBeTruthy());
    fireEvent.click(r.getAllByRole('tab')[2]);
    fireEvent.click(r.getByLabelText('移除 1Password'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:screen:set-settings', { exclusions: ['无痕'] }),
    );
  });
});

describe('image helpers', () => {
  it('passes images only on the current turn and tags earlier ones', () => {
    const out = buildProviderMessages(
      [
        {
          id: '1',
          role: 'user',
          content: '看这个',
          timestamp: 0,
          images: [{ thumb: 'x', width: 1, height: 1 }],
        },
      ],
      '那这张呢',
      undefined,
      [{ mime: 'image/jpeg', data: 'QQ==' }],
    );
    expect(out[0]).toEqual({ role: 'user', content: '[此前附了 1 张图片] 看这个' });
    expect(out[1]).toEqual({
      role: 'user',
      content: '那这张呢',
      images: [{ mime: 'image/jpeg', data: 'QQ==' }],
    });
  });
  it('vision heuristic + skip reasons', () => {
    expect(likelyVision('llava:7b')).toBe(true);
    expect(likelyVision('qwen2.5vl:3b')).toBe(true);
    expect(likelyVision('deepseek-chat')).toBe(false);
    expect(describeSkip('excluded:1Password')).toContain('1Password');
  });
});
