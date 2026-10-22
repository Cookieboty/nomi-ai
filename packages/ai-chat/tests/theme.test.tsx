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
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeSettings } from '../src/components/SettingsView/ThemeSettings';

afterEach(() => {
  cleanup();
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
