// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useTasksHost } from '../src/components/Tasks';
import { requestOpenTasksPage } from '../src/services/workbenchNav';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/contexts/aiChatStore', () => ({
  selectFirstMessageId: vi.fn(),
  useAiChatSelector: () => null,
}));
vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabs: () => ({ state: { activeTabId: null } }),
}));

// 保留真实懒加载器与任务页，只延迟模块返回，模拟首次命令到达时 chunk 尚未下载完成。
const chunk = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((r) => {
    resolve = r;
  });
  return { ready, resolve };
});
vi.mock('../src/components/Tasks/TasksPage', async (importOriginal) => {
  await chunk.ready;
  return importOriginal();
});

function Host() {
  const { nav, page, close } = useTasksHost(false);
  return (
    <>
      {nav}
      <button onClick={close}>Back to chat</button>
      {page}
    </>
  );
}

afterEach(() => {
  cleanup();
  resetFakeApi();
});

it('新建命令加载期间返回聊天：完成加载不弹窗，普通打开不重放，新的命令仍可新建', async () => {
  const fake = installFakeApi({
    'tasks.list': () => ({ tasks: [], legacy: [] }),
    'harness.state': () => ({ bins: {} }),
    'ext.mcpList': () => ({ servers: [], env: [], presets: [], ready: true }),
  });
  render(<Host />);
  act(() => requestOpenTasksPage(true));
  expect(screen.getByTestId('panel-fallback')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
  expect(screen.getByTestId('tasks-main').hidden).toBe(true);

  await act(async () => {
    chunk.resolve();
    await vi.dynamicImportSettled();
    await fake.settle();
  });
  await screen.findByTestId('tasks-list');
  expect(screen.getByTestId('tasks-main').hidden).toBe(true);
  // Modal 会 portal 到 body；不能只检查任务容器的 hidden。
  expect(screen.queryByTestId('task-form-title')).toBeNull();

  act(() => requestOpenTasksPage());
  await act(() => fake.settle());
  expect(screen.getByTestId('tasks-main').hidden).toBe(false);
  expect(screen.queryByTestId('task-form-title')).toBeNull();

  act(() => requestOpenTasksPage(true));
  await act(() => fake.settle());
  expect(screen.getAllByTestId('task-form-title')).toHaveLength(1);
  expect(fake.calls.some(([name]) => name === 'tasks.create')).toBe(false);
});
