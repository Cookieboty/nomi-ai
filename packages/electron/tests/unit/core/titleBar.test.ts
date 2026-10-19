jest.unmock('fs');
jest.unmock('path');
import fs from 'node:fs';
import path from 'node:path';

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
    for (const th of ['mist', 'graphite', 'ink', 'cream'] as const) {
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
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#fcefe1');
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      color: '#fcefe1',
      symbolColor: '#33291f',
      height: 36,
    });
    win.setTitleBarOverlay.mockClear();
    applyTitleBarTheme(win as never, 'graphite', 'darwin');
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('chrome colours match the UI theme tokens', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../../../ui/src/tokens.css'), 'utf8');
    const block = (sel: string) => {
      const i = css.indexOf(sel);
      return css.slice(i, css.indexOf('}', i));
    };
    const bgOf = (b: string) => /--cd-color-bg:\s*(#[0-9a-f]+)/i.exec(b)?.[1];
    expect(bgOf(block(':root'))).toBe(THEME_CHROME.mist.bg);
    for (const th of ['graphite', 'ink', 'cream'] as const)
      expect(bgOf(block(`[data-theme='${th}']`))).toBe(THEME_CHROME[th].bg);
  });
});
