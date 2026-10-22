// @vitest-environment happy-dom
import { applyLocale, getLocale, resolveLocale, t } from '@nomi-ai/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { LanguageSettings } from '../src/components/SettingsView/LanguageSettings';

describe('i18n', () => {
  afterEach(() => applyLocale('zh-CN'));

  it('resolves the system locale and translates with interpolation', () => {
    expect(resolveLocale('system', ['zh-HK'])).toBe('zh-CN');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(getLocale()).toBe('zh-CN');
    expect(t('新对话')).toBe('新对话');
    applyLocale('en');
    expect(t('新对话')).toBe('New chat');
    expect(t('{0} 分钟前', 5)).toBe('5 min ago');
    expect(t('不在词典里的文字')).toBe('不在词典里的文字');
    expect(t(undefined)).toBeUndefined();
  });

  it('language picker switches live without reload', () => {
    render(<LanguageSettings />);
    expect(screen.getByTestId('language-settings').textContent).toContain('语言');
    expect(screen.getByRole('radiogroup', { name: '语言' })).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByTestId('locale-en'));
    });
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByTestId('locale-en').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('locale-system').textContent).toContain('Follow system');
  });
});
