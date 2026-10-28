jest.unmock('fs');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HostPlatform, NativeAppearance } from '@nomi-ai/host-ports';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import { THEME_CHROME } from '../../../src/core/titleBar';
import {
  THEME_CHANGED,
  THEME_IDS,
  ThemeService,
  appearanceFor,
  resolveTheme,
} from '../../../src/theme/ThemeService';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'theme.json');

/** appearance 端口的假实现：systemDark 模拟系统设置，themeSource 记录原生外观 */
const fakeNative = (dark: boolean) => {
  let cb: () => void = () => undefined;
  const n = {
    systemDark: dark,
    themeSource: 'system' as NativeAppearance,
    fire: () => cb(),
    appearance: {
      isDark: () => (n.themeSource === 'system' ? n.systemDark : n.themeSource === 'dark'),
      windowAppearance: () => n.themeSource,
      setWindowAppearance: (mode: NativeAppearance) => {
        n.themeSource = mode;
      },
      onChange: (fn: () => void) => {
        cb = fn;
        return () => undefined;
      },
    },
  };
  return n;
};

let events: RecordingAppEvents;
const make = (file: string, n = fakeNative(false), platform: HostPlatform = 'linux') =>
  new ThemeService({
    file,
    ports: { appearance: n.appearance, app: { platform: () => platform } as never },
    events,
  });

describe('ThemeService', () => {
  beforeEach(() => (events = createRecordingAppEvents()));
  it('defaults new users to Sunset Orange, respects saved choice', () => {
    const f = tmp();
    expect(make(f, fakeNative(true)).get()).toEqual({
      pref: 'sunset',
      resolved: 'sunset',
    });
    fs.writeFileSync(f, JSON.stringify({ theme: 'mist' }));
    expect(make(f, fakeNative(true)).get().pref).toBe('mist');
  });
  it('migrates legacy paper id to cream and writes it back', () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ theme: 'paper' }));
    expect(make(f, fakeNative(false)).get()).toEqual({
      pref: 'cream',
      resolved: 'cream',
    });
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).theme).toBe('cream');
  });
  it('persists image theme with graphite chrome and a dark native appearance', () => {
    const file = tmp();
    const native = fakeNative(false);
    const service = make(file, native, 'darwin');
    expect(service.set('image')).toEqual({ pref: 'image', resolved: 'graphite' });
    expect(native.themeSource).toBe('dark');
    expect(events.published.at(-1)).toEqual({
      channel: THEME_CHANGED,
      payload: { pref: 'image', resolved: 'graphite' },
      surfaces: null, // 与迁移前一样发给所有窗口
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).theme).toBe('image');
    expect(make(file, fakeNative(false)).get()).toEqual({
      pref: 'image',
      resolved: 'graphite',
    });
    expect(resolveTheme('image', false)).toBe('graphite');
    expect(appearanceFor('image')).toBe('dark');
  });
  it('system follows nativeTheme live: dark → graphite, light → cream', () => {
    const n = fakeNative(true);
    const s = make(tmp(), n);
    expect(s.set('system')).toEqual({ pref: 'system', resolved: 'graphite' });
    n.systemDark = false;
    n.fire();
    expect(events.last(THEME_CHANGED)).toEqual({ pref: 'system', resolved: 'cream' });
    expect(resolveTheme('cream', true)).toBe('cream');
    expect(() => s.set('neon')).toThrow();
  });

  it('固定主题时系统切换不通知；onChange 回调与界面事件同步', () => {
    const n = fakeNative(true);
    const s = make(tmp(), n);
    const seen: unknown[] = [];
    s.onChange((st) => seen.push(st));
    s.set('mist');
    const before = events.published.length;
    n.systemDark = false;
    n.fire();
    expect(events.published).toHaveLength(before);
    expect(seen).toEqual([{ pref: 'mist', resolved: 'mist' }]);
  });

  it('macOS：窗口外观跟随所选主题（失焦时红绿灯与标题栏同色系），跟随系统时交还系统', () => {
    const n = fakeNative(false);
    const s = make(tmp(), n, 'darwin');
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
    make(tmp(), n, 'win32').set('graphite');
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
