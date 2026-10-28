import { describe, expect, it } from 'vitest';

import { nomiWindowArg, nomiWindowKindFromArgv } from '../src/preload/windowKind';

describe('preload 窗口类型参数', () => {
  it('主进程给的参数能被 preload 读回', () => {
    expect(nomiWindowKindFromArgv(['electron', '--foo', nomiWindowArg('mascot')])).toBe('mascot');
    expect(nomiWindowKindFromArgv([nomiWindowArg('chat')])).toBe('chat');
  });

  it('没有、为空或不认识的值一律 undefined（拿不到 dropFile）', () => {
    expect(nomiWindowKindFromArgv(undefined)).toBeUndefined();
    expect(nomiWindowKindFromArgv([])).toBeUndefined();
    expect(nomiWindowKindFromArgv(['--nomi-window='])).toBeUndefined();
    expect(nomiWindowKindFromArgv(['--nomi-window=island'])).toBeUndefined();
    expect(nomiWindowKindFromArgv(['--nomi-window-x=mascot'])).toBeUndefined();
  });
});
