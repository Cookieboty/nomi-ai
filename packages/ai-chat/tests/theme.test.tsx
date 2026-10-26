// @vitest-environment happy-dom
import {
  DEFAULT_THEME,
  THEMES,
  applyTheme,
  currentTheme,
  initTheme,
  normalizeThemePref,
  resolveTheme,
} from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeSettings } from '../src/components/SettingsView/ThemeSettings';

afterEach(() => {
  cleanup();
  applyTheme(DEFAULT_THEME);
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('themes', () => {
  it('new users default to Sunset Orange; saved choice respected', () => {
    expect(DEFAULT_THEME).toBe('sunset');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('sunset');
    localStorage.setItem('cd.theme', 'mist');
    initTheme();
    // 每个主题都写 data-theme（:root 只是日落橙的默认值）
    expect(document.documentElement.getAttribute('data-theme')).toBe('mist');
    expect(THEMES.map((t) => t.id).sort()).toEqual([
      'cream',
      'graphite',
      'image',
      'ink',
      'mist',
      'sunset',
      'system',
    ]);
  });
  it('maps legacy paper id to cream', () => {
    expect(normalizeThemePref('paper')).toBe('cream');
    localStorage.setItem('cd.theme', 'paper');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('cream');
  });
  it('follow system resolves dark → graphite, light → cream', () => {
    expect(resolveTheme('system', true)).toBe('graphite');
    expect(resolveTheme('system', false)).toBe('cream');
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
  it('only image theme reveals image controls and hides them on other themes', () => {
    applyTheme(DEFAULT_THEME);
    const view = render(<ThemeSettings />);
    expect(view.getAllByRole('radio')).toHaveLength(7);
    expect(
      (view.getByTestId('theme-system').firstElementChild as HTMLElement).style.backgroundImage,
    ).toContain('linear-gradient');
    expect(view.queryByTestId('image-theme-settings')).toBeNull();
    fireEvent.click(view.getByTestId('theme-image'));
    expect(view.getByTestId('image-theme-settings')).toBeTruthy();
    expect(view.getAllByRole('slider')).toHaveLength(2);
    expect(view.queryByTestId('settings-chat-bg')).toBeNull();
    fireEvent.click(view.getByTestId('theme-graphite'));
    expect(view.queryByTestId('image-theme-settings')).toBeNull();
    expect(view.queryAllByRole('slider')).toHaveLength(0);
    act(() => applyTheme('image'));
    expect(view.getByTestId('chat-bg-pick')).toBeTruthy();
  });
  it('picker applies theme and persists via IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({ pref: 'cream', resolved: 'cream' });
    (window as { aiIPC?: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ThemeSettings />);
    fireEvent.click(r.getByTestId('theme-cream'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('cream');
    expect(invoke).toHaveBeenCalledWith('ai:theme:set', 'cream');
    expect(r.getByTestId('theme-cream').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(r.getByTestId('theme-system'));
    expect(invoke).toHaveBeenCalledWith('ai:theme:set', 'system');
    applyTheme('mist');
    expect(currentTheme().resolved).toBe('mist');
  });
});
