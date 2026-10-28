jest.unmock('fs');
let sysLangs = ['en-US'];
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDictionary } from '@nomi-ai/i18n';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import { LOCALE_CHANGED, LocaleService, onLocaleChange, resolveLocale, t } from '../../../src/i18n';

let events: RecordingAppEvents = createRecordingAppEvents();
const make = (file: string) =>
  new LocaleService({
    file,
    ports: {
      app: { locale: () => sysLangs[0] ?? '', preferredLanguages: () => sysLangs } as never,
    },
    events,
  });

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'locale-')), 'locale.json');

describe('main-process i18n', () => {
  beforeEach(() => {
    events = createRecordingAppEvents();
    delete process.env.CD_LOCALE;
  });

  it('resolves system locale: zh* → zh-CN, otherwise en', () => {
    expect(resolveLocale('system', ['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR'])).toBe('en');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
  });

  it('follows the system for new users and respects a saved choice', () => {
    sysLangs = ['zh-CN'];
    expect(make(tmp()).get()).toEqual({ pref: 'system', locale: 'zh-CN' });
    expect(t('electron.common.quit')).toBe('退出');
    sysLangs = ['en-US'];
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ locale: 'zh-CN' }));
    expect(make(f).get()).toEqual({ pref: 'zh-CN', locale: 'zh-CN' });
  });

  it('switches live: persists, broadcasts and notifies (tray rebuild)', () => {
    sysLangs = ['zh-CN'];
    const f = tmp();
    const s = make(f);
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    expect(s.set('en')).toEqual({ pref: 'en', locale: 'en' });
    expect(events.published.at(-1)).toEqual({
      channel: LOCALE_CHANGED,
      payload: { pref: 'en', locale: 'en' },
      surfaces: null,
    });
    expect(seen).toEqual(['en']);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ locale: 'en' });
    expect(t('electron.common.quit')).toBe('Quit');
    expect(t('electron.common.read-failed', 'x')).toBe('Read failed: x');
    // 常量标签作为参数时一并翻译；非字符串原样返回
    expect(t('{0} · {1}', 'Nomi', 'electron.common.model')).toBe('Nomi · model');
    expect(t(undefined)).toBeUndefined();
    expect(() => s.set('fr')).toThrow();
    off();
    s.set('zh-CN');
  });

  it('every English entry keeps the placeholders of the Chinese entry', () => {
    const zh = getDictionary('zh');
    const en = getDictionary('en');
    for (const k of Object.keys(zh)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(en[k])).toBe(ph(zh[k]));
    }
  });
});
