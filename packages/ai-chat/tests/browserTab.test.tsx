// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserTab,
  EMBED_CHECK_DELAY_MS,
  LOAD_STALL_TIMEOUT_MS,
} from '../src/components/SideWorkspace/BrowserTab';
import { APP_CSP, appCspString } from '../src/security/csp';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
    web: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

beforeEach(() => {
  const happy = (
    window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM;
  if (happy) happy.settings.disableIframePageLoading = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('BrowserTab & production CSP', () => {
  it('allows http/https embeds in production APP_CSP while blocking non-web schemes', () => {
    expect(APP_CSP['frame-src']).toEqual(['http:', 'https:']);
    const csp = appCspString();
    expect(csp).toContain('frame-src http: https:');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(APP_CSP['frame-src']).not.toContain("'self'");
    expect(APP_CSP['frame-src']).not.toContain('file:');
    expect(APP_CSP['frame-src']).not.toContain('data:');
  });

  it('opens external URLs via resourcePreviewClient.external and falls back to window.open', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<BrowserTab tabKey="browser:1" url="https://example.com/docs" onNavigate={() => {}} />);

    const frame = screen.getByTestId('browser-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://example.com/docs');

    fireEvent.click(screen.getByTestId('browser-open-external'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('', 'https://example.com/docs'),
    );
    expect(openSpy).not.toHaveBeenCalled();

    // 当契约通道返回失败时，回退到宿主 window.open 桥
    vi.mocked(resourcePreviewClient.external).mockResolvedValueOnce({
      ok: false,
      code: 'unavailable',
    });
    fireEvent.click(screen.getByTestId('browser-open-external'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/docs',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    openSpy.mockRestore();
  });

  it('shows fallback when frame stays on about:blank and retries cleanly on refresh', async () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    render(
      <BrowserTab tabKey="browser:2" url="https://blocked.example/" onNavigate={onNavigate} />,
    );

    const frame = screen.getByTestId('browser-frame') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { location: { href: 'about:blank' } },
    });

    fireEvent.load(frame);
    // 慢速首包期间（< EMBED_CHECK_DELAY_MS）不应提前误判为 blocked
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.queryByTestId('browser-fallback')).toBeNull();

    // 超过复核窗口仍停留在 about:blank，展示系统浏览器回退页
    act(() => {
      vi.advanceTimersByTime(EMBED_CHECK_DELAY_MS);
    });
    expect(screen.getByTestId('browser-fallback')).toBeTruthy();

    // 在回退页点「在系统浏览器中打开」走通用外部链接通道
    vi.useRealTimers();
    fireEvent.click(screen.getByTestId('browser-fallback-open-external'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('', 'https://blocked.example/'),
    );

    // 点击顶栏「刷新」应重置 blocked 并重新挂载 iframe 重试
    fireEvent.click(screen.getByTestId('browser-refresh'));
    expect(screen.queryByTestId('browser-fallback')).toBeNull();
    expect(screen.getByTestId('browser-frame')).toBeTruthy();
  });

  it('fast-fails immediately via kernel header preflight when X-Frame-Options or DNS blocks embed', async () => {
    vi.mocked(resourcePreviewClient.web).mockResolvedValueOnce({
      ok: true,
      kind: 'external',
      code: 'frame-blocked',
    });
    render(<BrowserTab tabKey="browser:3" url="https://google.com/" onNavigate={() => {}} />);

    // 预检返回 frame-blocked 后无需苦等白屏超时，立即显示回退卡片
    await waitFor(() => expect(screen.getByTestId('browser-fallback')).toBeTruthy());
    expect(screen.queryByTestId('browser-loading-bar')).toBeNull();
  });

  it('recovers from silent WKWebView iframe stalls where onLoad never fires and warms connection via preconnect', () => {
    vi.useFakeTimers();
    render(<BrowserTab tabKey="browser:4" url="https://stalled.example/" onNavigate={() => {}} />);

    expect(
      document.head.querySelector('link[rel="preconnect"][href="https://stalled.example"]'),
    ).toBeTruthy();
    expect(screen.getByTestId('browser-loading-bar')).toBeTruthy();

    // 模拟 WKWebView 静默丢弃子 frame 导航（onLoad 始终未触发）
    act(() => {
      vi.advanceTimersByTime(LOAD_STALL_TIMEOUT_MS);
    });
    expect(screen.getByTestId('browser-fallback')).toBeTruthy();
    expect(screen.queryByTestId('browser-loading-bar')).toBeNull();
  });
});
