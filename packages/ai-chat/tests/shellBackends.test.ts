// @vitest-environment happy-dom
/**
 * D2 · 共享包注入点（services/hostBackends/shell.ts）：`@nomi-ai/ui` 的主题与语言经契约
 * `theme.*` / `locale.*` 与主进程同步——启动时读一次、订阅变化、设置时写回主进程确认的值。
 */
import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import {
  DEFAULT_THEME,
  applyLocale,
  applyTheme,
  currentTheme,
  getLocale,
  getLocalePref,
  initLocale,
  initTheme,
  setLocaleBackend,
  setLocalePref,
  setTheme,
  setThemeBackend,
} from '@nomi-ai/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installShellBackends } from '../src/services/hostBackends/shell';

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  setThemeBackend(null);
  setLocaleBackend(null);
  applyTheme(DEFAULT_THEME);
  applyLocale('zh-CN');
  localStorage.clear();
});

describe('hostBackends/shell', () => {
  it('主题：启动时以主进程为准，订阅 theme.changed，设置时写回', async () => {
    const set = vi.fn(({ pref }: { pref: string }) => ({
      pref: pref as 'mist',
      resolved: 'mist' as const,
    }));
    const { api, router, close } = createTestClient(
      appContract,
      { 'theme.get': () => ({ pref: 'ink', resolved: 'ink' }), 'theme.set': set },
      { caller: { surface: 'chat', trusted: true } },
    );
    installShellBackends(api);
    try {
      const off = initTheme();
      await vi.waitFor(() => expect(currentTheme()).toEqual({ pref: 'ink', resolved: 'ink' }));
      await tick();
      router.events.publish('theme.changed', { pref: 'system', resolved: 'graphite' });
      await vi.waitFor(() =>
        expect(currentTheme()).toEqual({ pref: 'system', resolved: 'graphite' }),
      );
      expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');
      await setTheme('mist');
      expect(set).toHaveBeenCalledWith({ pref: 'mist' }, expect.anything());
      expect(currentTheme()).toEqual({ pref: 'mist', resolved: 'mist' });
      off();
    } finally {
      close();
    }
  });

  it('语言：启动时以主进程为准，订阅 locale.changed，设置时写回', async () => {
    const set = vi.fn(({ pref }: { pref: string }) => ({
      pref: pref as 'zh-CN',
      locale: 'zh-CN' as const,
    }));
    const { api, router, close } = createTestClient(
      appContract,
      { 'locale.get': () => ({ pref: 'en', locale: 'en' }), 'locale.set': set },
      { caller: { surface: 'mascot', trusted: true } },
    );
    installShellBackends(api);
    try {
      const off = initLocale();
      await vi.waitFor(() => expect(getLocale()).toBe('en'));
      await tick();
      router.events.publish('locale.changed', { pref: 'system', locale: 'zh-CN' });
      await vi.waitFor(() => expect(getLocalePref()).toBe('system'));
      expect(getLocale()).toBe('zh-CN');
      await setLocalePref('zh-CN');
      expect(set).toHaveBeenCalledWith({ pref: 'zh-CN' }, expect.anything());
      expect(getLocalePref()).toBe('zh-CN');
      off();
    } finally {
      close();
    }
  });

  it('主进程没有回应（失败）时保留本地选择', async () => {
    const { api, close } = createTestClient(
      appContract,
      {
        'theme.set': () => {
          throw new Error('disk full');
        },
      },
      { caller: { surface: 'chat', trusted: true } },
    );
    installShellBackends(api);
    try {
      await setTheme('cream');
      expect(currentTheme()).toEqual({ pref: 'cream', resolved: 'cream' });
    } finally {
      close();
    }
  });
});
