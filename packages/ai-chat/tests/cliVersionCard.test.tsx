// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliVersionCard, versionState } from '../src/components/ProvidersPage/CliVersionCard';
import { cliUpdateClient } from '../src/services/cliUpdateClient';
import type { CliInstallInfo, CliInstallPlan } from '../src/services/cliUpdateClient';

const info = (o: Partial<CliInstallInfo>): CliInstallInfo => ({
  kind: 'dsh',
  path: null,
  version: null,
  latest: '0.2.0-rc.2',
  installMethod: 'unknown',
  updateAvailable: false,
  updateSupported: true,
  installSupported: true,
  ...o,
});
const plan = (o: Partial<CliInstallPlan> = {}): CliInstallPlan => ({
  kind: 'dsh',
  mode: 'install',
  scope: 'global',
  argv: ['npm', 'install', '-g', '@deepseek-ai/dsh@latest'],
  command: 'npm install -g @deepseek-ai/dsh@latest',
  requirements: [
    { id: 'node', ok: true, label: 'Node.js ≥ 24', detail: 'v24.1.0' },
    { id: 'npm', ok: true, label: 'npm', detail: '/usr/bin/npm' },
    { id: 'write', ok: true, label: '目录可写', detail: '/usr/local' },
  ],
  blockers: [],
  ...o,
});

type Handler = (...a: unknown[]) => unknown;
function setup(handlers: Record<string, Handler>) {
  const calls: Array<[string, unknown[]]> = [];
  const listeners = new Set<(p: unknown) => void>();
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    return handlers[ch]?.(...args) ?? {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke,
    on: (_c: string, fn: (p: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { calls, emit: (p: unknown) => listeners.forEach((l) => l(p)) };
}

afterEach(() => {
  cleanup();
  cliUpdateClient.resetCache();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

describe('versionState', () => {
  it('maps install info to a state', () => {
    expect(versionState(null)).toBe('unknown');
    expect(versionState(info({}))).toBe('missing');
    expect(versionState(info({ path: '/x', version: '1.0.0', updateAvailable: true }))).toBe(
      'outdated',
    );
    expect(versionState(info({ path: '/x', version: '0.2.0-rc.2' }))).toBe('current');
  });
});

describe('CliVersionCard', () => {
  it('not installed: shows 未安装 + one-click install, confirm dialog shows the exact command', async () => {
    const { calls } = setup({
      'ai:cli-update:inspect': () => [info({})],
      'ai:cli-update:preview': () => plan(),
      'ai:cli-update:run': () => ({ ok: true, log: '', version: '0.2.0-rc.2', path: '/x/dsh' }),
    });
    const r = render(<CliVersionCard kind="dsh" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-version-state-dsh').getAttribute('data-state')).toBe('missing'),
    );
    expect(r.getByTestId('cli-version-action-dsh').textContent).toBe('一键安装');
    expect(r.getByTestId('cli-version-latest-dsh').textContent).toBe('0.2.0-rc.2');

    // 点击只出确认框，不执行
    fireEvent.click(r.getByTestId('cli-version-action-dsh'));
    await waitFor(() => r.getByTestId('cli-version-command'));
    expect(r.getByTestId('cli-version-command').textContent).toBe(
      'npm install -g @deepseek-ai/dsh@latest',
    );
    expect(calls.some(([c]) => c === 'ai:cli-update:run')).toBe(false);
    expect(r.getByTestId('cli-version-req-node').getAttribute('data-ok')).toBe('1');

    fireEvent.click(r.getByTestId('cli-version-confirm'));
    await waitFor(() => r.getByTestId('cli-version-result-dsh'));
    expect(r.getByTestId('cli-version-result-dsh').getAttribute('data-ok')).toBe('1');
    expect(calls.filter(([c]) => c === 'ai:cli-update:run')).toHaveLength(1);
    expect(calls.find(([c]) => c === 'ai:cli-update:run')![1]).toEqual(['dsh', 'global']);
  });

  it('failed requirement (Node < 24) disables confirm and shows the reason', async () => {
    setup({
      'ai:cli-update:inspect': () => [info({})],
      'ai:cli-update:preview': () =>
        plan({
          requirements: [{ id: 'node', ok: false, label: 'Node.js ≥ 24', detail: 'v22.14.0' }],
          blockers: ['需要 Node.js ≥ 24，当前是 v22.14.0。请先升级 Node.js 再安装。'],
        }),
    });
    const r = render(<CliVersionCard kind="dsh" />);
    await waitFor(() => r.getByTestId('cli-version-action-dsh'));
    await waitFor(() =>
      expect((r.getByTestId('cli-version-action-dsh') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(r.getByTestId('cli-version-action-dsh'));
    await waitFor(() => r.getByTestId('cli-version-blocker'));
    expect(r.getByTestId('cli-version-req-node').getAttribute('data-ok')).toBe('0');
    expect((r.getByTestId('cli-version-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('read-only global dir: offers the user-directory install, never sudo', async () => {
    const { calls } = setup({
      'ai:cli-update:inspect': () => [info({ kind: 'codex' })],
      'ai:cli-update:preview': (_k, scope) =>
        scope === 'user'
          ? plan({
              kind: 'codex',
              scope: 'user',
              command: 'npm install -g @openai/codex@latest --prefix /home/u/.local',
            })
          : plan({
              kind: 'codex',
              command: 'npm install -g @openai/codex@latest',
              blockers: ['npm 全局目录 /usr/local 没有写入权限。Nomi 不会自动使用 sudo'],
              userScopeCommand: 'npm install -g @openai/codex@latest --prefix /home/u/.local',
            }),
      'ai:cli-update:run': () => ({ ok: true, log: '', version: '0.162.1' }),
    });
    const r = render(<CliVersionCard kind="codex" />);
    await waitFor(() =>
      expect((r.getByTestId('cli-version-action-codex') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(r.getByTestId('cli-version-action-codex'));
    await waitFor(() => r.getByTestId('cli-version-user-scope'));
    expect(r.container.ownerDocument.body.textContent).not.toMatch(/sudo npm/);
    fireEvent.click(r.getByTestId('cli-version-user-scope'));
    await waitFor(() =>
      expect(r.getByTestId('cli-version-command').textContent).toContain('--prefix'),
    );
    fireEvent.click(r.getByTestId('cli-version-confirm'));
    await waitFor(() => r.getByTestId('cli-version-result-codex'));
    expect(calls.find(([c]) => c === 'ai:cli-update:run')![1]).toEqual(['codex', 'user']);
  });

  it('outdated: shows 有新版本 + update label; streams log lines; surfaces errors', async () => {
    const { emit } = setup({
      'ai:cli-update:inspect': () => [
        info({
          kind: 'claude',
          path: '/usr/bin/claude',
          version: '2.1.0',
          latest: '2.1.300',
          updateAvailable: true,
        }),
      ],
      'ai:cli-update:preview': () => plan({ kind: 'claude', mode: 'update' }),
      'ai:cli-update:run': async () => {
        emit({ kind: 'claude', mode: 'update', phase: 'log', line: 'npm http fetch GET 200' });
        return { ok: false, log: 'npm ERR! EACCES permission denied', version: '2.1.0' };
      },
    });
    const r = render(<CliVersionCard kind="claude" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-version-state-claude').getAttribute('data-state')).toBe('outdated'),
    );
    expect(r.getByTestId('cli-version-action-claude').textContent).toBe('更新到 2.1.300');
    expect(r.getByTestId('cli-version-installed-claude').textContent).toBe('2.1.0');
    fireEvent.click(r.getByTestId('cli-version-action-claude'));
    await waitFor(() => r.getByTestId('cli-version-confirm'));
    fireEvent.click(r.getByTestId('cli-version-confirm'));
    await waitFor(() => r.getByTestId('cli-version-result-claude'));
    expect(r.getByTestId('cli-version-result-claude').getAttribute('data-ok')).toBe('0');
    expect(r.getByTestId('cli-version-result-claude').textContent).toContain('EACCES');
    expect(r.getByTestId('cli-version-log-claude').textContent).toContain('npm http fetch');
  });
});

describe('CliVersionCard · task survives unmount (state lives in the main process)', () => {
  const running = {
    kind: 'codex',
    mode: 'update',
    scope: 'global',
    status: 'running',
    argv: ['npm', 'install', '-g', '@openai/codex@latest'],
    command: 'npm install -g @openai/codex@latest',
    lines: ['$ npm install -g @openai/codex@latest', 'added 1 package'],
    startedAt: 1,
  };

  it('mount → start → unmount → re-mount still shows the running log; finishing shows the result; dismiss clears it', async () => {
    let job: unknown = null;
    const { calls, emit } = setup({
      'ai:cli-update:inspect': () => [
        info({ kind: 'codex', path: '/x/codex', version: '1.0.0', updateAvailable: true }),
      ],
      'ai:cli-update:preview': () => plan({ kind: 'codex', mode: 'update' }),
      'ai:cli-update:run': () => new Promise(() => undefined), // 主进程里一直在跑
      'ai:cli-update:job': () => job,
      'ai:cli-update:dismiss': () => {
        job = null;
        return true;
      },
    });
    const first = render(<CliVersionCard kind="codex" />);
    await waitFor(() => first.getByTestId('cli-version-action-codex'));
    await waitFor(() =>
      expect((first.getByTestId('cli-version-action-codex') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(first.getByTestId('cli-version-action-codex'));
    await waitFor(() => first.getByTestId('cli-version-confirm'));
    job = running; // 主进程已开始任务
    fireEvent.click(first.getByTestId('cli-version-confirm'));
    await waitFor(() => first.getByTestId('cli-version-log-codex'));
    first.unmount(); // 用户切到别的页面

    // 回来：先取快照，再订阅增量
    const again = render(<CliVersionCard kind="codex" />);
    await waitFor(() =>
      expect(again.getByTestId('cli-version-log-codex').textContent).toContain('added 1 package'),
    );
    expect(calls.filter(([c]) => c === 'ai:cli-update:job').length).toBeGreaterThanOrEqual(2);
    expect((again.getByTestId('cli-version-action-codex') as HTMLButtonElement).disabled).toBe(
      true,
    );

    // 增量日志继续追加
    emit({ kind: 'codex', mode: 'update', phase: 'log', line: 'changed 3 packages' });
    await waitFor(() =>
      expect(again.getByTestId('cli-version-log-codex').textContent).toContain(
        'changed 3 packages',
      ),
    );

    // 任务结束：结果由主进程保存，事件触发取快照
    job = {
      ...running,
      status: 'done',
      finishedAt: 2,
      result: { ok: true, log: '', version: '1.1.0', path: '/x/codex' },
    };
    emit({ kind: 'codex', mode: 'update', phase: 'done', version: '1.1.0' });
    await waitFor(() =>
      expect(again.getByTestId('cli-version-result-codex').getAttribute('data-ok')).toBe('1'),
    );
    // 再离开再回来，结果仍在，直到用户关闭
    again.unmount();
    const third = render(<CliVersionCard kind="codex" />);
    await waitFor(() => third.getByTestId('cli-version-result-codex'));
    fireEvent.click(third.getByTestId('cli-version-dismiss-codex'));
    await waitFor(() => expect(third.queryByTestId('cli-version-result-codex')).toBeNull());
    expect(calls.some(([c]) => c === 'ai:cli-update:dismiss')).toBe(true);
  });

  it('another endpoint running does not block this card (installs run in parallel)', async () => {
    const { emit } = setup({
      'ai:cli-update:inspect': () => [info({ kind: 'dsh', path: '/x/dsh', version: '0.1.0' })],
      'ai:cli-update:busy': () => ['claude'],
    });
    const r = render(<CliVersionCard kind="dsh" />);
    const action = () => r.getByTestId('cli-version-action-dsh') as HTMLButtonElement;
    await waitFor(() => expect(action().disabled).toBe(false));
    emit({ kind: 'claude', mode: 'update', phase: 'start', argv: ['claude', 'update'] });
    await new Promise((res) => setTimeout(res, 20));
    expect(action().disabled).toBe(false);
  });

  it('a successful run refreshes versions once via the done event, not again in confirm', async () => {
    const inspect = vi.fn((refresh: unknown) => [
      info({
        kind: 'claude',
        path: '/usr/bin/claude',
        version: refresh === true ? '2.1.300' : '2.1.0',
        latest: '2.1.300',
        updateAvailable: refresh !== true,
      }),
    ]);
    const { calls, emit } = setup({
      'ai:cli-update:inspect': (refresh) => inspect(refresh),
      'ai:cli-update:preview': () => plan({ kind: 'claude', mode: 'update' }),
      'ai:cli-update:run': async () => {
        emit({ kind: 'claude', mode: 'update', phase: 'done', version: '2.1.300' });
        return { ok: true, log: '', version: '2.1.300', path: '/usr/bin/claude' };
      },
    });
    const r = render(<CliVersionCard kind="claude" />);
    await waitFor(() => r.getByTestId('cli-version-action-claude'));
    fireEvent.click(r.getByTestId('cli-version-action-claude'));
    await waitFor(() => r.getByTestId('cli-version-confirm'));
    fireEvent.click(r.getByTestId('cli-version-confirm'));
    await waitFor(() =>
      expect(r.getByTestId('cli-version-installed-claude').textContent).toBe('2.1.300'),
    );
    const inspectCalls = calls.filter(([c]) => c === 'ai:cli-update:inspect');
    expect(inspectCalls).toHaveLength(2); // 挂载时一次 false + done 事件一次 true
    expect(inspectCalls.map(([, a]) => a[0])).toEqual([false, true]);
  });

  it('shows a failed result from the snapshot on re-mount (error surfaced, not lost)', async () => {
    setup({
      'ai:cli-update:inspect': () => [info({ kind: 'dsh', path: '/x/dsh', version: '0.1.0' })],
      'ai:cli-update:job': () => ({
        ...running,
        kind: 'dsh',
        status: 'error',
        result: { ok: false, log: 'EACCES: permission denied', version: null },
      }),
    });
    const r = render(<CliVersionCard kind="dsh" />);
    await waitFor(() =>
      expect(r.getByTestId('cli-version-result-dsh').textContent).toContain('EACCES'),
    );
  });
});
