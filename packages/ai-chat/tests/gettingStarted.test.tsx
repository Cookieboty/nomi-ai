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

type Kind = 'claude' | 'codex' | 'gemini';

function mockIpc(opts: {
  model: boolean | 'unassigned';
  installed: Kind[];
  profile?: { role: string | null; interests: string[] };
  /** 安装命令一直不结束（测试并发） */
  hangRun?: boolean;
}) {
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
      return (['claude', 'codex', 'gemini'] as const).map((kind) => ({
        kind,
        path: opts.installed.includes(kind) ? `/usr/local/bin/${kind}` : null,
        version: null,
        latest: null,
        installMethod: 'unknown',
        updateAvailable: false,
        updateSupported: true,
      }));
    if (ch === 'ai:cli-update:busy') return [];
    if (ch === 'ai:onboarding:profile') return opts.profile ?? null;
    if (ch === 'ai:cli-update:run')
      return opts.hangRun ? new Promise(() => undefined) : { ok: true };
    if (ch === 'ai:cli-update:preview')
      return {
        kind: _a[0] ?? 'claude',
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

  it('按职业推荐：开发者在助手模式下也先装编程助手（不标可选），两个可以同时安装', async () => {
    const invoke = mockIpc({
      model: true,
      installed: [],
      profile: { role: 'developer', interests: [] },
      hangRun: true,
    });
    const { r } = renderIt();
    await waitFor(() => r.getByTestId('getting-started-step-cli'));
    const first = r.container.querySelector('[data-testid^="getting-started-step-"]');
    expect(first!.getAttribute('data-testid')).toBe('getting-started-step-cli');
    expect(r.getByTestId('getting-started-step-cli').textContent).not.toContain('可选');
    expect(r.queryByTestId('getting-started-install-gemini')).toBeNull();
    expect(r.getByTestId('getting-started-tips').textContent).toContain('为你推荐');

    fireEvent.click(r.getByTestId('getting-started-install-claude'));
    fireEvent.click(await waitFor(() => r.getByTestId('cli-version-confirm')));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:cli-update:run', 'claude', 'global'),
    );
    // Claude Code 还在装：它的按钮显示「安装中」，Codex 照样可以点
    expect(r.getByTestId('getting-started-install-claude')).toHaveProperty('disabled', true);
    expect(r.getByTestId('getting-started-install-codex')).toHaveProperty('disabled', false);
    fireEvent.click(r.getByTestId('getting-started-install-codex'));
    fireEvent.click(await waitFor(() => r.getByTestId('cli-version-confirm')));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:cli-update:run', 'codex', 'global'),
    );
    expect(r.getByTestId('getting-started-install-codex')).toHaveProperty('disabled', true);
  });

  it('按职业推荐：学生推荐 Gemini + Codex；职场办公只推荐 Codex 兜底（标可选），推荐日程与知识库', async () => {
    mockIpc({ model: true, installed: [], profile: { role: 'student', interests: [] } });
    const student = renderIt().r;
    await waitFor(() => student.getByTestId('getting-started-install-gemini'));
    expect(student.getByTestId('getting-started-install-codex')).toBeTruthy();
    expect(student.queryByTestId('getting-started-install-claude')).toBeNull();
    cleanup();

    mockIpc({ model: true, installed: [], profile: { role: 'office', interests: [] } });
    const { r, onOpenSettings } = renderIt();
    await waitFor(() => r.getByTestId('getting-started-tips'));
    expect(r.getByTestId('getting-started-step-cli').textContent).toContain('可选');
    expect(r.getByTestId('getting-started-install-codex')).toBeTruthy();
    expect(r.queryByTestId('getting-started-install-claude')).toBeNull();
    fireEvent.click(r.getByText('设一个提醒或日程'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('knowledge', 'schedule');
    // 点过的功能不再列出
    expect(r.queryByText('设一个提醒或日程')).toBeNull();
    expect(r.getByText('加一个知识库文件夹')).toBeTruthy();
  });

  it('选了职业：有了第一个对话后只留「为你推荐」，做完才消失', async () => {
    // 兜底的 Codex 还没装：留着这一步
    mockIpc({ model: true, installed: [], profile: { role: 'creator', interests: [] } });
    const before = renderIt({ hasChats: true }).r;
    await waitFor(() => before.getByTestId('getting-started-install-codex'));
    cleanup();

    mockIpc({ model: true, installed: ['codex'], profile: { role: 'creator', interests: [] } });
    const { r } = renderIt({ hasChats: true });
    await waitFor(() => r.getByTestId('getting-started-tips'));
    expect(r.queryByTestId('getting-started-step-cli')).toBeNull();
    expect(r.queryByTestId('getting-started-step-model')).toBeNull();
    expect(r.queryByTestId('getting-started-step-start')).toBeNull();
    fireEvent.click(r.getByText('试试语音对话（按住 F2 说话）'));
    fireEvent.click(r.getByText('加一个知识库文件夹'));
    await waitFor(() => expect(r.queryByTestId('getting-started')).toBeNull());
  });

  it('没有桌面桥（浏览器）：不显示', () => {
    const { r } = renderIt();
    expect(r.queryByTestId('getting-started')).toBeNull();
  });
});
