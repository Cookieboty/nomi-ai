// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalClis } from '../src/components/ProvidersPage/ExternalClis';
import { describeSpecError, idFromName } from '../src/services/cliPluginClient';

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

// 外部 CLI（L1 声明式插件，docs/design/cli-plugin-architecture.md §5.9）
afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const entry = (o: Record<string, unknown> = {}) => ({
  id: 'my-agent',
  displayName: 'My Agent',
  builtin: false,
  status: 'ready',
  errors: [],
  version: null,
  transport: 'acp',
  capabilities: {},
  external: {
    version: 1,
    id: 'my-agent',
    displayName: 'My Agent',
    command: '/bin/my-agent',
    args: ['acp', '{cwd}'],
    env: ['MY_TOKEN'],
    missingEnv: ['MY_TOKEN'],
  },
  ...o,
});

function mockIpc(over: Record<string, (...a: unknown[]) => unknown> = {}) {
  const plugins: unknown[] = [{ id: 'claude', builtin: true, status: 'ready' }, entry()];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    'ai:cli:registry': () => ({ plugins }),
    'ai:cli:plugin-add': () => ({ ok: true, entry: entry() }),
    'ai:cli:plugin-remove': () => true,
    'ai:cli:plugin-test': () => ({
      ok: true,
      missingEnv: [],
      protocolVersion: 1,
      agent: { name: 'mock-acp', version: '0.1.0' },
      capabilities: { loadSession: true, images: false, audio: false, embeddedContext: false },
      authMethods: [],
    }),
    'ai:harness:tab-create': (o) => ({ id: 't1', ...(o as object) }),
    ...over,
  };
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => handlers[ch]?.(...a));
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

describe('ExternalClis', () => {
  it('列出外部插件（不含内置）：命令行、缺少的环境变量；新建标签带 pluginId', async () => {
    const invoke = mockIpc();
    const opened = vi.fn();
    const v = render(<ExternalClis onOpenedTab={opened} />);
    await waitFor(() => expect(v.getByTestId('external-cli-my-agent')).toBeTruthy());
    expect(v.queryByTestId('external-cli-claude')).toBeNull();
    const row = v.getByTestId('external-cli-my-agent');
    expect(row.textContent).toContain('/bin/my-agent acp {cwd}');
    expect(row.textContent).toContain('MY_TOKEN');
    fireEvent.click(v.getByText('新建标签'));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('ai:harness:tab-create', {
      backend: 'external',
      pluginId: 'my-agent',
    });
  });

  it('添加：名称生成 id；测试只握手并显示结果；保存发出规范的清单（环境变量只有名字）', async () => {
    const invoke = mockIpc();
    const v = render(<ExternalClis />);
    fireEvent.click(v.getByTestId('external-cli-add'));
    fireEvent.change(v.getByTestId('external-cli-name'), { target: { value: 'Open Agent' } });
    expect((v.getByTestId('external-cli-id') as HTMLInputElement).value).toBe('open-agent');
    fireEvent.change(v.getByTestId('external-cli-command'), { target: { value: ' oa ' } });
    fireEvent.change(v.getByTestId('external-cli-args'), {
      target: { value: 'acp\n\n--cwd\n{cwd}' },
    });
    fireEvent.change(v.getByTestId('external-cli-env'), { target: { value: 'OA_KEY, OA_HOME' } });
    fireEvent.click(v.getByTestId('external-cli-test'));
    await waitFor(() => expect(v.getByTestId('external-cli-test-result')).toBeTruthy());
    expect(v.getByTestId('external-cli-test-result').textContent).toContain('mock-acp 0.1.0');
    fireEvent.click(v.getByTestId('external-cli-save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:cli:plugin-add', {
        version: 1,
        id: 'open-agent',
        displayName: 'Open Agent',
        command: 'oa',
        args: ['acp', '--cwd', '{cwd}'],
        env: ['OA_KEY', 'OA_HOME'],
      }),
    );
  });

  it('保存失败：主进程的校验错误翻成界面文案', async () => {
    mockIpc({
      'ai:cli:plugin-add': () => ({
        ok: false,
        errors: [
          'args[0] uses unknown placeholder {token}',
          'id claude is reserved by a built-in plugin',
        ],
      }),
    });
    const v = render(<ExternalClis />);
    fireEvent.click(v.getByTestId('external-cli-add'));
    fireEvent.click(v.getByTestId('external-cli-save'));
    await waitFor(() => expect(v.getByTestId('external-cli-errors')).toBeTruthy());
    const text = v.getByTestId('external-cli-errors').textContent!;
    expect(text).toContain('第 1 个参数用了未知的占位符 {token}');
    expect(text).toContain('已被内置编程助手占用');
  });

  it('idFromName / describeSpecError', () => {
    expect(idFromName('My Cool  Agent!')).toBe('my-cool-agent');
    expect(idFromName('中文')).toBe('my-cli');
    expect(describeSpecError('env[0] must be an environment variable name (no values)')).toContain(
      '不要写值',
    );
  });
});
