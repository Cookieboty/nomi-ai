/**
 * 自定义主题编辑器的草稿：明暗自动判断、双套开关、覆盖令牌、转成主题定义与保存前检查。
 */
import type { CustomThemeDef } from '@nomi-ai/ui';
import { describe, expect, it } from 'vitest';

import {
  baseMismatch,
  draftProblems,
  draftToTheme,
  initDraft,
  setBackground,
  setDual,
  setEditing,
  setPalette,
  setSeed,
  setToken,
} from '../src/components/SettingsView/customThemeDraft';

const light = { accent: '#c45425', background: '#f7f7f7', surface: '#ffffff', text: '#141414' };

describe('customThemeDraft', () => {
  it('single variant follows the background lightness', () => {
    let d = initDraft(null, light);
    expect(d.primary).toBe('light');
    d = setSeed(d, 'background', '#0f1a22');
    expect([d.primary, d.editing, Object.keys(d.variants)]).toEqual(['dark', 'dark', ['dark']]);
    // 半截值不触发切换
    d = setSeed(d, 'background', '#fff');
    expect(d.primary).toBe('light');
    d = setSeed(d, 'background', '#ff');
    expect(d.primary).toBe('light');
  });

  it('pastes a palette in seed order', () => {
    const d = setPalette(initDraft(null, light), ['#4fa3d9', '#0f1a22', '#172632', '#e6f0f5']);
    expect(d.variants.dark?.seeds).toEqual({
      accent: '#4fa3d9',
      background: '#0f1a22',
      surface: '#172632',
      text: '#e6f0f5',
    });
  });

  it('dual mode adds the other variant with the same accent; turning off keeps the edited one', () => {
    let d = setDual(initDraft(null, { ...light, accent: '#336699' }), true);
    expect(d.variants.dark?.seeds.accent).toBe('#336699');
    expect(d.variants.dark?.seeds.background).toBe('#141414');
    d = setEditing(d, 'dark');
    d = setSeed(d, 'background', '#f0f0f0'); // 双套时明暗固定，不跟背景跳
    expect(d.editing).toBe('dark');
    expect(baseMismatch(d)).toBe(true);
    const def = draftToTheme(d, 'x', { zh: 'X' });
    expect(def.base).toBe('light');
    expect(def.variants?.dark?.seeds.background).toBe('#f0f0f0');
    d = setDual(d, false);
    expect([d.primary, Object.keys(d.variants)]).toEqual(['dark', ['dark']]);
    expect(draftToTheme(d, 'x', {}).variants).toBeUndefined();
  });

  it('token overrides: empty removes, invalid is reported and left out', () => {
    let d = initDraft(null, light);
    d = setToken(d, '--cd-color-success', '#3fb47a');
    d = setToken(d, '--cd-color-danger', 'url(x)');
    expect(draftProblems(d)).toEqual([{ base: 'light', kind: 'token', key: '--cd-color-danger' }]);
    expect(draftToTheme(d, 'x', {}).tokens).toEqual({ '--cd-color-success': '#3fb47a' });
    d = setToken(d, '--cd-color-danger', '');
    d = setToken(d, '--cd-color-success', ' ');
    expect(draftProblems(d)).toEqual([]);
    expect(draftToTheme(d, 'x', {}).tokens).toBeUndefined();
  });

  it('reports invalid seeds in the other variant too', () => {
    let d = setDual(initDraft(null, light), true);
    d = setEditing(d, 'dark');
    d = setSeed(d, 'text', '#12');
    d = setEditing(d, 'light');
    expect(draftProblems(d)).toEqual([{ base: 'dark', kind: 'seed', key: 'text' }]);
  });

  it('round-trips an existing theme with variants and background', () => {
    const initial: CustomThemeDef = {
      id: 'pair01',
      format: 2,
      name: { zh: '双' },
      base: 'dark',
      seeds: { accent: '#7aa7e0', background: '#101418' },
      tokens: { '--cd-color-info': '#88aacc' },
      variants: { light: { seeds: { background: '#f6f7f9' } } },
      background: { image: 'chat-asset://themes/pair01-ab12.png', blur: 4, opacity: 0.5 },
    };
    const d = initDraft(initial, light);
    expect(d.dual).toBe(true);
    expect(d.variants.dark?.tokens).toEqual({ '--cd-color-info': '#88aacc' });
    const out = draftToTheme(d, 'pair01', initial.name);
    expect(out.variants?.light?.seeds.background).toBe('#f6f7f9');
    expect(out.background).toEqual(initial.background);
    expect(draftToTheme(setBackground(d, null), 'pair01', {}).background).toBeUndefined();
  });
});
