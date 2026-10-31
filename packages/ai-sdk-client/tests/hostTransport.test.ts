/**
 * 视图窗口契约传输选择：preload 桥 / Go 宿主回环 WS / 开发态 WS 的判定、surface 传递与优先级，
 * 以及生产构建不调 installDevTransport 时开发态分支天然不生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installed = vi.fn();

vi.mock('../src/sharedTransport', () => ({
  installSharedTransport: (t: unknown) => installed(t),
}));

const fakeTransports: unknown[] = [];
vi.mock('@nomi-ai/contract', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    createWebSocketClientTransport: (options: { url: string; token: string; surface: string }) => {
      const t = { __ws: true, ...options };
      fakeTransports.push(t);
      return t;
    },
  };
});

import {
  hasPreloadBridge,
  hasTransport,
  hasWindowHost,
  installDevTransport,
  installGoHostTransport,
} from '../src/hostTransport';

const TOKEN = 'tok_aaaaaaaaaaaaaaaa'; // 16+ 字符，满足 DEV_TOKEN_PATTERN
const WS_URL = 'ws://127.0.0.1:9999';

const w = (): Window & typeof globalThis => globalThis as unknown as Window & typeof globalThis;

function setHash(hash: string): void {
  window.location.hash = hash;
}

beforeEach(() => {
  installed.mockClear();
  fakeTransports.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (w() as unknown as Record<string, unknown>).nomiTransport;
  delete (w() as unknown as Record<string, unknown>).nomiDevTransport;
  window.sessionStorage.clear();
  setHash('');
});

describe('hasPreloadBridge', () => {
  it('window.nomiTransport 是对象时为 true', () => {
    expect(hasPreloadBridge()).toBe(false);
    (w() as unknown as Record<string, unknown>).nomiTransport = {};
    expect(hasPreloadBridge()).toBe(true);
  });
});

describe('installGoHostTransport', () => {
  it('片段里有回环地址与 token：装 WebSocket，surface 用窗口界面', () => {
    setHash(`#ws=${WS_URL}&token=${TOKEN}`);
    expect(installGoHostTransport('mascot')).toBe(true);
    expect(installed).toHaveBeenCalledTimes(1);
    expect(fakeTransports[0]).toMatchObject({
      __ws: true,
      url: WS_URL,
      token: TOKEN,
      surface: 'mascot',
    });
  });

  it('非回环地址 / token 不合法 / 无片段：返回 false，不装传输', () => {
    setHash('#ws=ws://10.0.0.1:9&token=' + TOKEN);
    expect(installGoHostTransport('chat')).toBe(false);
    setHash(`#ws=${WS_URL}&token=bad`);
    expect(installGoHostTransport('chat')).toBe(false);
    setHash('');
    expect(installGoHostTransport('chat')).toBe(false);
    expect(installed).not.toHaveBeenCalled();
  });

  it('没有 window（Node / SSR）：返回 false，不抛异常', () => {
    vi.stubGlobal('window', undefined);
    expect(installGoHostTransport('chat')).toBe(false);
    expect(installed).not.toHaveBeenCalled();
  });
});

describe('installDevTransport', () => {
  it('有注入地址 + 片段 token：装开发态 WebSocket，并从地址栏抹掉 token', () => {
    (w() as unknown as Record<string, unknown>).nomiDevTransport = { url: WS_URL };
    setHash(`#nomi-token=${TOKEN}`);
    expect(installDevTransport('chat')).toBe(true);
    expect(fakeTransports[0]).toMatchObject({
      __ws: true,
      url: WS_URL,
      token: TOKEN,
      surface: 'chat',
    });
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem('nomi.devToken')).toBe(TOKEN);
  });

  it('token 只在 sessionStorage（刷新页面）：仍能装上', () => {
    (w() as unknown as Record<string, unknown>).nomiDevTransport = { url: WS_URL };
    window.sessionStorage.setItem('nomi.devToken', TOKEN);
    setHash('');
    expect(installDevTransport('chat')).toBe(true);
  });

  it('没有注入 / 没有 token：返回 false，不装传输', () => {
    expect(installDevTransport('chat')).toBe(false);
    (w() as unknown as Record<string, unknown>).nomiDevTransport = { url: WS_URL };
    setHash('');
    expect(installDevTransport('chat')).toBe(false);
    expect(installed).not.toHaveBeenCalled();
  });

  it('没有 window：返回 false', () => {
    vi.stubGlobal('window', undefined);
    expect(installDevTransport('chat')).toBe(false);
  });
});

describe('hasTransport / hasWindowHost', () => {
  it('三种在位标志的组合', () => {
    expect(hasTransport({ hasPreload: false, isGoHost: false, isDev: false })).toBe(false);
    expect(hasTransport({ hasPreload: true, isGoHost: false, isDev: false })).toBe(true);
    expect(hasTransport({ hasPreload: false, isGoHost: true, isDev: false })).toBe(true);
    expect(hasTransport({ hasPreload: false, isGoHost: false, isDev: true })).toBe(true);
    // 浏览器开发页有传输但没有桌面窗口宿主
    expect(hasWindowHost({ hasPreload: false, isGoHost: false, isDev: true })).toBe(false);
    expect(hasWindowHost({ hasPreload: true, isGoHost: false, isDev: false })).toBe(true);
    expect(hasWindowHost({ hasPreload: false, isGoHost: true, isDev: false })).toBe(true);
  });
});
