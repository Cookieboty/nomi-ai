jest.unmock('fs');
jest.unmock('path');
import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';

import { THEME_CHROME, applyTitleBarTheme, titleBarOptions } from '../../../src/core/titleBar';

describe('integrated title bar', () => {
  it('macOS uses hiddenInset traffic lights over the theme background', () => {
    const o = titleBarOptions('darwin', 'ink');
    expect(o.titleBarStyle).toBe('hiddenInset');
    expect(o.trafficLightPosition).toEqual({ x: 14, y: 12 });
    expect(o.backgroundColor).toBe(THEME_CHROME.ink.bg);
    expect(o.titleBarOverlay).toBeUndefined();
  });

  it.each(['win32', 'linux'] as const)('%s uses a themed native controls overlay', (p) => {
    for (const th of ['mist', 'graphite', 'ink', 'cream', 'sunset'] as const) {
      const o = titleBarOptions(p, th);
      expect(o.titleBarStyle).toBe('hidden');
      expect(o.titleBarOverlay).toEqual({
        color: THEME_CHROME[th].bg,
        symbolColor: THEME_CHROME[th].fg,
        height: 36,
      });
    }
  });

  it('theme change updates background + overlay (not on mac)', () => {
    const win = {
      isDestroyed: () => false,
      setBackgroundColor: jest.fn(),
      setTitleBarOverlay: jest.fn(),
    };
    applyTitleBarTheme(win as never, 'cream', 'win32');
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#fffcf6');
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      color: '#fffcf6',
      symbolColor: '#403126',
      height: 36,
    });
    win.setTitleBarOverlay.mockClear();
    applyTitleBarTheme(win as never, 'graphite', 'darwin');
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('chrome colours match the UI theme tokens', () => {
    const css = fs.readFileSync(repoPath('packages/ui/src/tokens.css'), 'utf8');
    const block = (sel: string) => {
      const i = css.indexOf(sel);
      return css.slice(i, css.indexOf('}', i));
    };
    const bgOf = (b: string) => /--cd-color-bg:\s*(#[0-9a-f]+)/i.exec(b)?.[1];
    for (const th of ['mist', 'graphite', 'ink', 'cream', 'sunset'] as const)
      expect(bgOf(block(`[data-theme='${th}']`))).toBe(THEME_CHROME[th].bg);
  });
});
