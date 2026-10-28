import { NOMI_HOST_GLOBAL } from '@nomi-ai/contract/app';
import { describe, expect, it, vi } from 'vitest';

import {
  mkNomiHostPreload,
  NOMI_HOST_BRIDGE_NAME,
  NOMI_HOST_DROP_FILE_CHANNEL,
} from '../src/preload/mkNomiHostPreload';

const getPathForFile = vi.fn((f: File) => {
  if ((f as unknown as { fake?: boolean }).fake) throw new TypeError('not a File');
  return (f as unknown as { p?: string }).p ?? '';
});

describe('mkNomiHostPreload', () => {
  it('全局名与契约常量一致', () => {
    expect(NOMI_HOST_BRIDGE_NAME).toBe(NOMI_HOST_GLOBAL);
  });

  it('暴露 pathForFile：转给 webUtils；没有路径或不是 File 时为空串', () => {
    const contextBridge = { exposeInMainWorld: vi.fn() };
    const api = mkNomiHostPreload({ contextBridge, webUtils: { getPathForFile } });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('nomiHost', api);
    expect(Object.keys(api)).toEqual(['pathForFile', 'dropFile']);
    expect(api.pathForFile({ p: '/tmp/a.txt' } as unknown as File)).toBe('/tmp/a.txt');
    expect(api.pathForFile({} as unknown as File)).toBe('');
    expect(api.pathForFile({ fake: true } as unknown as File)).toBe('');
  });

  it('dropFile：路径在 preload 里由 webUtils 解析并直接提交，视图给不了路径', () => {
    const ipcRenderer = { send: vi.fn() };
    const api = mkNomiHostPreload({
      contextBridge: { exposeInMainWorld: vi.fn() },
      webUtils: { getPathForFile },
      ipcRenderer,
    });

    expect(api.dropFile({ p: '/tmp/a.txt' } as unknown as File)).toBe(true);
    expect(ipcRenderer.send).toHaveBeenCalledWith(NOMI_HOST_DROP_FILE_CHANNEL, '/tmp/a.txt');
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1);

    // 伪造对象 / 字符串都拿不到路径，什么也不发
    expect(api.dropFile({ fake: true, p: '/etc/passwd' } as unknown as File)).toBe(false);
    expect(api.dropFile('~/.ssh/id_rsa' as unknown as File)).toBe(false);
    expect(api.dropFile({} as unknown as File)).toBe(false);
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
  });

  it('dropFile：没有传 ipcRenderer 的 preload（对话窗口）不提交', () => {
    const api = mkNomiHostPreload({
      contextBridge: { exposeInMainWorld: vi.fn() },
      webUtils: { getPathForFile },
    });
    expect(api.dropFile({ p: '/tmp/a.txt' } as unknown as File)).toBe(false);
  });
});
