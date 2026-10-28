// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyLocale } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StartupSettings } from '../src/components/SettingsView/StartupSettings';
import { setCharacterNameForTest } from '../src/services/characterName';
import { startupClient } from '../src/services/startupClient';

// D2 的过程经契约替身转发到下面的旧桥假实现（见 helpers/shellApi）
vi.mock('../src/services/api', () => import('./helpers/shellApi'));

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let stored: Record<string, unknown> | null = { defaultView: 'mascot', closeMain: 'hide' };
let failSet = false;

const install = () => {
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      if (ch === 'ai:startup:get') return stored;
      if (ch === 'ai:startup:set') {
        if (failSet) throw new Error('disk full');
        const patch = a[0] as Record<string, unknown>;
        const next: Record<string, unknown> = { ...(stored ?? {}), ...patch };
        // 与主进程 StartupService 一致：切回看板娘自动打开；默认看板娘时关掉她 → 默认改主界面
        if (patch.defaultView === 'mascot' && 'showMascot' in next) next.showMascot = true;
        if (next.showMascot === false && next.defaultView === 'mascot') next.defaultView = 'main';
        stored = next;
        return stored;
      }
      return null;
    },
    on: () => () => undefined,
  };
};

beforeEach(() => {
  calls = [];
  stored = { defaultView: 'mascot', closeMain: 'hide' };
  failSet = false;
  install();
});
afterEach(() => {
  cleanup();
  applyLocale('zh-CN');
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

describe('startupClient', () => {
  it('falls back to the mascot default for missing / invalid payloads', async () => {
    stored = { defaultView: 'console' };
    expect(await startupClient.get()).toBe('mascot');
    stored = null;
    expect(await startupClient.get()).toBe('mascot');
    delete (window as unknown as { aiIPC?: unknown }).aiIPC;
    expect(startupClient.available()).toBe(false);
    expect(await startupClient.get()).toBe('mascot');
    expect(await startupClient.set('main')).toBeNull();
  });
});

describe('Settings → General → startup default view', () => {
  it('shows the saved choice (default: mascot) with radio semantics', async () => {
    render(<StartupSettings />);
    const mascot = await screen.findByTestId('startup-view-mascot');
    const main = screen.getByTestId('startup-view-main');
    expect(screen.getByRole('radiogroup', { name: '启动 Nomi 后默认显示' })).toBeTruthy();
    expect(mascot.getAttribute('aria-checked')).toBe('true');
    expect(main.getAttribute('aria-checked')).toBe('false');
    // 没有人设时用通用称呼；指桌面角色的文案不写死官方角色名（§10.1）
    expect(mascot.textContent).toContain('看板娘');
    expect(mascot.textContent).not.toMatch(/Nomi|诺米/);
    expect(main.textContent).toContain('软件主界面');
  });

  it('picks the main window, persists via ai:startup:set, and can switch back', async () => {
    render(<StartupSettings />);
    fireEvent.click(await screen.findByTestId('startup-view-main'));
    await waitFor(() =>
      expect(screen.getByTestId('startup-view-main').getAttribute('aria-checked')).toBe('true'),
    );
    expect(calls).toContainEqual(['ai:startup:set', { defaultView: 'main' }]);
    expect(stored).toMatchObject({ defaultView: 'main' });
    fireEvent.click(screen.getByTestId('startup-view-mascot'));
    await waitFor(() => expect(stored).toMatchObject({ defaultView: 'mascot' }));
    expect(screen.getByTestId('startup-view-mascot').getAttribute('aria-checked')).toBe('true');
  });

  it('does not call set when clicking the already selected option', async () => {
    render(<StartupSettings />);
    fireEvent.click(await screen.findByTestId('startup-view-mascot'));
    await act(async () => undefined);
    expect(calls.some((c) => c[0] === 'ai:startup:set')).toBe(false);
  });

  it('rolls back the selection when saving fails', async () => {
    failSet = true;
    render(<StartupSettings />);
    fireEvent.click(await screen.findByTestId('startup-view-main'));
    await waitFor(() =>
      expect(screen.getByTestId('startup-view-mascot').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.getByTestId('startup-view-main').getAttribute('aria-checked')).toBe('false');
  });

  it('restores a saved main-window choice on mount and renders English copy', async () => {
    stored = { defaultView: 'main', closeMain: 'hide' };
    applyLocale('en');
    render(<StartupSettings />);
    const main = await screen.findByTestId('startup-view-main');
    expect(main.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: 'Show on startup' })).toBeTruthy();
    expect(main.textContent).toContain('Main window');
    expect(screen.getByTestId('startup-view-mascot').textContent).toContain('Mascot');
  });

  it('close main window: defaults to hide to tray, can switch to quit and persists', async () => {
    render(<StartupSettings />);
    const hide = await screen.findByTestId('close-main-hide');
    expect(screen.getByRole('radiogroup', { name: '关闭主界面时' })).toBeTruthy();
    expect(hide.getAttribute('aria-checked')).toBe('true');
    expect(hide.textContent).toContain('隐藏到托盘');
    fireEvent.click(screen.getByTestId('close-main-quit'));
    await waitFor(() =>
      expect(screen.getByTestId('close-main-quit').getAttribute('aria-checked')).toBe('true'),
    );
    expect(calls).toContainEqual(['ai:startup:set', { closeMain: 'quit' }]);
    expect(stored).toEqual({ defaultView: 'mascot', closeMain: 'quit' });
  });

  it('close main window: English labels and rollback on save failure', async () => {
    applyLocale('en');
    failSet = true;
    render(<StartupSettings />);
    const quit = await screen.findByTestId('close-main-quit');
    expect(quit.textContent).toContain('Quit Nomi');
    expect(screen.getByTestId('close-main-hide').textContent).toContain('Hide to tray');
    fireEvent.click(quit);
    await waitFor(() =>
      expect(screen.getByTestId('close-main-hide').getAttribute('aria-checked')).toBe('true'),
    );
  });

  it('desktop mascot switch: can close her while she is the default view; default switches to main (#55)', async () => {
    render(<StartupSettings />);
    const sw = await screen.findByTestId('startup-show-mascot');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(stored).toMatchObject({ showMascot: false, defaultView: 'main' }));
    expect(calls).toContainEqual(['ai:startup:set', { showMascot: false }]);
    await screen.findByTestId('startup-mascot-switched');
    expect(screen.getByTestId('startup-view-main').getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('desktop mascot switch: closes / reopens with the main window as default view', async () => {
    stored = { defaultView: 'main', closeMain: 'hide', showMascot: true };
    // 角色名来自当前角色的人设（persona.get）
    setCharacterNameForTest('小纸');
    render(<StartupSettings />);
    const sw = await screen.findByTestId('startup-show-mascot');
    expect(sw.getAttribute('aria-label')).toBe('显示小纸');
    expect(screen.getByTestId('settings-mascot-group').textContent).toContain('桌面小纸');
    setCharacterNameForTest('');
    fireEvent.click(sw);
    await waitFor(() => expect(stored).toMatchObject({ showMascot: false }));
    expect(calls).toContainEqual(['ai:startup:set', { showMascot: false }]);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // 默认界面本来就是主界面：不提示改默认
    expect(screen.queryByTestId('startup-mascot-switched')).toBeNull();
    // 切回看板娘为默认：开关自动打开
    fireEvent.click(screen.getByTestId('startup-view-mascot'));
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
  });

  it('renders nothing without the desktop bridge (browser preview)', () => {
    delete (window as unknown as { aiIPC?: unknown }).aiIPC;
    const { container } = render(<StartupSettings />);
    expect(container.innerHTML).toBe('');
  });

  it('uses the shared segmented control: checked option shares the selected-tab style', () => {
    const css = readFileSync(resolve(process.cwd(), '../ui/src/styles/base.css'), 'utf8');
    const rule =
      /\.cd-tab\[aria-selected='true'\],\s*\.cd-tab\[aria-checked='true'\]\s*\{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(rule).toBeTruthy();
    expect(rule).not.toMatch(/color:\s*var\(--cd-color-accent\)/);
  });

  it('groups: 启动与窗口 holds the language slot; 桌面 Nomi gets the size slot with the switch state', async () => {
    stored = { defaultView: 'main', closeMain: 'hide', showMascot: false };
    render(
      <StartupSettings
        language={<div data-testid="slot-language" />}
        mascotSize={(shown) => <div data-testid="slot-size" data-shown={String(shown)} />}
      />,
    );
    const basic = await screen.findByTestId('settings-basic-group');
    expect(basic.querySelector('[data-testid="slot-language"]')).toBeTruthy();
    expect(basic.querySelector('[data-testid="settings-close-main"]')).toBeTruthy();
    const mascot = screen.getByTestId('settings-mascot-group');
    expect(mascot.querySelector('[data-testid="slot-size"]')!.getAttribute('data-shown')).toBe(
      'false',
    );
  });
});
