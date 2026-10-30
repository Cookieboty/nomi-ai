/**
 * 主题对比度审计（WCAG 2.x）：解析 tokens.css，按级联顺序（:root → [data-theme]）解出每个主题的令牌，
 * 把半透明层逐层合成到背景上，再对「文字 / 填充」配对计算对比度。
 * 供 `tests/theme-contrast.test.ts`（CI 回归）与 `scripts/theme-contrast.mjs`（命令行报告）共用。
 */
import fs from 'node:fs';

export const THEME_IDS = ['mist', 'graphite', 'ink', 'cream', 'sunset'];
/** 「跟随系统」解析为 graphite（深）/ cream（浅），无独立令牌 */
export const SYSTEM_ALIAS = { 'system-dark': 'graphite', 'system-light': 'cream' };

export const TEXT = 4.5; // WCAG AA 正文
export const UI = 3; // WCAG AA 大字 / 非文字 UI

/* ---------------------------------------------------------------- parse */

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 返回 { sunset: {...}, graphite: {...:root + overrides}, ... }（与浏览器级联一致） */
export function parseThemes(cssText) {
  const css = stripComments(cssText);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const vars = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
    blocks.push({ selector: m[1].trim(), vars });
  }
  const sels = (b) => b.selector.split(',').map((x) => x.trim());
  // :root = 非颜色令牌 + 默认主题（sunset）的颜色；按出现顺序合并，与浏览器级联一致
  const root = Object.assign(
    {},
    ...blocks.filter((b) => sels(b).includes(':root')).map((b) => b.vars),
  );
  const out = {};
  for (const id of THEME_IDS) {
    const b = blocks.find((x) => sels(x).includes(`[data-theme='${id}']`));
    if (!b) throw new Error(`theme block missing: ${id}`);
    out[id] = { ...root, ...b.vars };
  }
  return out;
}

export const readThemes = (file) => parseThemes(fs.readFileSync(file, 'utf8'));

/** 展开 var(--x[, fallback]) */
export function resolveVar(vars, name, aliases = {}, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle at ${name}`);
  let raw = vars[name] ?? (aliases[name] ? `var(${aliases[name]})` : undefined);
  if (raw === undefined) throw new Error(`token not defined: ${name}`);
  const sub = (s) =>
    s.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, n, fb) => {
      if (vars[n] !== undefined || aliases[n]) return resolveVar(vars, n, aliases, depth + 1);
      if (fb !== undefined) return fb.trim();
      throw new Error(`token not defined: ${n}`);
    });
  return sub(raw);
}

/* ---------------------------------------------------------------- color */

/** → [r,g,b,a] (0-255, a 0-1) */
export function parseColor(s) {
  s = s.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return [Number(p[0]), Number(p[1]), Number(p[2]), p[3] === undefined ? 1 : Number(p[3])];
  }
  throw new Error(`unsupported color: ${s}`);
}

/** 把 top（可半透明）合成到不透明 base 上 */
export const over = (top, base) => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + base[i] * (1 - a)).concat(1);
};

export const luminance = ([r, g, b]) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export const ratio = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export const toHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/* ---------------------------------------------------------------- pairs */

/**
 * 背景叠层：令牌名数组，自底向上合成（第一个必须不透明或会被叠在 `bg` 上）。
 * 例如 ['surface','hover'] = 表面上再叠 hover 层。
 */
const STACKS = {
  bg: ['bg'],
  surface: ['bg', 'surface'],
  raised: ['bg', 'surface', 'surface-raised'],
  sunken: ['bg', 'surface-sunken'],
  subtle: ['bg', 'bg-subtle'],
  userMsg: ['bg', 'user-msg'],
};

/** 旧版（修复前）没有的新令牌 → 退回当时 CSS 实际使用的令牌，用于出「修复前」对照 */
export const LEGACY_ALIASES = {
  '--cd-color-accent-strong': '--cd-color-accent-2',
  '--cd-color-selected-text': '--cd-color-accent-2',
  '--cd-color-selected-bg': '--cd-color-accent-soft',
  '--cd-chart-1': '--cd-color-accent',
  '--cd-chart-2': '--cd-color-accent-3',
  '--cd-chart-3': '--cd-color-accent-2',
};

const tok = (n) => `--cd-color-${n}`;

/**
 * @returns {{id:string, label:string, fg:string, bg:string, min:number, fgRatio?:number}[]}
 * 每条描述为 { fg: 令牌/字面色, bgStack: [...] , min }，在 evaluate() 中算出比值。
 */
export function pairDefs() {
  const defs = [];
  const add = (group, label, fg, stack, min, extra = {}) =>
    defs.push({ group, label, fg, stack, min, ...extra });

  const surfaces = ['bg', 'surface', 'raised', 'sunken', 'subtle', 'userMsg'];

  // 正文 / 次要 / 弱化文字
  for (const s of surfaces) add('text', `text on ${s}`, 'text', STACKS[s], TEXT);
  for (const s of surfaces) add('text', `text-muted on ${s}`, 'text-muted', STACKS[s], TEXT);
  for (const s of ['bg', 'surface', 'raised', 'subtle'])
    add('text', `text-subtle on ${s}`, 'text-subtle', STACKS[s], TEXT);
  add('text', 'text-subtle on sunken (placeholder)', 'text-subtle', STACKS.sunken, TEXT);

  // 品牌色文字 / 链接 / 图标（accent-strong）
  for (const s of surfaces)
    add('link', `accent-strong (link/icon/tag text) on ${s}`, 'accent-strong', STACKS[s], TEXT);
  for (const s of ['bg', 'surface', 'raised', 'sunken'])
    add(
      'badge',
      `accent-strong on accent-soft over ${s} (badge/tag/code)`,
      'accent-strong',
      [...STACKS[s], 'accent-soft'],
      TEXT,
    );

  // 用户气泡 / 发送按钮：accent 实底，上面是 text-on-accent
  add(
    'button',
    'text-on-accent on accent (user message bubble / send button)',
    'text-on-accent',
    ['accent'],
    TEXT,
  );

  // 次要 / 弱化文字落在品牌淡色底上（菜单项 hover、斜杠面板选中项、徽标旁说明）
  for (const s of ['surface', 'subtle'])
    for (const c of ['text-muted', 'text-subtle'])
      add('hover', `${c} on accent-soft over ${s}`, c, [...STACKS[s], 'accent-soft'], TEXT);
  for (const c of ['text-muted', 'text-subtle'])
    add(
      'selected',
      `${c} on selected-bg over surface`,
      c,
      [...STACKS.surface, 'selected-bg'],
      TEXT,
    );

  // 主按钮
  add('button', 'text-on-accent on accent (primary button)', 'text-on-accent', ['accent'], TEXT);
  add(
    'button',
    'text-on-accent on accent-hover (primary hover)',
    'text-on-accent',
    ['accent-hover'],
    TEXT,
  );

  // hover / active（普通按钮、列表行、菜单项、工具栏）
  for (const s of ['bg', 'surface', 'raised', 'subtle']) {
    add('hover', `text on hover over ${s}`, 'text', [...STACKS[s], 'hover'], TEXT);
    add('hover', `text-muted on hover over ${s}`, 'text-muted', [...STACKS[s], 'hover'], TEXT);
    add('hover', `text on active over ${s}`, 'text', [...STACKS[s], 'active'], TEXT);
    add(
      'hover',
      `accent-strong on hover over ${s} (ghost/outline button hover)`,
      'accent-strong',
      [...STACKS[s], 'hover'],
      TEXT,
    );
    add(
      'hover',
      `accent-strong on accent-soft over ${s} (ghost hover)`,
      'accent-strong',
      [...STACKS[s], 'accent-soft'],
      TEXT,
    );
  }
  add('hover', 'accent-strong on raised (.cd-btn:hover)', 'accent-strong', STACKS.raised, TEXT);

  // 选中态：分段控件 / Tab / 侧栏当前行 / 设置导航
  for (const s of ['bg', 'surface', 'raised', 'sunken', 'subtle']) {
    add(
      'selected',
      `selected-text on selected-bg over ${s} (segmented/tab/sidebar active)`,
      'selected-text',
      [...STACKS[s], 'selected-bg'],
      TEXT,
    );
    add(
      'selected',
      `text on selected-bg over ${s} (sidebar/nav active row)`,
      'text',
      [...STACKS[s], 'selected-bg'],
      TEXT,
    );
    add(
      'selected',
      `accent-strong icon on selected-bg over ${s}`,
      'accent-strong',
      [...STACKS[s], 'selected-bg'],
      UI,
    );
  }
  // 选中行与未选中邻居需可分辨（非文字对比，≥1.12 亮度比 + 另有左侧强调条）
  for (const s of ['subtle', 'surface'])
    add(
      'selected',
      `selected row vs unselected ${s} (distinguishable)`,
      '__fillvs',
      STACKS[s],
      1.12,
      {
        fillStack: [...STACKS[s], 'selected-bg'],
      },
    );

  // 状态色文字
  for (const c of ['danger-text', 'success', 'warning'])
    for (const s of ['bg', 'surface', 'raised', 'subtle'])
      add('status', `${c} on ${s}`, c, STACKS[s], TEXT);
  for (const c of ['danger-text', 'success', 'warning']) {
    const soft = c === 'danger-text' ? 'danger-soft' : `${c}-soft`;
    for (const s of ['surface', 'subtle'])
      add('status', `${c} on ${soft} over ${s}`, c, [...STACKS[s], soft], TEXT);
  }

  // 桌面角色气泡
  add('bubble', 'bubble-text on bubble-bg', '--cd-bubble-text', ['--cd-bubble-bg-base'], TEXT, {
    bubble: true,
  });
  add('bubble', 'bubble-link on bubble-bg', '--cd-bubble-link', ['--cd-bubble-bg-base'], TEXT, {
    bubble: true,
  });

  // 焦点环 / 选中描边（非文字 UI，≥3:1，相对其所在表面）
  for (const s of ['bg', 'surface', 'raised'])
    add('ui', `focus ring over ${s}`, '__ring', STACKS[s], UI);
  for (const s of ['bg', 'surface', 'raised'])
    add('ui', `accent-strong outline/selected border over ${s}`, 'accent-strong', STACKS[s], UI);
  add(
    'ui',
    'border-strong over surface (visible control edge)',
    '__borderStrong',
    STACKS.surface,
    1.5,
  );

  // 图表（柱 / 折线 / 图例，非文字 ≥3:1）
  for (const n of [1, 2, 3])
    add('chart', `chart-${n} over surface`, `--cd-chart-${n}`, STACKS.surface, UI);

  // 页面标题 / 大字 on bg（取 text）
  return defs;
}

const cssName = (n) => (n.startsWith('--') ? n : tok(n));

/** 在某个主题的令牌上求值全部配对 */
export function evaluate(vars, { aliases = {} } = {}) {
  const get = (n) => parseColor(resolveVar(vars, cssName(n), aliases));
  const stack = (names, bubble) => {
    if (bubble) {
      // 气泡背景是 rgba，落在主背景上
      return over(get('--cd-bubble-bg'), get('bg'));
    }
    let acc = null;
    for (const n of names) {
      // 'accent@0.88' = 品牌色按给定不透明度叠加（用户气泡 / 发送按钮等）
      const m = /^accent@([\d.]+)$/.exec(n);
      const c = m ? [...get('accent').slice(0, 3), Number(m[1])] : get(n);
      acc = acc ? over(c, acc) : over(c, [128, 128, 128, 1]);
    }
    return acc;
  };
  return pairDefs().map((d) => {
    const bg = stack(d.stack, d.bubble);
    let fg;
    if (d.fg === '__ring') {
      // focus ring：box-shadow 2px 描边色 → 合成到表面
      const ring = resolveVar(vars, '--cd-focus-ring', aliases).match(/(rgba?\([^)]+\))/);
      fg = over(parseColor(ring[1]), bg);
    } else if (d.fg === '__borderStrong') {
      fg = over(get('border-strong'), bg);
    } else if (d.fg === '__fillvs') {
      fg = stack(d.fillStack);
    } else if (d.bubble) {
      fg = over(get(d.fg), bg);
    } else {
      fg = over(get(d.fg), bg);
    }
    const r = ratio(fg, bg);
    return {
      group: d.group,
      label: d.label,
      fg: toHex(fg),
      bg: toHex(bg),
      ratio: r,
      min: d.min,
      pass: r + 1e-9 >= d.min,
    };
  });
}

export function evaluateAll(themes, opts) {
  const res = {};
  for (const id of THEME_IDS) res[id] = evaluate(themes[id], opts);
  return res;
}
