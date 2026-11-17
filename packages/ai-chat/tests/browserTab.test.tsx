// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserTab, browserWindowIdFor } from '../src/components/SideWorkspace/BrowserTab';
import { APP_CSP, appCspString } from '../src/security/csp';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    host: { value: true },
    handlers,
    show: vi.fn(async () => ({ ok: true })),
    setRegion: vi.fn(async () => true),
    navigate: vi.fn(async () => true),
    reload: vi.fn(async () => true),
    close: vi.fn(async () => true),
    closeAll: vi.fn(async () => true),
    sync: vi.fn(async () => ({ closed: [] })),
  };
});

vi.mock('../src/services/api', () => ({
  hasTransport: () => mocks.host.value,
  api: {
    browserWindow: {
      show: mocks.show,
      setRegion: mocks.setRegion,
      navigate: mocks.navigate,
      reload: mocks.reload,
      close: mocks.close,
      closeAll: mocks.closeAll,
      sync: mocks.sync,
    },
    on: (name: string, fn: (event: never) => void) => {
      mocks.handlers.set(name, fn as never);
      return () => mocks.handlers.delete(name);
    },
  },
}));

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
    web: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

beforeEach(() => {
  mocks.host.value = true;
  mocks.handlers.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BrowserTab（原生浏览器窗口）& production CSP', () => {
  it('allows http/https embeds in production APP_CSP while blocking non-web schemes', () => {
    // 预览环境的 iframe 回退仍要能嵌 http(s)；生产走原生窗口，本来就不受这条限制
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

  it('hands the page to the native browser window instead of an iframe', async () => {
    render(<BrowserTab tabKey="session-a:web" url="https://google.com/" onNavigate={() => {}} />);

    await waitFor(() => expect(mocks.show).toHaveBeenCalledTimes(1));
    const call = mocks.show.mock.calls[0]?.[0] as unknown as {
      id: string;
      url: string;
      region: { x: number; y: number; width: number; height: number };
    };
    expect(call.id).toBe(browserWindowIdFor('session-a:web'));
    expect(call.url).toBe('https://google.com/');
    expect(typeof call.region.x).toBe('number');
    // 原生窗口里没有子框架，也就不会有「已阻止此内容」
    expect(screen.queryByTestId('browser-frame')).toBeNull();
    expect(screen.getByTestId('browser-surface')).toBeTruthy();
  });

  it('clears the progress bar when the host reports the page loaded', async () => {
    render(<BrowserTab tabKey="web" url="https://example.com/" onNavigate={() => {}} />);
    await waitFor(() => expect(mocks.show).toHaveBeenCalled());
    expect(screen.getByTestId('browser-loading-bar')).toBeTruthy();

    act(() => {
      mocks.handlers.get('browserWindow.loaded')?.({ id: 'browser:web', ok: true });
    });
    await waitFor(() => expect(screen.queryByTestId('browser-loading-bar')).toBeNull());
    expect(screen.queryByTestId('browser-fallback')).toBeNull();
  });

  it('stops the progress bar when the host never reports a load', async () => {
    // 证书错误 / DNS 失败时 WKWebView 不回 didFinishNavigation，视图得有兜底，
    // 否则刷新按钮会一直转（原生窗口里其实已经是错误页了）
    vi.useFakeTimers();
    try {
      render(
        <BrowserTab tabKey="web" url="https://self-signed.localhost/" onNavigate={() => {}} />,
      );
      expect(screen.getByTestId('browser-loading-bar')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(screen.queryByTestId('browser-loading-bar')).toBeNull();
      // 只是收掉进度条，不能把用户推到回退页（页面在原生窗口里看得见）
      expect(screen.queryByTestId('browser-fallback')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the system browser when the host cannot open a window', async () => {
    mocks.show.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'no window' });
    render(<BrowserTab tabKey="web" url="https://example.com/docs" onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('browser-fallback')).toBeTruthy());
    fireEvent.click(screen.getByTestId('browser-fallback-open-external'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('', 'https://example.com/docs'),
    );
  });

  it('reloads through the host and hides the window while the tab is in the background', async () => {
    const { rerender } = render(
      <BrowserTab tabKey="web" url="https://example.com/" onNavigate={() => {}} />,
    );
    await waitFor(() => expect(mocks.show).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('browser-refresh'));
    expect(mocks.reload).toHaveBeenCalledWith({ id: 'browser:web' });

    rerender(<BrowserTab tabKey="web" url="https://example.com/" hidden onNavigate={() => {}} />);
    await waitFor(() =>
      expect(mocks.setRegion).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'browser:web', visible: false }),
      ),
    );
  });

  it('opens external URLs via resourcePreviewClient.external and falls back to window.open', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<BrowserTab tabKey="web" url="https://example.com/docs" onNavigate={() => {}} />);

    fireEvent.click(screen.getByTestId('browser-open-external'));
    await waitFor(() =>
      expect(resourcePreviewClient.external).toHaveBeenCalledWith('', 'https://example.com/docs'),
    );
    expect(openSpy).not.toHaveBeenCalled();

    // 契约通道失败时退到宿主 window.open 桥
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

  it('only uses an iframe when there is no host at all (browser preview)', () => {
    mocks.host.value = false;
    render(<BrowserTab tabKey="web" url="https://example.com/preview" onNavigate={() => {}} />);

    const frame = screen.getByTestId('browser-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://example.com/preview');
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it('navigates the address bar through the tab and closes the window on unmount', async () => {
    const onNavigate = vi.fn();
    const { unmount } = render(
      <BrowserTab tabKey="web" url="https://example.com/" onNavigate={onNavigate} />,
    );
    await waitFor(() => expect(mocks.show).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('browser-address'), {
      target: { value: 'https://example.com/next' },
    });
    fireEvent.submit(screen.getByTestId('browser-address').closest('form') as HTMLFormElement);
    expect(onNavigate).toHaveBeenCalledWith('https://example.com/next', 'example.com');

    unmount();
    expect(mocks.close).toHaveBeenCalledWith({ id: 'browser:web' });
    // 光靠 close 不够：视重建 / id 对不上时那条会打空。卸载后必须把「现在开着的全集」
    // 报成空，宿主按全集对账才会把原生窗口收走。
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith({ ids: [] }));
  });

  it('reports the tab set to the host while mounted', async () => {
    render(<BrowserTab tabKey="web" url="https://example.com/" onNavigate={vi.fn()} />);

    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith({ ids: ['browser:web'] }));
  });

  it('hides the window when the tab is covered by another page', async () => {
    // 切到设置页 / 素材库时，标签区的几何一点没变，只是被盖住了。
    // 原生窗口是独立窗口、层级更高，不主动藏就会一直浮在最前面。
    render(<BrowserTab tabKey="web" url="https://example.com/" onNavigate={() => {}} />);
    await waitFor(() => expect(mocks.show).toHaveBeenCalled());

    // 让采样点全部命中「别的层」
    const cover = document.createElement('div');
    document.body.appendChild(cover);
    const original = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => cover,
    });
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      await waitFor(() => {
        const calls = mocks.setRegion.mock.calls as unknown as Array<[{ visible: boolean }]>;
        expect(calls.some(([arg]) => arg.visible === false)).toBe(true);
      });
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: original,
      });
      cover.remove();
    }
  });

  it('closes every window when the page goes away', async () => {
    // 整页重载 / 关闭窗口后，宿主里开着的原生窗口没人认领了，得一次性收干净
    render(<BrowserTab tabKey="web" url="https://example.com/" onNavigate={() => {}} />);
    await waitFor(() => expect(mocks.show).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(mocks.closeAll).toHaveBeenCalled());
  });
});
