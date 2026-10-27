// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GettingStarted } from '../src/components/GettingStarted';
import { cliUpdateClient } from '../src/services/cliUpdateClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});
beforeEach(() => {
  cliUpdateClient.resetCache();
  localStorage.clear();
});

function mockIpc(opts: { model: boolean | 'unassigned'; installed: Array<'claude' | 'codex'> }) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    // Nomi 对话的模型以网关为准：clients.nomi.models.main
    if (ch === 'ai:gateway:state')
      return {
        status: { running: true },
        providers: opts.model
          ? [
              {
                id: 'p1',
                name: 'P1',
                enabled: true,
                source: 'user',
                models: [{ id: 'm1', enabled: true }],
                urls: {},
              },
            ]
          : [],
        clients: opts.model === true ? { nomi: { models: { main: 'p1/m1' } } } : {},
      };
    if (ch === 'ai:cli-update:inspect')
      return (['claude', 'codex'] as const).map((kind) => ({
        kind,
        path: opts.installed.includes(kind) ? `/usr/local/bin/${kind}` : null,
        version: null,
        latest: null,
        installMethod: 'unknown',
        updateAvailable: false,
        updateSupported: true,
      }));
    if (ch === 'ai:cli-update:busy') return null;
    if (ch === 'ai:cli-update:preview')
      return {
        kind: 'claude',
        scope: 'global',
        argv: ['npm', 'i'],
        blockers: [],
        requirements: [],
      };
    return null;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

const renderIt = (p: Partial<React.ComponentProps<typeof GettingStarted>> = {}) => {
  const onOpenSettings = vi.fn();
  const onStart = vi.fn();
  const r = render(
    <GettingStarted
      mode="assistant"
      hasChats={false}
      onOpenSettings={onOpenSettings}
      onStart={onStart}
      {...p}
    />,
  );
  return { r, onOpenSettings, onStart };
};

describe('GettingStarted（侧栏「开始使用」清单）', () => {
  it('新装：助手模式先「添加模型」，编程助手标可选，「开始」不可点；点添加去设置 → 模型', async () => {
    mockIpc({ model: false, installed: [] });
    const { r, onOpenSettings } = renderIt();
    await waitFor(() => r.getByTestId('getting-started'));
    const ids = [...r.container.querySelectorAll('[data-testid^="getting-started-step-"]')].map(
      (e) => e.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'getting-started-step-model',
      'getting-started-step-cli',
      'getting-started-step-start',
    ]);
    expect(r.getByTestId('getting-started-step-cli').textContent).toContain('可选');
    expect(r.getByTestId('getting-started-start')).toHaveProperty('disabled', true);
    expect(r.queryByTestId('getting-started-tips')).toBeNull();
    fireEvent.click(r.getByTestId('getting-started-add-model'));
    expect(onOpenSettings).toHaveBeenCalledWith('models');
  });

  it('工作台模式先装编程助手；只列出还没装的；点安装弹出确认框', async () => {
    const invoke = mockIpc({ model: false, installed: ['codex'] });
    const { r } = renderIt({ mode: 'workbench' });
    await waitFor(() => r.getByTestId('getting-started'));
    expect(
      r.container
        .querySelector('[data-testid^="getting-started-step-"]')!
        .getAttribute('data-testid'),
    ).toBe('getting-started-step-cli');
    // 装了 Codex：这一步已完成，不再显示安装按钮；模型标可选
    expect(r.getByTestId('getting-started-step-cli').getAttribute('data-done')).toBe('true');
    expect(r.queryByTestId('getting-started-install-codex')).toBeNull();
    expect(r.getByTestId('getting-started-step-model').textContent).toContain('可选');
    expect(r.getByTestId('getting-started-start')).toHaveProperty('disabled', false);
    cleanup();
    mockIpc({ model: false, installed: [] });
    const again = renderIt({ mode: 'workbench' }).r;
    await waitFor(() => again.getByTestId('getting-started-install-claude'));
    fireEvent.click(again.getByTestId('getting-started-install-claude'));
    await waitFor(() =>
      expect(
        (window as unknown as { aiIPC: { invoke: typeof invoke } }).aiIPC.invoke,
      ).toHaveBeenCalledWith('ai:cli-update:preview', 'claude', 'global'),
    );
  });

  it('已有模型但还没选给 Nomi：这一步提示「选择模型」，不是「添加」', async () => {
    mockIpc({ model: 'unassigned', installed: [] });
    const { r, onOpenSettings } = renderIt();
    await waitFor(() => r.getByTestId('getting-started'));
    expect(r.getByTestId('getting-started-step-model').getAttribute('data-done')).toBeNull();
    expect(r.getByTestId('getting-started-add-model').textContent).toBe('选择模型');
    fireEvent.click(r.getByTestId('getting-started-add-model'));
    expect(onOpenSettings).toHaveBeenCalledWith('models');
  });

  it('能用之后：「开始」可点，出现「还可以试试」，跳到知识库 / 扩展', async () => {
    mockIpc({ model: true, installed: [] });
    const { r, onOpenSettings, onStart } = renderIt();
    await waitFor(() => r.getByTestId('getting-started-tips'));
    expect(r.getByTestId('getting-started-step-model').getAttribute('data-done')).toBe('true');
    fireEvent.click(r.getByTestId('getting-started-start'));
    expect(onStart).toHaveBeenCalled();
    fireEvent.click(r.getByText('加一个知识库文件夹'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('knowledge', 'kb');
    fireEvent.click(r.getByText('导入 MCP 与技能'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('ext');
  });

  it('能用且已有对话：不再显示', async () => {
    const invoke = mockIpc({ model: true, installed: ['claude'] });
    const { r } = renderIt({ hasChats: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.queryByTestId('getting-started')).toBeNull();
  });

  it('点「×」隐藏，记在本机，下次也不显示', async () => {
    mockIpc({ model: false, installed: [] });
    const first = renderIt().r;
    fireEvent.click(await waitFor(() => first.getByTestId('getting-started-dismiss')));
    expect(first.queryByTestId('getting-started')).toBeNull();
    cleanup();
    mockIpc({ model: false, installed: [] });
    const second = renderIt().r;
    await new Promise((x) => setTimeout(x, 20));
    expect(second.queryByTestId('getting-started')).toBeNull();
  });

  it('没有桌面桥（浏览器）：不显示', () => {
    const { r } = renderIt();
    expect(r.queryByTestId('getting-started')).toBeNull();
  });
});
