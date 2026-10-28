// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EndpointControls,
  PermissionTip,
  SessionControls,
  WorkspaceControl,
} from '../src/components/EndpointControls';
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

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

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
        running: 0,
        queued: 0,
        defaultPermissionMode: 'acceptEdits',
      } satisfies HarnessTabsState;
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', permissionMode: 'manual', bins: { claude: '/c' } };
    if (ch === 'ai:harness:tab-permission-mode') {
      const mode = a[1] as string;
      const degraded = current.backend === 'dsh' && mode === 'manual';
      current = { ...current, permissionMode: degraded ? 'plan' : (mode as never) };
      return { ...current, degraded };
    }
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:harness:tab-messages') return [];
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

const mount = () =>
  render(
    <HarnessTabsProvider>
      <>
        <PermissionTip />
        <EndpointControls />
        <SessionControls />
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
    // Nomi 没有「完全放开」，Shift+Tab 在四档间循环
    expect(supportedModes('nomi')).toEqual(['plan', 'manual', 'acceptEdits', 'auto']);
    expect(nextMode('nomi', 'auto')).toBe('plan');
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

  it('在下拉里选「完全放开」即生效（带 confirmed 与标签的后端 / 目录），不弹确认框', async () => {
    const invoke = mockIpc();
    const r = mount();
    fireEvent.click(await r.findByTestId('permission-mode-chip'));
    fireEvent.click(r.getByTestId('permission-mode-bypass'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'bypass', {
        confirmed: true,
        expect: { backend: 'claude', cwd: '/w' },
      }),
    );
    expect(r.queryByRole('dialog')).toBeNull();
  });

  it('「完全放开」时输入框上方有提示条：可退回默认档，也可只关掉提示', async () => {
    const invoke = mockIpc({ permissionMode: 'bypass' });
    const r = mount();
    fireEvent.click(await r.findByTestId('permission-bypass-exit'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'cx', 'acceptEdits', {
        confirmed: false,
      }),
    );
    fireEvent.click(r.getByTestId('permission-bypass-tip-close'));
    expect(r.queryByTestId('permission-bypass-tip')).toBeNull();
  });

  it('不是「完全放开」时没有提示条', async () => {
    mockIpc();
    const r = mount();
    await r.findByTestId('permission-mode-chip');
    expect(r.queryByTestId('permission-bypass-tip')).toBeNull();
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

  it('Nomi 对话也有权限模式：作用在主标签上，四档、没有「完全放开」与「设为新标签默认」', async () => {
    const invoke = mockIpc({ backend: 'nomi' });
    const r = mount();
    const chip = await r.findByTestId('permission-mode-chip');
    expect(chip.getAttribute('data-mode')).toBe('manual');
    fireEvent.click(chip);
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual([
      'permission-mode-plan',
      'permission-mode-manual',
      'permission-mode-acceptEdits',
      'permission-mode-auto',
    ]);
    expect(r.queryByTestId('permission-mode-make-default')).toBeNull();
    fireEvent.click(r.getByTestId('permission-mode-plan'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-permission-mode', 'main', 'plan', {
        confirmed: false,
      }),
    );
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
  it('输入栏组件里没有工作目录和供应商：工作目录在对话顶栏，供应商在侧栏信息卡', async () => {
    mockIpc({ backend: 'codex' });
    const bar = render(
      <HarnessTabsProvider>
        <EndpointControls />
      </HarnessTabsProvider>,
    );
    await bar.findByTestId('permission-mode-chip');
    expect(bar.queryByTestId('cli-workspace')).toBeNull();
    expect(bar.queryByTestId('cli-source-menu')).toBeNull();
    bar.unmount();

    const header = render(
      <HarnessTabsProvider>
        <WorkspaceControl />
      </HarnessTabsProvider>,
    );
    await header.findByTestId('cli-workspace');
    header.unmount();

    // 输入框下方：CLI 标签没有「带上前文」时什么都不显示（供应商不在这里选）
    const below = render(
      <HarnessTabsProvider>
        <SessionControls />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(below.queryByTestId('session-controls')).toBeNull());
    expect(below.queryByTestId('cli-source-menu')).toBeNull();
  });
});
