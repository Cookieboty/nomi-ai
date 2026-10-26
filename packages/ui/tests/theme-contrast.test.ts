/**
 * 主题对比度回归（WCAG 2.x）：任何主题里「文字 / 填充」配对低于阈值都会让 CI 失败。
 * 命令行报告：`node packages/ui/scripts/theme-contrast.mjs [--only-fail]`。
 * 规则：正文 ≥ 4.5:1；图标 / 焦点环 / 选中描边 / 图表等非文字 UI ≥ 3:1。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluate,
  parseColor,
  ratio,
  readThemes,
  resolveVar,
  SYSTEM_ALIAS,
  THEME_IDS,
  // @ts-expect-error 纯 ESM 脚本（无类型声明），测试与 CLI 共用同一实现
} from '../scripts/theme-contrast-lib.mjs';
import { THEMES, resolveTheme } from '../src/theme';

interface Pair {
  group: string;
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = path.join(here, '../src/tokens.css');
const themes = readThemes(tokensCss) as Record<string, Record<string, string>>;
const ids = THEME_IDS as string[];

const results: Record<string, Pair[]> = Object.fromEntries(
  ids.map((id) => [id, evaluate(themes[id]) as Pair[]]),
);
const find = (id: string, label: string): Pair => {
  const p = results[id]!.find((r) => r.label === label);
  if (!p) throw new Error(`pair not found: ${label}`);
  return p;
};
const hex = (id: string, name: string) => resolveVar(themes[id]!, name);
const contrast = (a: string, b: string) => ratio(parseColor(a), parseColor(b)) as number;

describe('theme contrast (all themes, all pairs)', () => {
  it('covers every theme plus both system aliases', () => {
    expect(ids.sort()).toEqual(['cream', 'graphite', 'ink', 'mist', 'sunset']);
    expect(SYSTEM_ALIAS).toEqual({ 'system-dark': 'graphite', 'system-light': 'cream' });
  });

  for (const id of THEME_IDS as string[]) {
    describe(id, () => {
      it.each(results[id]!.map((r) => [r.label, r] as const))('%s', (_label, r) => {
        expect(
          r.ratio,
          `${r.label}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)}:1 (need ≥ ${r.min}:1)`,
        ).toBeGreaterThanOrEqual(r.min);
      });
    });
  }
});

describe('key pairs called out in the sunset feedback', () => {
  // 规范 §3.3 / §13：选中导航用 bg-selected 底 + 深一档强调色（accent-strong）的文字与图标
  it.each(['sunset', 'cream', 'mist'])(
    '%s: selected nav/tab text is the deep accent on bg-selected (≥ 4.5:1)',
    (id) => {
      expect(hex(id, '--cd-color-selected-text')).toBe(hex(id, '--cd-color-accent-strong'));
      for (const s of ['bg', 'surface', 'raised', 'sunken', 'subtle']) {
        const r = find(id, `selected-text on selected-bg over ${s} (segmented/tab/sidebar active)`);
        expect(r.ratio).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(['sunset', 'cream'])(
    '%s: light-orange #FDBA94 is never the text colour of selected / link',
    (id) => {
      expect(hex(id, '--cd-color-selected-text').toLowerCase()).not.toBe('#fdba94');
      expect(hex(id, '--cd-color-accent-strong').toLowerCase()).not.toBe('#fdba94');
      expect(hex(id, '--cd-color-accent-strong').toLowerCase()).not.toBe('#fb9466');
    },
  );

  it.each(['sunset', 'cream'])('%s: brand orange fill keeps dark (not white) label text', (id) => {
    expect(
      contrast(hex(id, '--cd-color-text-on-accent'), hex(id, '--cd-color-accent')),
    ).toBeGreaterThan(4.5);
  });

  it('white on #FB9466 really fails (why we never use it)', () => {
    expect(contrast('#ffffff', '#fb9466')).toBeLessThan(3);
  });

  it('selected row is distinguishable from its unselected neighbours in light themes', () => {
    for (const id of ['sunset', 'cream']) {
      expect(find(id, 'selected row vs unselected subtle (distinguishable)').pass).toBe(true);
      expect(find(id, 'selected row vs unselected surface (distinguishable)').pass).toBe(true);
    }
  });
});

describe('contrast helpers', () => {
  it('matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});

describe('theme.ts swatches stay in sync with tokens.css', () => {
  for (const t of THEMES.filter((x) => x.id !== 'system')) {
    it(`${t.id}: swatch bg / text / accent equal the tokens`, () => {
      const v = themes[resolveTheme(t.id, true)]!;
      expect(t.swatch[0].toLowerCase()).toBe(v['--cd-color-bg']!.toLowerCase());
      expect(t.swatch[2].toLowerCase()).toBe(v['--cd-color-text']!.toLowerCase());
      expect(t.swatch[3].toLowerCase()).toBe(v['--cd-color-accent']!.toLowerCase());
    });
  }
});

/**
 * 防回退：浅色主题里把 --cd-color-accent / accent-2 直接当文字色（橙 / 浅橙在奶油底上仅 1.5–2:1）。
 * 文字、链接、图标一律用 --cd-color-accent-strong；选中态用 selected-bg + selected-text。
 */
describe('no raw accent as text colour in component CSS', () => {
  const root = path.join(here, '../..');
  const files = execFileSync(
    'git',
    ['ls-files', '--', 'packages/*/src/**/*.css', 'packages/*/src/*.css'],
    {
      cwd: path.join(root, '..'),
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((f) => f && !f.endsWith('tokens.css'));

  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no `color: var(--cd-color-accent[-2])` declarations', () => {
    const bad: string[] = [];
    const re = /^\s*color:\s*var\(--cd-color-accent(?:-2)?(?![\w-])/;
    for (const f of files) {
      fs.readFileSync(path.join(root, '..', f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad, `use --cd-color-accent-strong instead:\n${bad.join('\n')}`).toEqual([]);
  });
});
