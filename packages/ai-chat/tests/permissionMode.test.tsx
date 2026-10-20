// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointControls, SessionControls } from '../src/components/EndpointControls';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { nativeCommands } from '../src/slash/adapters/common';
import {
  CYCLE_PERMISSION_EVENT,
  fallbackMode,
  nextMode,
  supportedModes,
} from '../src/utils/permissionModes';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
  }),
}));

// 权限模式（docs/design/cli-permission-modes.md §4）
const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 'cx',
  title: 'X',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  permissionMode: 'acceptEdits',
  ...over,
});

function mockIpc(cli: Partial<HarnessTabMeta> = {}) {
  let current = tab(cli);
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
    if (ch === 'ai:harness:tabs')
      return {
        tabs: [tab({ id: 'main', backend: 'nomi' }), current],
        activeTabId: 'cx',
        maxConcurrent: 3,
        running: 0,
        queued: 0,
        defaultPermissionMode: 'acceptEdits',
      } satisfies HarnessTabsState;
    if (ch === 'ai:harness:state') return { backend: 'nomi', cwd: '/w', bins: { claude: '/c' } };
    if (ch === 'ai:harness:tab-permission-mode') {
      const mode = a[1] as string;
      const degraded = current.backend === 'dsh' && mode === 'manual';
      current = { ...current, permissionMode: degraded ? 'plan' : (mode as never) };
      return { ...current, degraded };
    }
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:harness:tab-messages') return [];
    if (ch === 'ai:cli-provider:state') return { profiles: [] };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

const mount = () =>
  render(
    <HarnessTabsProvider>
      <>
        <EndpointControls />
        <SessionControls onManageNomi={() => undefined} onManageCli={() => undefined} />
      </>
    </HarnessTabsProvider>,
  );

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('权限模式表', () => {
  it('各端支持的档位与降级与主进程一致；Shift+Tab 跳过「完全放开」', () => {
    expect(supportedModes('dsh')).toEqual(['plan', 'acceptEdits', 'bypass']);
    expect(fallbackMode('dsh', 'manual')).toBe('plan');
    // Codex / Grok 走长驻会话后都能逐项确认；Grok 没有「自动」
    expect(fallbackMode('codex', 'manual')).toBe('manual');
    expect(fallbackMode('grok', 'auto')).toBe('acceptEdits');
    expect(fallbackMode('gemini', 'auto')).toBe('acceptEdits');
    expect(nextMode('claude', 'auto')).toBe('plan');
    expect(nextMode('dsh', 'acceptEdits')).toBe('plan');
    expect(nextMode('nomi', 'plan')).toBeNull();
  });
});

describe('输入栏的权限模式按钮', () => {
  it('显示当前档位；下拉里只列当前 CLI 支持的档位', async () => {
    const invoke = mockIpc({ backend: 'dsh' });
    const r = mount();
    const chip = await r.findByTestId('permission-mode-chip');
    expect(chip.getAttribute('aria-label')).toBe('权限模式：自动改文件');
    fireEvent.click(chip);
    // dsh 不支持「逐项确认」：不显示
    expect(r.queryByTestId('permission-mode-manual')).toBeNull();
    expect(r.getByTestId('permission-mode-plan')).toBeTruthy();
    fireEvent.click(r.getByTestId('permission-mode-plan'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'plan', {
        confirmed: false,
      }),
    );
  });

  it('窄输入栏：按钮可收缩（省略号），极窄时只留图标，模式名仍在无障碍名称里（#64 E28）', async () => {
    mockIpc({ backend: 'codex' });
    const r = mount();
    const chip = await r.findByTestId('permission-mode-chip');
    const label = Array.from(chip.querySelectorAll('span')).find(
      (s) => s.textContent === '自动改文件',
    );
    expect(label?.className).toBeTruthy();
    expect(chip.getAttribute('aria-label')).toContain('自动改文件');
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/PermissionModeChip/index.module.css'),
      'utf8',
    );
    const chipRule = /\.chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(chipRule).toMatch(/min-width:\s*0/);
    expect(chipRule).toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(
      /@container composer \(max-width: 440px\)\s*\{\s*\.label\s*\{\s*display:\s*none;/,
    );
  });

  it('下拉挂在 body 上（不在输入栏容器里），不会被输入栏的 overflow 裁掉', async () => {
    mockIpc();
    const r = mount();
    fireEvent.click(await r.findByTestId('permission-mode-chip'));
    const menu = r.getByTestId('permission-mode-menu');
    expect(menu.parentElement).toBe(document.body);
    expect(r.container.contains(menu)).toBe(false);
    // 点菜单里的项不会被当成「点外面」先关掉
    fireEvent.mouseDown(r.getByTestId('permission-mode-plan'));
    expect(r.queryByTestId('permission-mode-menu')).not.toBeNull();
  });

  it('「完全放开」先确认，确认后带 confirmed 发送；取消则不发送', async () => {
    const invoke = mockIpc();
    const r = mount();
    fireEvent.click(await r.findByTestId('permission-mode-chip'));
    fireEvent.click(r.getByTestId('permission-mode-bypass'));
    await r.findByTestId('permission-bypass-confirm');
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:harness:tab-permission-mode')).toBe(false);
    // 确认框写明作用于哪个标签 / 目录
    expect(r.getByTestId('permission-bypass-target').textContent).toContain('/w');
    fireEvent.click(r.getByTestId('permission-bypass-ok'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'bypass', {
        confirmed: true,
        expect: { backend: 'claude', cwd: '/w' },
      }),
    );
  });

  it('输入框 Shift+Tab 切到下一档（事件被按钮处理）', async () => {
    const invoke = mockIpc({ permissionMode: 'plan' });
    const r = mount();
    await r.findByTestId('permission-mode-chip');
    const detail = { handled: false };
    window.dispatchEvent(new CustomEvent(CYCLE_PERMISSION_EVENT, { detail }));
    expect(detail.handled).toBe(true);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'manual', {
        confirmed: false,
      }),
    );
  });

  it('可以把当前档设为新标签默认', async () => {
    const invoke = mockIpc({ permissionMode: 'plan' });
    const r = mount();
    fireEvent.click(await r.findByTestId('permission-mode-chip'));
    fireEvent.click(r.getByTestId('permission-mode-make-default'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:permission-defaults', {
        defaultPermissionMode: 'plan',
      }),
    );
  });

  it('Nomi 标签没有权限模式按钮', async () => {
    const invoke = mockIpc({ backend: 'nomi' });
    const r = mount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tabs'));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.queryByTestId('permission-mode-chip')).toBeNull();
  });
});

describe('「完全放开」确认绑定发起的标签（#66）', () => {
  // 两个 Claude 标签 A / B；推送 ai:harness:tabs 模拟切标签（快捷键、程序切换都走这条）
  function mockTwoTabs() {
    const a = tab({ id: 'ta', title: 'A', cwd: '/repo-a' });
    const b = tab({ id: 'tb', title: 'B', cwd: '/repo-b' });
    const state = (activeTabId: string, tabs = [a, b]): HarnessTabsState => ({
      tabs: [tab({ id: 'main', backend: 'nomi' }), ...tabs],
      activeTabId,
      maxConcurrent: 3,
      running: 0,
      queued: 0,
      defaultPermissionMode: 'acceptEdits',
    });
    let push: (s: HarnessTabsState) => void = () => undefined;
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:harness:tabs') return state('ta');
      if (ch === 'ai:harness:state') return { backend: 'nomi', cwd: '/w', bins: { claude: '/c' } };
      if (ch === 'ai:harness:recent-cwds') return [];
      if (ch === 'ai:harness:tab-messages') return [];
      if (ch === 'ai:cli-provider:state') return { profiles: [] };
      return {};
    });
    const on = (ch: string, fn: (p: unknown) => void) => {
      if (ch === 'ai:harness:tabs') push = fn as typeof push;
      return () => undefined;
    };
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
    return { invoke, a, b, state, push: (s: HarnessTabsState) => act(() => push(s)) };
  }
  const bypassCalls = (invoke: ReturnType<typeof vi.fn>) =>
    invoke.mock.calls.filter((c) => c[0] === 'ai:harness:tab-permission-mode');

  const openConfirm = async (r: ReturnType<typeof mount>) => {
    fireEvent.click(await r.findByTestId('permission-mode-chip'));
    fireEvent.click(r.getByTestId('permission-mode-bypass'));
    await r.findByTestId('permission-bypass-confirm');
  };

  it('确认框打开时切到另一个标签：确认作废，不会放开 B；切回 A 也不复活', async () => {
    const m = mockTwoTabs();
    const r = mount();
    await openConfirm(r);
    m.push(m.state('tb'));
    await waitFor(() => expect(r.queryByTestId('permission-bypass-confirm')).toBeNull());
    m.push(m.state('ta'));
    await new Promise((res) => setTimeout(res, 20));
    expect(r.queryByTestId('permission-bypass-confirm')).toBeNull();
    expect(bypassCalls(m.invoke)).toHaveLength(0);
  });

  it('确认期间原标签换了目录或被关闭：确认作废', async () => {
    const m = mockTwoTabs();
    const r = mount();
    await openConfirm(r);
    m.push(m.state('ta', [{ ...m.a, cwd: '/elsewhere' }, m.b]));
    await waitFor(() => expect(r.queryByTestId('permission-bypass-confirm')).toBeNull());

    await openConfirm(r);
    m.push(m.state('tb', [m.b]));
    await waitFor(() => expect(r.queryByTestId('permission-bypass-confirm')).toBeNull());
    expect(bypassCalls(m.invoke)).toHaveLength(0);
  });

  it('不切换时确认只发给 A，并带上 A 的后端 / 目录供主进程核对', async () => {
    const m = mockTwoTabs();
    const r = mount();
    await openConfirm(r);
    expect(r.getByTestId('permission-bypass-target').textContent).toContain('/repo-a');
    fireEvent.click(r.getByTestId('permission-bypass-ok'));
    await waitFor(() => expect(bypassCalls(m.invoke)).toHaveLength(1));
    expect(bypassCalls(m.invoke)[0]).toEqual([
      'ai:harness:tab-permission-mode',
      'ta',
      'bypass',
      { confirmed: true, expect: { backend: 'claude', cwd: '/repo-a' } },
    ]);
  });

  it('取消不发送任何请求', async () => {
    const m = mockTwoTabs();
    const r = mount();
    await openConfirm(r);
    fireEvent.click(r.getByText('取消', { selector: '.cd-modal__footer button' }));
    await waitFor(() => expect(r.queryByTestId('permission-bypass-confirm')).toBeNull());
    expect(bypassCalls(m.invoke)).toHaveLength(0);
  });
});

describe('/mode 斜杠命令', () => {
  const mode = (backend: 'claude' | 'dsh') =>
    nativeCommands(backend).find((c) => c.name === 'mode')!;
  const ctx = (backend: 'claude' | 'dsh') => ({ backend }) as never;

  it('切到指定档位；不支持时说明降级；不能用命令进入「完全放开」', async () => {
    const invoke = mockIpc();
    const r = await mode('claude').run('auto', ctx('claude'));
    expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'auto', {});
    expect(JSON.stringify(r)).toContain('自动');

    mockIpc({ backend: 'dsh' });
    const d = await mode('dsh').run('manual', ctx('dsh'));
    expect(JSON.stringify(d)).toContain('已使用「计划」');

    const inv2 = mockIpc();
    const b = await mode('claude').run('bypass', ctx('claude'));
    expect(JSON.stringify(b)).toContain('不能用命令切换');
    expect(inv2.mock.calls.some((c) => c[0] === 'ai:harness:tab-permission-mode')).toBe(false);
  });

  it('不带参数列出当前端支持的档位（dsh 没有逐项确认）', async () => {
    const r = JSON.stringify(await mode('dsh').run('', ctx('dsh')));
    expect(r).toContain('计划');
    expect(r).not.toContain('逐项确认');
  });
});

describe('输入栏只留端点与权限模式', () => {
  it('输入栏组件里没有工作目录和供应商；它们在对话区右上角的 SessionControls 里', async () => {
    mockIpc({ backend: 'codex' });
    const bar = render(
      <HarnessTabsProvider>
        <EndpointControls />
      </HarnessTabsProvider>,
    );
    await bar.findByTestId('permission-mode-chip');
    expect(bar.queryByTestId('cli-workspace')).toBeNull();
    expect(bar.queryByTestId('cli-provider-chip')).toBeNull();
    bar.unmount();

    const top = render(
      <HarnessTabsProvider>
        <SessionControls onManageNomi={() => undefined} onManageCli={() => undefined} />
      </HarnessTabsProvider>,
    );
    await top.findByTestId('cli-workspace');
    expect(top.getByTestId('session-controls')).toBeTruthy();
    expect(top.queryByTestId('permission-mode-chip')).toBeNull();
  });
});
