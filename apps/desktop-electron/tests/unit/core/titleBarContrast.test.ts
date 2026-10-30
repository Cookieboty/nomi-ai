jest.unmock('fs');
jest.unmock('path');
/**
 * 标题栏 / Window Controls Overlay 的 bg / fg 必须与 packages/ui/src/tokens.css 各主题一致，
 * 且 fg 在 bg 上对比度 ≥ 4.5:1（窗口控制按钮的符号色）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { THEME_CHROME, type ChromeTheme } from '../../../src/core/titleBar';

const tokens = fs.readFileSync(path.resolve(__dirname, '../../../../ui/src/tokens.css'), 'utf8');

/** 每个主题取 [data-theme='x'] 块（sunset 与 :root 写在同一块：`:root,\n[data-theme='sunset'] {`） */
const block = (theme: ChromeTheme): string => {
  const a = tokens.indexOf(`[data-theme='${theme}'] {`);
  return tokens.slice(a, tokens.indexOf('\n}\n', a));
};
const token = (theme: ChromeTheme, name: string): string => {
  const m = block(theme).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`${name} not found for ${theme}`);
  return m[1]!.toLowerCase();
};

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('THEME_CHROME vs tokens.css', () => {
  const themes = Object.keys(THEME_CHROME) as ChromeTheme[];

  it.each(themes)('%s: bg / fg match --cd-color-bg / --cd-color-text', (theme) => {
    expect(THEME_CHROME[theme].bg.toLowerCase()).toBe(token(theme, '--cd-color-bg'));
    expect(THEME_CHROME[theme].fg.toLowerCase()).toBe(token(theme, '--cd-color-text'));
  });

  it.each(themes)('%s: window-control symbol colour has ≥ 4.5:1 on the title bar', (theme) => {
    expect(ratio(THEME_CHROME[theme].fg, THEME_CHROME[theme].bg)).toBeGreaterThanOrEqual(4.5);
  });
});
