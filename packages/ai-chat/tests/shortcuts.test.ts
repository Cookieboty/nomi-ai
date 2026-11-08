// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  RESERVED,
  comboFromEvent,
  findConflicts,
  formatCombo,
  getBindings,
  isValidCombo,
  matchShortcut,
  normalizeCombo,
  resetBindings,
  setBinding,
} from '../src/services/shortcuts';

const ev = (init: Partial<KeyboardEvent> & { key: string; code?: string }) =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    code: '',
    ...init,
  }) as KeyboardEvent;

describe('shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('normalizes modifier order and key case', () => {
    expect(normalizeCombo('shift+mod+k')).toBe('Mod+Shift+K');
    expect(normalizeCombo('Mod+,')).toBe('Mod+,');
  });

  it('builds combos from events using physical keys (Shift does not change the key)', () => {
    expect(
      comboFromEvent(ev({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod+Shift+K');
    expect(
      comboFromEvent(ev({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }), true),
    ).toBe('Mod+Shift+1');
    expect(
      comboFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false),
    ).toBeNull();
    // macOS: Ctrl is a separate modifier from ⌘
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe('Ctrl+K');
  });

  it('matches per platform', () => {
    expect(matchShortcut(ev({ key: 'k', code: 'KeyK', metaKey: true }), 'Mod+K', true)).toBe(true);
    expect(matchShortcut(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'Mod+K', false)).toBe(true);
    expect(matchShortcut(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'Mod+K', true)).toBe(false);
    expect(
      matchShortcut(ev({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), 'Mod+K', false),
    ).toBe(false);
  });

  it('formats for display', () => {
    expect(formatCombo('Mod+Shift+K', true)).toBe('⌘⇧K');
    expect(formatCombo('Mod+Shift+K', false)).toBe('Ctrl+Shift+K');
  });

  it('validates combos', () => {
    expect(isValidCombo('K')).toBe(false);
    expect(isValidCombo('Shift+K')).toBe(false);
    expect(isValidCombo('Alt+K')).toBe(true);
    expect(isValidCombo('F5')).toBe(true);
  });

  it('persists rebinding, resets to default, and detects conflicts', () => {
    expect(getBindings().palette).toBe('Mod+K');
    setBinding('palette', 'Mod+Shift+P');
    expect(getBindings().palette).toBe('Mod+Shift+P');
    expect(findConflicts(getBindings())).toEqual({});

    setBinding('focusInput', 'Mod+N'); // same as newChat
    const c = findConflicts(getBindings());
    expect(c.focusInput?.with).toEqual(['newChat']);
    expect(c.newChat?.with).toEqual(['focusInput']);

    setBinding('sidebar', 'Mod+C');
    expect(findConflicts(getBindings()).sidebar?.reserved).toBe(RESERVED['Mod+C']);

    setBinding('palette', null);
    expect(getBindings().palette).toBe('Mod+K');
    resetBindings();
    expect(getBindings().focusInput).toBe('Mod+L');
  });
});

describe('在终端打开当前项目', () => {
  it('macOS 是 ⇧⌘C，其他平台 Ctrl+Shift+C；不和系统 / 编辑快捷键冲突', () => {
    expect(getBindings().openTerminal).toBe('Mod+Shift+C');
    const mac = ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(matchShortcut(mac, 'Mod+Shift+C', true)).toBe(true);
    expect(formatCombo('Mod+Shift+C', true)).toBe('⌘⇧C');
    // 只按 ⌘C（复制）不触发
    expect(matchShortcut(ev({ key: 'c', code: 'KeyC', metaKey: true }), 'Mod+Shift+C', true)).toBe(
      false,
    );
    const win = ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(matchShortcut(win, 'Mod+Shift+C', false)).toBe(true);
    expect(formatCombo('Mod+Shift+C', false)).toBe('Ctrl+Shift+C');
    expect(findConflicts(getBindings()).openTerminal).toBeUndefined();
  });
});
