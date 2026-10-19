jest.unmock('fs');
const sent: unknown[] = [];
jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (_c: string, p: unknown) => sent.push(p) } },
    ],
  },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  nativeTheme: { shouldUseDarkColors: true, on: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ThemeService, resolveTheme } from '../../../src/theme/ThemeService';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'theme.json');
const fakeNative = (dark: boolean) => {
  let cb: () => void = () => undefined;
  return {
    shouldUseDarkColors: dark,
    on: (_e: 'updated', fn: () => void) => {
      cb = fn;
    },
    fire: () => cb(),
  };
};

describe('ThemeService', () => {
  beforeEach(() => (sent.length = 0));
  it('defaults new users to Sunset Orange, respects saved choice', () => {
    const f = tmp();
    expect(new ThemeService(f, fakeNative(true)).get()).toEqual({
      pref: 'sunset',
      resolved: 'sunset',
    });
    fs.writeFileSync(f, JSON.stringify({ theme: 'mist' }));
    expect(new ThemeService(f, fakeNative(true)).get().pref).toBe('mist');
  });
  it('migrates legacy paper to cream', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ theme: 'paper' }));
    expect(new ThemeService(f, fakeNative(false)).get()).toEqual({
      pref: 'cream',
      resolved: 'cream',
    });
  });
  it('system follows nativeTheme live: dark → graphite, light → cream', () => {
    const n = fakeNative(true);
    const s = new ThemeService(tmp(), n);
    expect(s.set('system')).toEqual({ pref: 'system', resolved: 'graphite' });
    n.shouldUseDarkColors = false;
    n.fire();
    expect(sent.at(-1)).toEqual({ pref: 'system', resolved: 'cream' });
    expect(resolveTheme('cream', true)).toBe('cream');
    expect(s.set('paper')).toEqual({ pref: 'cream', resolved: 'cream' });
    expect(() => s.set('neon')).toThrow();
  });
});
