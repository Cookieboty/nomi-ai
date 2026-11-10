/**
 * 自定义主题：种子色推导、对比度修正、主题包校验、令牌白名单。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluate,
  readThemes,
  // @ts-expect-error 纯 ESM 脚本（无类型声明），与 theme-contrast.test.ts 共用
} from '../scripts/theme-contrast-lib.mjs';
import {
  contrastRatio,
  contrastReport,
  customThemeCss,
  customThemeName,
  customThemeTokens,
  deriveThemeTokens,
  isAdaptiveTheme,
  parseCustomTheme,
  parsePalette,
  resolveCustomBase,
  themeVariant,
  suggestBase,
  type CustomThemeDef,
} from '../src/customTheme';
import {
  THEMES,
  applyTheme,
  currentTheme,
  isThemeId,
  normalizeThemePref,
  previewCustomTheme,
  setThemeBackend,
} from '../src/theme';
import { THEMEABLE_TOKENS } from '../src/themeTokens';

interface Pair {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const themes = readThemes(path.join(here, '../src/tokens.css')) as Record<
  string,
  Record<string, string>
>;

const def = (over: Partial<CustomThemeDef> = {}): CustomThemeDef => ({
  id: 'abc123',
  format: 1,
  name: { zh: '深海', en: 'Deep Sea' },
  base: 'dark',
  seeds: { accent: '#4fa3d9', background: '#0f1a22', surface: '#172632', text: '#e6f0f5' },
  ...over,
});

/** 基底令牌 + 推导出的令牌，交给 tokens.css 的同一套对比度检查 */
const failures = (d: CustomThemeDef) =>
  (evaluate({ ...themes[d.base], ...customThemeTokens(d) }) as Pair[])
    .filter((p) => !p.pass)
    .map((p) => `${p.label}: ${p.fg} on ${p.bg} = ${p.ratio.toFixed(2)} < ${p.min}`);

describe('THEMEABLE_TOKENS', () => {
  it.each(Object.keys(themes).filter(isThemeId))('every token is defined by %s', (id) => {
    const missing = THEMEABLE_TOKENS.filter((k) => !(k in themes[id]!));
    expect(missing).toEqual([]);
  });

  it('only names color / bubble tokens', () => {
    for (const k of THEMEABLE_TOKENS) expect(k).toMatch(/^--cd-(color|bubble)-[a-z0-9-]+$/);
  });
});

describe('deriveThemeTokens', () => {
  // 用每个内置主题的色卡当种子：推导出的主题要过 tokens.css 的全部对比度检查
  const builtins = THEMES.filter((t) => isThemeId(t.id));
  it.each(builtins.map((t) => [t.id, t] as const))('seeds from %s pass all pairs', (_id, t) => {
    const [background, surface, text, accent] = t.swatch;
    const d = def({ base: suggestBase(background), seeds: { accent, background, surface, text } });
    expect(failures(d)).toEqual([]);
  });

  it('passes all pairs for a custom dark palette', () => {
    expect(failures(def())).toEqual([]);
  });

  it('passes all pairs for a light palette with a pale accent', () => {
    const d = def({
      base: 'light',
      seeds: { accent: '#7fd6c2', background: '#f4f7f6', surface: '#ffffff', text: '#1d2b28' },
    });
    expect(failures(d)).toEqual([]);
  });

  it('keeps the original accent as brand and fixes accent for text on it', () => {
    const t = deriveThemeTokens({ base: 'dark', seeds: { accent: '#ffcc00' } });
    expect(t['--cd-color-brand']).toBe('#ffcc00');
    expect(
      contrastRatio(t['--cd-color-text-on-accent']!, t['--cd-color-accent']!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a pale brand on light grounds just enough for 3:1', () => {
    const t = deriveThemeTokens({ base: 'light', seeds: { accent: '#ffcc00' } });
    expect(t['--cd-color-brand']).not.toBe('#ffcc00');
    expect(contrastRatio(t['--cd-color-brand']!, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t['--cd-color-brand']!, '#ffffff')).toBeLessThan(3.5);
  });

  it('fills missing seeds from the base theme', () => {
    const t = deriveThemeTokens({ base: 'dark', seeds: { accent: '#7887f5' } });
    expect(t['--cd-color-bg']).toBe('#141414');
    expect(t['--cd-color-text']).toBe('#f2f2f2');
  });
});

describe('contrastReport', () => {
  it('flags unreadable body text but auto-fixes accent pairs', () => {
    const r = contrastReport(
      def({ seeds: { accent: '#4fa3d9', background: '#0f1a22', text: '#2a3a44' } }),
    );
    expect(r.find((x) => x.id === 'text-bg')?.ok).toBe(false);
    expect(r.find((x) => x.id === 'on-accent')?.ok).toBe(true);
    expect(r.find((x) => x.id === 'link-surface')?.ok).toBe(true);
  });
});

describe('parseCustomTheme / css', () => {
  it('drops unknown tokens and unsafe values', () => {
    const d = parseCustomTheme({
      ...def(),
      tokens: {
        '--cd-color-success': '#3fb47a',
        '--cd-color-danger': 'red; } body { display:none',
        '--cd-color-info': 'url(https://x)',
        '--cd-radius-md': '#fff',
        '--cd-color-warning': 'rgb(1, 2, 3)',
      },
    })!;
    expect(d.tokens).toEqual({
      '--cd-color-success': '#3fb47a',
      '--cd-color-warning': 'rgb(1, 2, 3)',
    });
    const css = customThemeCss(d);
    expect(css).not.toMatch(/url\(|display:none/);
    expect(css).toContain('--cd-color-success: #3fb47a;');
  });

  it('rejects bad ids / base', () => {
    expect(parseCustomTheme({ ...def(), id: '../x' })).toBeNull();
    expect(parseCustomTheme({ ...def(), base: 'sepia' })).toBeNull();
    expect(parseCustomTheme(null)).toBeNull();
  });

  it('picks the display name by language', () => {
    expect(customThemeName(def(), 'zh-CN')).toBe('深海');
    expect(customThemeName(def(), 'en')).toBe('Deep Sea');
    expect(customThemeName(def({ name: { zh: '只有中文' } }), 'en')).toBe('只有中文');
  });
});

describe('variants (light + dark in one theme)', () => {
  const pair = def({
    base: 'light',
    seeds: { accent: '#336699', background: '#f6f7f9' },
    variants: { dark: { seeds: { accent: '#7aa7e0', background: '#101418' } } },
  });

  it('follows the system when the other base is present', () => {
    expect(isAdaptiveTheme(pair)).toBe(true);
    expect(resolveCustomBase(pair, true)).toBe('dark');
    expect(resolveCustomBase(pair, false)).toBe('light');
    expect(isAdaptiveTheme(def())).toBe(false);
    expect(resolveCustomBase(def(), false)).toBe('dark');
  });

  it('derives each variant from its own seeds', () => {
    expect(customThemeTokens(pair, 'dark')['--cd-color-bg']).toBe('#101418');
    expect(customThemeTokens(pair, 'light')['--cd-color-bg']).toBe('#f6f7f9');
    // 没有那套就用主套
    expect(themeVariant(def(), 'light').base).toBe('dark');
    expect(failures({ ...pair, base: 'dark', seeds: pair.variants!.dark!.seeds })).toEqual([]);
  });

  it('parse keeps only the opposite variant and a valid background', () => {
    const parsed = parseCustomTheme({
      ...pair,
      variants: { light: { seeds: {} }, dark: { seeds: { text: '#eeeeee', bad: 1 } } },
      background: { image: 'chat-asset://themes/abc-12ab.png', blur: 99, opacity: 0 },
    })!;
    expect(parsed.variants).toEqual({ dark: { seeds: { text: '#eeeeee' } } });
    expect(parsed.background).toEqual({
      image: 'chat-asset://themes/abc-12ab.png',
      blur: 40,
      opacity: 0.05,
    });
    for (const image of [
      'https://x/y.png',
      'chat-asset://images/a.png',
      'chat-asset://themes/../a.png',
    ])
      expect(parseCustomTheme({ ...pair, background: { image } })!.background).toBeUndefined();
  });

  it('theme.ts paints the variant matching the system', () => {
    localStorage.setItem('cd.theme.custom', JSON.stringify({ ...pair, id: 'pair01' }));
    applyTheme('custom:pair01');
    const want = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    expect(currentTheme().resolved).toBe(want);
    expect(document.getElementById('cd-custom-theme')?.textContent).toContain(
      want === 'dark' ? '#101418' : '#f6f7f9',
    );
    previewCustomTheme({ ...pair, id: 'pair01' }, 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.getElementById('cd-custom-theme')?.textContent).toContain('#101418');
    previewCustomTheme(null);
    localStorage.clear();
    applyTheme('light');
  });
});

describe('parsePalette', () => {
  it('extracts hex colors in order', () => {
    expect(parsePalette('accent #4FA3D9, bg #0f1a22\n#fff  #12345 #abc')).toEqual([
      '#4fa3d9',
      '#0f1a22',
      '#ffffff',
      '#aabbcc',
    ]);
  });
});

describe('theme.ts with custom themes', () => {
  afterEach(() => {
    previewCustomTheme(null);
    setThemeBackend(null);
    localStorage.clear();
    applyTheme('light');
  });

  it('accepts custom prefs', () => {
    expect(normalizeThemePref('custom:abc123')).toBe('custom:abc123');
    expect(normalizeThemePref('custom:../x')).toBeNull();
  });

  it('falls back to the default without a cached definition (no backend)', () => {
    applyTheme('custom:nope');
    expect(currentTheme().pref).toBe('light');
  });

  it('applies the cached definition and injects the style', () => {
    localStorage.setItem('cd.theme.custom', JSON.stringify(def()));
    applyTheme('custom:abc123');
    const el = document.documentElement;
    expect(currentTheme().resolved).toBe('dark');
    expect(el.getAttribute('data-theme')).toBe('dark');
    expect(el.getAttribute('data-theme-custom')).toBe('abc123');
    expect(document.getElementById('cd-custom-theme')?.textContent).toContain('#0f1a22');
    applyTheme('light');
    expect(el.hasAttribute('data-theme-custom')).toBe(false);
    expect(document.getElementById('cd-custom-theme')).toBeNull();
  });

  it('previews without changing the saved choice', () => {
    applyTheme('light');
    previewCustomTheme(def());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(currentTheme().pref).toBe('light');
    previewCustomTheme(null);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
