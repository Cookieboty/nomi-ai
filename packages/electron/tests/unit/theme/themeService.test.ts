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

import { THEME_CHROME } from '../../../src/core/titleBar';
import {
  THEME_IDS,
  ThemeService,
  appearanceFor,
  resolveTheme,
} from '../../../src/theme/ThemeService';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'theme.json');
const fakeNative = (dark: boolean) => {
  let cb: () => void = () => undefined;
  return {
    shouldUseDarkColors: dark,
    themeSource: 'system' as 'system' | 'dark' | 'light',
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
  it('rejects removed paper id and falls back to default', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ theme: 'paper' }));
    expect(new ThemeService(f, fakeNative(false)).get()).toEqual({
      pref: 'sunset',
      resolved: 'sunset',
    });
  });
  it('persists image theme with graphite chrome and a dark native appearance', () => {
    const file = tmp();
    const native = fakeNative(false);
    const service = new ThemeService(file, native, 'darwin');
    expect(service.set('image')).toEqual({ pref: 'image', resolved: 'graphite' });
    expect(native.themeSource).toBe('dark');
    expect(sent.at(-1)).toEqual({ pref: 'image', resolved: 'graphite' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).theme).toBe('image');
    expect(new ThemeService(file, fakeNative(false)).get()).toEqual({
      pref: 'image',
      resolved: 'graphite',
    });
    expect(resolveTheme('image', false)).toBe('graphite');
    expect(appearanceFor('image')).toBe('dark');
  });
  it('system follows nativeTheme live: dark → graphite, light → cream', () => {
    const n = fakeNative(true);
    const s = new ThemeService(tmp(), n);
    expect(s.set('system')).toEqual({ pref: 'system', resolved: 'graphite' });
    n.shouldUseDarkColors = false;
    n.fire();
    expect(sent.at(-1)).toEqual({ pref: 'system', resolved: 'cream' });
    expect(resolveTheme('cream', true)).toBe('cream');
    expect(() => s.set('paper')).toThrow();
    expect(() => s.set('neon')).toThrow();
  });

  it('macOS：窗口外观跟随所选主题（失焦时红绿灯与标题栏同色系），跟随系统时交还系统', () => {
    const n = fakeNative(false);
    const s = new ThemeService(tmp(), n, 'darwin');
    expect(n.themeSource).toBe('light'); // 默认 sunset
    s.set('graphite');
    expect(n.themeSource).toBe('dark');
    s.set('ink');
    expect(n.themeSource).toBe('dark');
    s.set('cream');
    expect(n.themeSource).toBe('light');
    s.set('system');
    expect(n.themeSource).toBe('system');
  });
  it('非 macOS 不改原生外观', () => {
    const n = fakeNative(false);
    new ThemeService(tmp(), n, 'win32').set('graphite');
    expect(n.themeSource).toBe('system');
  });

  it('深色 / 浅色外观与各主题标题栏底色一致', () => {
    for (const id of THEME_IDS) {
      const bg = THEME_CHROME[id].bg;
      const sum = [1, 3, 5].reduce((a, i) => a + parseInt(bg.slice(i, i + 2), 16), 0);
      expect(appearanceFor(id)).toBe(sum < 3 * 128 ? 'dark' : 'light');
    }
  });
});
