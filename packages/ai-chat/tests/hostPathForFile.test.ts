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

  it('asks the host for clipboard paths when files are pasted', async () => {
    const posted: string[] = [];
    (window as unknown as Record<string, unknown>).webkit = {
      messageHandlers: { external: { postMessage: (m: string) => posted.push(m) } },
    };
    await loadGoHostApi();
    const paste = (files: File[]) => {
      const e = new Event('paste');
      Object.defineProperty(e, 'clipboardData', { value: { files } });
      window.dispatchEvent(e);
    };
    paste([]);
    expect(posted).toEqual([]);
    paste([new File(['x'], 'd.txt')]);
    // 前面用例 resetModules 留下的监听也挂在同一个 window 上：只看有没有发、发的是不是这条
    expect(posted.length).toBeGreaterThan(0);
    expect(new Set(posted)).toEqual(new Set(['nomi:clipboard-files']));
    delete (window as unknown as Record<string, unknown>).webkit;
  });

  describe('只有宿主路径的拖入（macOS / Linux：原生拖放层接走了 DOM drop）', () => {
    const drop = (entries: unknown[]) =>
      window.dispatchEvent(new CustomEvent('nomi:host-files', { detail: entries }));
    const domDrop = () => {
      const e = new Event('drop');
      Object.defineProperty(e, 'dataTransfer', { value: { files: [new File(['x'], 'a.png')] } });
      window.dispatchEvent(e);
    };

    it('没有 DOM drop：稍等后交给订阅方，带名字、临时地址与大小；配对缓存里不再留', async () => {
      vi.useFakeTimers();
      const api = await loadGoHostApi();
      const got: unknown[] = [];
      api.onHostOnlyFiles((f) => got.push(...f));
      drop([
        { path: '/Users/me/Pictures/cat.png', url: '/__nomi/drop/abc', size: 3 },
        { path: '/Users/me/report.pdf', url: '/__nomi/drop/def', size: 9 },
      ]);
      await vi.advanceTimersByTimeAsync(299);
      expect(got).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(got).toEqual([
        { path: '/Users/me/Pictures/cat.png', name: 'cat.png', url: '/__nomi/drop/abc', size: 3 },
        { path: '/Users/me/report.pdf', name: 'report.pdf', url: '/__nomi/drop/def', size: 9 },
      ]);
      const left = api.hostPathForFile(new File(['x'], 'cat.png'));
      await vi.advanceTimersByTimeAsync(600);
      await expect(left).resolves.toBe('');
      vi.useRealTimers();
    });

    it('网页自己收到了 DOM drop（Windows）：只配对路径，不再交给订阅方', async () => {
      vi.useFakeTimers();
      const api = await loadGoHostApi();
      const got: unknown[] = [];
      api.onHostOnlyFiles((f) => got.push(...f));
      domDrop();
      drop([{ path: 'C:\\Users\\me\\a.png', url: '/__nomi/drop/x', size: 1 }]);
      await vi.advanceTimersByTimeAsync(400);
      expect(got).toEqual([]);
      vi.useRealTimers();
    });

    it('粘贴送来的是路径数组（没有临时地址）：从不当作只有宿主', async () => {
      vi.useFakeTimers();
      const api = await loadGoHostApi();
      const got: unknown[] = [];
      api.onHostOnlyFiles((f) => got.push(...f));
      drop(['/Users/me/d.txt']);
      await vi.advanceTimersByTimeAsync(400);
      expect(got).toEqual([]);
      vi.useRealTimers();
    });

    it('只认同源的临时地址前缀', async () => {
      const api = await loadGoHostApi();
      expect(
        api.parseHostFiles([
          { path: '/a.png', url: 'https://evil.example/a.png' },
          { path: '/b.png', url: '/__nomi/drop/t' },
          42,
        ]),
      ).toEqual([
        { path: '/a.png', name: 'a.png' },
        { path: '/b.png', name: 'b.png', url: '/__nomi/drop/t' },
      ]);
    });
  });
});
