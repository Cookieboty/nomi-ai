// @vitest-environment happy-dom
import { appContract } from '@nomi-ai/contract/app';
import { createTestClient } from '@nomi-ai/contract/testing';
import {
  DEFAULT_THEME,
  THEMES,
  applyTheme,
  currentTheme,
  initTheme,
  normalizeThemePref,
  resolveTheme,
  setLocaleBackend,
  setThemeBackend,
} from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  orderThemes,
  ThemeSettings,
  THEMES_FIRST_ROW,
} from '../src/components/SettingsView/ThemeSettings';
import { CHAT_BG_PRESET_URL, setChatBackground } from '../src/services/chatBackground';
import { installShellBackends } from '../src/services/hostBackends/shell';

afterEach(() => {
  cleanup();
  applyTheme(DEFAULT_THEME);
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('themes', () => {
  it('new users default to Light; saved choice respected', () => {
    expect(DEFAULT_THEME).toBe('light');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    localStorage.setItem('cd.theme', 'mist');
    initTheme();
    // 每个主题都写 data-theme（:root 只是浅色的默认值）
    expect(document.documentElement.getAttribute('data-theme')).toBe('mist');
    expect(THEMES.map((t) => t.id).sort()).toEqual([
      'cream',
      'dark',
      'graphite',
      'image',
      'ink',
      'light',
      'mist',
      'sunset',
      'system',
    ]);
  });
  it('maps legacy paper id to cream', () => {
    expect(normalizeThemePref('paper')).toBe('cream');
  });
  it('follow system resolves dark → dark, light → light', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
  it('image theme uses the graphite palette and persists the image preference', () => {
    expect(normalizeThemePref('image')).toBe('image');
    expect(resolveTheme('image', true)).toBe('graphite');
    expect(resolveTheme('image', false)).toBe('graphite');
    localStorage.setItem('cd.theme', 'image');
    initTheme();
    expect(currentTheme()).toEqual({ pref: 'image', resolved: 'graphite' });
    expect(document.documentElement.dataset.themePref).toBe('image');
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });
  it('only image theme reveals image controls and hides them on other themes', async () => {
    applyTheme(DEFAULT_THEME);
    await setChatBackground({ imageUrl: CHAT_BG_PRESET_URL });
    const view = render(<ThemeSettings />);
    // 默认一行 5 个，其余点「更多主题」展开；「跟随系统」是标题行的开关，不占色卡
    expect(view.getAllByRole('radio')).toHaveLength(5);
    expect(view.getByTestId('theme-more').textContent).toContain('3');
    fireEvent.click(view.getByTestId('theme-more'));
    expect(view.getAllByRole('radio')).toHaveLength(8);
    expect(view.queryByTestId('theme-system')).toBeNull();
    expect(view.getByTestId('theme-follow-system')).toBeTruthy();
    expect(view.queryByTestId('image-theme-settings')).toBeNull();
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(view.getByTestId('image-theme-settings')).toBeTruthy());
    expect(view.getAllByRole('slider')).toHaveLength(2);
    expect(view.queryByTestId('settings-chat-bg')).toBeNull();
    fireEvent.click(view.getByTestId('theme-graphite'));
    expect(view.queryByTestId('image-theme-settings')).toBeNull();
    expect(view.queryAllByRole('slider')).toHaveLength(0);
    act(() => applyTheme('image'));
    expect(view.getByTestId('chat-bg-pick')).toBeTruthy();
  });
  it('picker applies theme and persists via the contract (theme.set)', async () => {
    const set = vi.fn(({ pref }: { pref: string }) =>
      pref === 'system'
        ? { pref: 'system' as const, resolved: 'cream' as const }
        : { pref: 'cream' as const, resolved: 'cream' as const },
    );
    const { api, close } = createTestClient(
      appContract,
      { 'theme.set': set },
      { caller: { surface: 'chat', trusted: true } },
    );
    installShellBackends(api);
    try {
      const r = render(<ThemeSettings />);
      fireEvent.click(r.getByTestId('theme-more'));
      fireEvent.click(r.getByTestId('theme-cream'));
      expect(document.documentElement.getAttribute('data-theme')).toBe('cream');
      await waitFor(() => expect(set).toHaveBeenCalledWith({ pref: 'cream' }, expect.anything()));
      expect(r.getByTestId('theme-cream').getAttribute('aria-checked')).toBe('true');
      fireEvent.click(r.getByTestId('theme-follow-system'));
      await waitFor(() => expect(set).toHaveBeenCalledWith({ pref: 'system' }, expect.anything()));
      await waitFor(() => expect(currentTheme()).toEqual({ pref: 'system', resolved: 'cream' }));
      // 关掉跟随系统：停在当前看到的那套
      fireEvent.click(r.getByTestId('theme-follow-system'));
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith({ pref: 'cream' }, expect.anything()),
      );
      applyTheme('mist');
      expect(currentTheme().resolved).toBe('mist');
    } finally {
      setThemeBackend(null);
      setLocaleBackend(null);
      close();
    }
  });
});

describe('主题排序', () => {
  const custom = (id: string) => ({
    id,
    format: 1,
    name: { zh: id },
    base: 'light' as const,
    seeds: {},
  });
  const ids = (pref: Parameters<typeof orderThemes>[0], customs = [custom('mine01')]) =>
    orderThemes(pref, customs).map((x) => x.id);

  it('我的主题在最前，不含跟随系统；当前主题在第一行时不动', () => {
    const base = ids('light');
    expect(base[0]).toBe('custom:mine01');
    expect(base).not.toContain('system');
    expect(ids(base[2]!)).toEqual(base);
  });

  it('当前主题不在第一行时挪到第一行最后一个', () => {
    const base = ids('light');
    const far = base[base.length - 1]!;
    const moved = ids(far);
    expect(moved[0]).toBe('custom:mine01');
    expect(moved[THEMES_FIRST_ROW - 1]).toBe(far);
    expect([...moved].sort()).toEqual([...base].sort());
  });
});
