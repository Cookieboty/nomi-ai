// @vitest-environment happy-dom
/**
 * 设置 → 外观 → 我的主题：列表、选中、新建（粘贴一组颜色 → 保存 → 切换）、导入、删除。
 */
import {
  DEFAULT_THEME,
  applyTheme,
  currentTheme,
  initTheme,
  previewCustomTheme,
  setThemeBackend,
  type CustomThemeDef,
} from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatBackgroundLayer } from '../src/components/ChatBackground/ChatBackgroundLayer';
import { ThemeSettings } from '../src/components/SettingsView/ThemeSettings';
import { api } from '../src/services/api';
import { installShellBackends } from '../src/services/hostBackends/shell';

import { installFakeApi, resetFakeApi, untilIdle, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const deep: CustomThemeDef = {
  id: 'deep01',
  format: 1,
  name: { zh: '深海', en: 'Deep Sea' },
  base: 'dark',
  seeds: { accent: '#4fa3d9', background: '#0f1a22', surface: '#172632', text: '#e6f0f5' },
};

/** 假内核：内存里存自定义主题，theme.set 按 Go 的形状回主题状态 */
function fakeKernel(initial: CustomThemeDef[]): FakeApi {
  const themes = new Map(initial.map((x) => [x.id, x]));
  let pref = 'light';
  const state = () => {
    const c = pref.startsWith('custom:') ? themes.get(pref.slice(7)) : undefined;
    return c ? { pref, resolved: c.base, custom: c } : { pref, resolved: pref };
  };
  return installFakeApi({
    'theme.get': () => state(),
    'theme.set': ({ pref: p }: { pref: string }) => {
      pref = p;
      return state();
    },
    'theme.customList': () => [...themes.values()],
    'theme.customSave': (input: Omit<CustomThemeDef, 'id' | 'format'> & { id?: string }) => {
      const def = { ...input, id: input.id ?? 'new001', format: 1 } as CustomThemeDef;
      themes.set(def.id, def);
      return def;
    },
    'theme.customDelete': ({ id }: { id: string }) => {
      themes.delete(id);
      if (pref === `custom:${id}`) pref = 'light';
    },
    'theme.customImport': () => {
      const def = { ...deep, id: 'imp001', name: { zh: '导入的', en: 'Imported' } };
      themes.set(def.id, def);
      return def;
    },
    'theme.customExport': () => '/tmp/x.nomitheme.json',
    'theme.customPickBackground': () => 'chat-asset://themes/tmp-ab12cd34.png',
    'theme.customTemplate': () => '/tmp/template.json',
    'theme.customImportData': () => {
      const def = { ...deep, id: 'imp001', name: { zh: '导入的', en: 'Imported' } };
      themes.set(def.id, def);
      return def;
    },
  });
}

beforeEach(() => {
  installShellBackends(api as never);
});

afterEach(() => {
  cleanup();
  previewCustomTheme(null);
  setThemeBackend(null);
  resetFakeApi();
  localStorage.clear();
  applyTheme(DEFAULT_THEME);
  document.body.innerHTML = '';
});

describe('my themes', () => {
  it('lists custom themes and selects one through theme.set', async () => {
    const fake = fakeKernel([deep]);
    initTheme();
    render(<ThemeSettings />);
    // 我的主题排在最前，始终在第一行
    const card = await screen.findByTestId('theme-custom-deep01');
    expect(screen.getAllByRole('radio')[0]).toBe(card);
    expect(card.textContent).toContain('深海');
    fireEvent.click(card);
    await untilIdle();
    expect(fake.inputs('theme.set')).toContainEqual({ pref: 'custom:deep01' });
    await waitFor(() => expect(currentTheme().pref).toBe('custom:deep01'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.getElementById('cd-custom-theme')?.textContent).toContain('#0f1a22');
    // 选中自定义主题后，网格下方出现它的编辑 / 导出 / 删除
    expect(screen.getByTestId('custom-theme-actions').textContent).toContain('深海');
    expect(screen.getByTestId('theme-edit')).toBeTruthy();
    // 内置主题与我的主题在同一个网格里
    const grid = screen.getByRole('radiogroup');
    expect(grid.contains(card)).toBe(true);
  });

  it('creates a theme from a pasted palette, previews it, then saves and switches', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    expect(screen.queryByTestId(/^theme-custom-/)).toBeNull();
    fireEvent.click(screen.getByTestId('theme-new'));
    // 新建在右侧抽屉里，不内嵌在设置页
    expect(screen.getByTestId('custom-theme-editor').className).toContain('cd-modal--drawer');
    fireEvent.change(screen.getByTestId('custom-theme-palette'), {
      target: { value: '#4fa3d9 #0f1a22 #172632 #e6f0f5' },
    });
    expect((screen.getByTestId('custom-theme-seed-background') as HTMLInputElement).value).toBe(
      '#0f1a22',
    );
    // 编辑时实时预览（深背景 → 深色基底）
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.change(screen.getByTestId('custom-theme-name'), { target: { value: '深海' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-theme-save'));
      await untilIdle();
    });
    expect(fake.inputs('theme.customSave')[0]).toMatchObject({
      name: { zh: '深海' },
      base: 'dark',
      seeds: { accent: '#4fa3d9', background: '#0f1a22', surface: '#172632', text: '#e6f0f5' },
    });
    expect(fake.inputs('theme.set')).toContainEqual({ pref: 'custom:new001' });
    await waitFor(() => expect(screen.queryByTestId('custom-theme-editor')).toBeNull());
    expect(currentTheme().pref).toBe('custom:new001');
  });

  it('cancel reverts the live preview', async () => {
    fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-new'));
    fireEvent.change(screen.getByTestId('custom-theme-seed-background'), {
      target: { value: '#101010' },
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect(document.getElementById('cd-custom-theme')).toBeNull();
  });

  it('flags an invalid color and does not save', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-new'));
    fireEvent.change(screen.getByTestId('custom-theme-seed-text'), { target: { value: '#12' } });
    fireEvent.click(screen.getByTestId('custom-theme-save'));
    await untilIdle();
    expect(screen.getByTestId('custom-theme-error').textContent).toContain('#rrggbb');
    expect(fake.inputs('theme.customSave')).toEqual([]);
  });

  it('import dialog: choosing a file imports and switches; cancelling shows nothing', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-import'));
    expect(screen.getByTestId('theme-import-dialog').className).not.toContain('cd-modal--inline');
    await act(async () => {
      fireEvent.click(screen.getByTestId('theme-drop'));
      await untilIdle();
    });
    expect(fake.inputs('theme.set')).toContainEqual({ pref: 'custom:imp001' });
    expect(await screen.findByTestId('theme-custom-imp001')).toBeTruthy();
    expect(screen.getByTestId('theme-notice').textContent).toContain('导入的');
    expect(screen.queryByTestId('theme-import-dialog')).toBeNull();
  });

  it('import dialog: cancelling the file picker is not an error', async () => {
    // 内核在取消时回 null
    installFakeApi({
      'theme.get': () => ({ pref: 'light', resolved: 'light' }),
      'theme.customList': () => [],
      'theme.customImport': () => null,
    });
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-import'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('theme-drop'));
      await untilIdle();
    });
    expect(screen.queryByTestId('theme-import-status')).toBeNull();
    expect(screen.getByTestId('theme-import-dialog')).toBeTruthy();
  });

  it('import dialog: dropping a file sends its bytes; template can be downloaded', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-import'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('theme-template'));
      await untilIdle();
    });
    expect(screen.getByTestId('theme-import-status').textContent).toContain('/tmp/template.json');
    const file = new File(['{"name":"x","base":"light"}'], 'x.nomitheme.json');
    await act(async () => {
      fireEvent.drop(screen.getByTestId('theme-drop'), { dataTransfer: { files: [file] } });
      await untilIdle();
    });
    const sent = fake.inputs('theme.customImportData')[0] as { data: Uint8Array };
    expect(new TextDecoder().decode(sent.data)).toContain('"base":"light"');
    expect(fake.inputs('theme.set')).toContainEqual({ pref: 'custom:imp001' });
  });

  it('saves separate light and dark versions', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-new'));
    fireEvent.click(screen.getByTestId('custom-theme-dual'));
    fireEvent.click(screen.getByTestId('custom-theme-variant-dark'));
    // 编辑深色版时预览深色版
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.change(screen.getByTestId('custom-theme-seed-background'), {
      target: { value: '#101418' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-theme-save'));
      await untilIdle();
    });
    expect(fake.inputs('theme.customSave')[0]).toMatchObject({
      base: 'light',
      variants: { dark: { seeds: { background: '#101418' } } },
    });
  });

  it('adds a background image; the background layer follows the preview', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(
      <>
        <ChatBackgroundLayer />
        <ThemeSettings />
      </>,
    );
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-new'));
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-theme-bg-pick'));
      await untilIdle();
    });
    const layer = await screen.findByTestId('chat-bg-layer');
    expect(layer.getAttribute('style')).toContain('tmp-ab12cd34.png');
    expect(document.documentElement.dataset.chatBg).toBe('image');
    fireEvent.change(screen.getByTestId('custom-theme-token-success'), {
      target: { value: '#3fb47a' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('custom-theme-save'));
      await untilIdle();
    });
    expect(fake.inputs('theme.customSave')[0]).toMatchObject({
      tokens: { '--cd-color-success': '#3fb47a' },
      background: { image: 'chat-asset://themes/tmp-ab12cd34.png', blur: 0, opacity: 0.5 },
    });
  });

  it('blocks saving with an invalid override and names the token', async () => {
    const fake = fakeKernel([]);
    initTheme();
    render(<ThemeSettings />);
    await untilIdle();
    fireEvent.click(screen.getByTestId('theme-new'));
    fireEvent.change(screen.getByTestId('custom-theme-token-danger'), {
      target: { value: 'var(--x)' },
    });
    fireEvent.click(screen.getByTestId('custom-theme-save'));
    await untilIdle();
    expect(screen.getByTestId('custom-theme-error').textContent).toContain('--cd-color-danger');
    expect(fake.inputs('theme.customSave')).toEqual([]);
  });
});
