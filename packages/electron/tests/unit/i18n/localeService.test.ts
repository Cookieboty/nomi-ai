jest.unmock('fs');
const sent: unknown[] = [];
let sysLangs = ['en-US'];
jest.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => sysLangs, getLocale: () => sysLangs[0] },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (_c: string, p: unknown) => sent.push(p) } },
    ],
  },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocaleService, onLocaleChange, resolveLocale, t } from '../../../src/i18n';
import en from '../../../src/i18n/en.json';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'locale-')), 'locale.json');

describe('main-process i18n', () => {
  beforeEach(() => {
    sent.length = 0;
    delete process.env.CD_LOCALE;
  });

  it('resolves system locale: zh* → zh-CN, otherwise en', () => {
    expect(resolveLocale('system', ['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR'])).toBe('en');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
  });

  it('follows the system for new users and respects a saved choice', () => {
    sysLangs = ['zh-CN'];
    expect(new LocaleService(tmp()).get()).toEqual({ pref: 'system', locale: 'zh-CN' });
    expect(t('退出')).toBe('退出');
    sysLangs = ['en-US'];
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ locale: 'zh-CN' }));
    expect(new LocaleService(f).get()).toEqual({ pref: 'zh-CN', locale: 'zh-CN' });
  });

  it('switches live: persists, broadcasts and notifies (tray rebuild)', () => {
    sysLangs = ['zh-CN'];
    const f = tmp();
    const s = new LocaleService(f);
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    expect(s.set('en')).toEqual({ pref: 'en', locale: 'en' });
    expect(sent.at(-1)).toEqual({ pref: 'en', locale: 'en' });
    expect(seen).toEqual(['en']);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ locale: 'en' });
    expect(t('退出')).toBe('Quit');
    expect(t('读取失败：{0}', 'x')).toBe('Read failed: x');
    // 常量标签作为参数时一并翻译；非字符串原样返回
    expect(t('{0} · {1}', 'Nomi', '模型')).toBe('Nomi · model');
    expect(t(undefined)).toBeUndefined();
    expect(() => s.set('fr')).toThrow();
    off();
    s.set('zh-CN');
  });

  it('every English entry keeps the placeholders of its key', () => {
    for (const [k, v] of Object.entries(en as Record<string, string>)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect([k, ph(v)]).toEqual([k, ph(k)]);
    }
  });
});
