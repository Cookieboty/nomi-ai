import { NOMI_HOST_GLOBAL } from '@nomi-ai/contract/app';
import { describe, expect, it, vi } from 'vitest';

import { mkNomiHostPreload, NOMI_HOST_BRIDGE_NAME } from '../src/preload/mkNomiHostPreload';

describe('mkNomiHostPreload', () => {
  it('全局名与契约常量一致', () => {
    expect(NOMI_HOST_BRIDGE_NAME).toBe(NOMI_HOST_GLOBAL);
  });

  it('暴露 pathForFile：转给 webUtils；没有路径或不是 File 时为空串', () => {
    const contextBridge = { exposeInMainWorld: vi.fn() };
    const getPathForFile = vi.fn((f: File) => {
      if ((f as unknown as { fake?: boolean }).fake) throw new TypeError('not a File');
      return (f as unknown as { p?: string }).p ?? '';
    });
    const api = mkNomiHostPreload({ contextBridge, webUtils: { getPathForFile } });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('nomiHost', api);
    expect(Object.keys(api)).toEqual(['pathForFile']);
    expect(api.pathForFile({ p: '/tmp/a.txt' } as unknown as File)).toBe('/tmp/a.txt');
    expect(api.pathForFile({} as unknown as File)).toBe('');
    expect(api.pathForFile({ fake: true } as unknown as File)).toBe('');
  });
});
