// @vitest-environment happy-dom
/**
 * Go 宿主下拖入文件的本机路径：宿主经 `nomi:host-files` 事件送来原生拖放的路径，hostPathForFile 按文件名配对
 * （事件先到、调用先到两种顺序都要能配上；配不上时等一会儿后返回空串）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = '0123456789abcdef0123456789abcdef';

async function loadGoHostApi() {
  vi.resetModules();
  window.location.hash = `#ws=${encodeURIComponent('ws://127.0.0.1:1')}&token=${TOKEN}`;
  return import('../src/services/api');
}

const send = (paths: string[]) =>
  window.dispatchEvent(new CustomEvent('nomi:host-files', { detail: paths }));

describe('hostPathForFile (Go host)', () => {
  beforeEach(() => {
    // 不真的连 WebSocket
    vi.stubGlobal(
      'WebSocket',
      class {
        readyState = 0;
        addEventListener() {}
        removeEventListener() {}
        close() {}
        send() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('pairs a dropped path that arrived before the call', async () => {
    const api = await loadGoHostApi();
    expect(document.body.hasAttribute('data-file-drop-target')).toBe(true);
    send(['/Users/me/docs/a.txt', '/Users/me/b.md']);
    await expect(api.hostPathForFile(new File(['x'], 'b.md'))).resolves.toBe('/Users/me/b.md');
    await expect(api.hostPathForFile(new File(['x'], 'a.txt'))).resolves.toBe(
      '/Users/me/docs/a.txt',
    );
    // 已消费
    vi.useFakeTimers();
    const again = api.hostPathForFile(new File(['x'], 'a.txt'));
    await vi.advanceTimersByTimeAsync(600);
    await expect(again).resolves.toBe('');
    vi.useRealTimers();
  });

  it('waits for a path that arrives after the call', async () => {
    const api = await loadGoHostApi();
    const pending = api.hostPathForFile(new File(['x'], 'c.pdf'));
    send(['C:\\Users\\me\\c.pdf']);
    await expect(pending).resolves.toBe('C:\\Users\\me\\c.pdf');
  });
});
