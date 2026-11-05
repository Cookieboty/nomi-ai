/**
 * 视图窗口契约传输：Go 宿主回环 WS 的判定与 surface 传递。
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

import { installGoHostTransport } from '../src/hostTransport';

const TOKEN = 'tok_aaaaaaaaaaaaaaaa'; // 16+ 字符，满足 token 格式
const WS_URL = 'ws://127.0.0.1:9999';

function setHash(hash: string): void {
  window.location.hash = hash;
}

beforeEach(() => {
  installed.mockClear();
  fakeTransports.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setHash('');
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
