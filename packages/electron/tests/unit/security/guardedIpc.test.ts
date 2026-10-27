const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();

jest.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    removeHandler: (ch: string) => handlers.delete(ch),
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      if (handlers.has(ch)) throw new Error(`second handler for ${ch}`);
      handlers.set(ch, fn);
    },
  },
}));

import { resetIpcChannelsForTest } from '../../../src/handlers/ipc/channelRegistry';
import { guardedHandle, isTrustedInvokeEvent } from '../../../src/security/guardedIpc';

const ev = (url: string, frameUrl?: string) => ({
  sender: { getURL: () => url },
  ...(frameUrl !== undefined ? { senderFrame: { url: frameUrl } } : {}),
});

describe('guardedHandle', () => {
  beforeEach(() => {
    handlers.clear();
    resetIpcChannelsForTest();
  });

  it('伪造 / 外部 sender 一律拒绝，handler 不会被调用', async () => {
    const fn = jest.fn(() => 'secret');
    guardedHandle('ai:test:x', fn, { owner: 'T' });
    const h = handlers.get('ai:test:x')!;
    await expect(h(ev('https://evil.example/'))).rejects.toThrow(/untrusted sender/);
    await expect(h(ev('http://127.0.0.1:6128/'))).rejects.toThrow(/untrusted sender/);
    await expect(h({})).rejects.toThrow(/untrusted sender/);
    await expect(h({ sender: { getURL: () => 'not a url' } })).rejects.toThrow(/untrusted/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('受信页面里的外部 iframe 也拒绝', async () => {
    guardedHandle('ai:test:frame', () => 1, { owner: 'T' });
    const h = handlers.get('ai:test:frame')!;
    await expect(h(ev('file:///app/index.html', 'https://evil.example/'))).rejects.toThrow(
      /untrusted/,
    );
    await expect(h(ev('file:///app/index.html', 'file:///app/frame.html'))).resolves.toBe(1);
  });

  it('受信 sender 正常调用，错误被包成 __error 信封', async () => {
    guardedHandle('ai:test:ok', (a) => `got ${String(a)}`, { owner: 'T' });
    guardedHandle(
      'ai:test:err',
      () => {
        throw new Error('boom');
      },
      { owner: 'T' },
    );
    await expect(handlers.get('ai:test:ok')!(ev('file:///app/index.html'), 7)).resolves.toBe(
      'got 7',
    );
    await expect(handlers.get('ai:test:err')!(ev('file:///app/index.html'))).resolves.toEqual({
      __error: { message: 'boom' },
    });
  });

  it('业务错误码随信封带给界面；不像错误码的（含系统 errno）不带', async () => {
    const thrower = (code: unknown) => () => {
      throw Object.assign(new Error('msg'), { code });
    };
    guardedHandle('ai:test:code', thrower('unknown-live'), { owner: 'T' });
    guardedHandle('ai:test:errno', thrower('ENOENT'), { owner: 'T' });
    guardedHandle('ai:test:weird', thrower({ x: 1 }), { owner: 'T' });
    const call = (ch: string) => handlers.get(ch)!(ev('file:///app/index.html'));
    await expect(call('ai:test:code')).resolves.toEqual({
      __error: { message: 'msg', code: 'unknown-live' },
    });
    await expect(call('ai:test:errno')).resolves.toEqual({ __error: { message: 'msg' } });
    await expect(call('ai:test:weird')).resolves.toEqual({ __error: { message: 'msg' } });
  });

  it('同一所有者重复注册幂等，不同所有者抢同一通道直接抛错', () => {
    guardedHandle('ai:test:dup', () => 1, { owner: 'A' });
    expect(() => guardedHandle('ai:test:dup', () => 2, { owner: 'A' })).not.toThrow();
    expect(() => guardedHandle('ai:test:dup', () => 3, { owner: 'B' })).toThrow(
      /already registered by A/,
    );
  });

  it('isTrustedInvokeEvent：file:// 放行，http(s) 外站拒绝', () => {
    expect(isTrustedInvokeEvent(ev('file:///x/index.html'))).toBe(true);
    expect(isTrustedInvokeEvent(ev('https://example.com'))).toBe(false);
    expect(isTrustedInvokeEvent(undefined)).toBe(false);
  });
});
