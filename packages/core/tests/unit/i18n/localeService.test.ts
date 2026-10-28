jest.unmock('fs');
let sysLangs = ['en-US'];
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDictionary } from '@nomi-ai/i18n';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import { createCoreScope, runInCoreScope } from '../../../src/core/scope';
import { getLocale, LocaleService, resolveLocale, t } from '../../../src/i18n';

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
    const s0 = make(tmp());
    expect(s0.get()).toEqual({ pref: 'system', locale: 'zh-CN' });
    expect(s0.t('electron.common.quit')).toBe('退出');
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
    const off = s.onChange((l) => seen.push(l));
    expect(s.set('en')).toEqual({ pref: 'en', locale: 'en' });
    expect(events.published.at(-1)).toEqual({
      event: 'locale.changed',
      payload: { pref: 'en', locale: 'en' },
      surfaces: null,
    });
    expect(seen).toEqual(['en']);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ locale: 'en' });
    expect(s.t('electron.common.quit')).toBe('Quit');
    expect(s.t('electron.common.read-failed', 'x')).toBe('Read failed: x');
    // 常量标签作为参数时一并翻译；非字符串原样返回
    expect(s.t('{0} · {1}', 'Nomi', 'electron.common.model')).toBe('Nomi · model');
    expect(s.t(undefined)).toBeUndefined();
    expect(() => s.set('fr')).toThrow();
    off();
    s.set('zh-CN');
  });

  it('each instance owns its locale; module t() follows the current core scope', async () => {
    sysLangs = ['zh-CN'];
    const zh = make(tmp());
    const en = make(tmp());
    en.set('en');
    expect(zh.locale()).toBe('zh-CN');
    expect(en.locale()).toBe('en');
    const a = createCoreScope({ i18n: zh });
    const b = createCoreScope({ i18n: en });
    expect(runInCoreScope(a, () => t('electron.common.quit'))).toBe('退出');
    expect(runInCoreScope(b, () => t('electron.common.quit'))).toBe('Quit');
    // 异步延续沿用进入时的作用域
    const later = await runInCoreScope(b, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return [t('electron.common.quit'), getLocale()];
    });
    expect(later).toEqual(['Quit', 'en']);
    // 不在任何内核里：不可变默认（中文），不受实例切换影响
    expect(t('electron.common.quit')).toBe('退出');
    expect(getLocale()).toBe('zh-CN');
    process.env.CD_LOCALE = 'en-US';
    expect(t('electron.common.quit')).toBe('Quit');
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
