// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TasksPage } from '../src/components/Tasks/TasksPage';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

let fake: FakeApi;
beforeEach(() => {
  localStorage.removeItem('nomi.tasks.view');
  fake = installFakeApi({
    'tasks.list': () => ({ tasks: [], legacy: [] }),
    'harness.state': () => ({ bins: {} }),
    'ext.mcpList': () => ({ servers: [], env: [], presets: [], ready: true }),
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('任务页的新建请求', () => {
  it.each([undefined, 0])('初始 nonce=%s：只打开列表', async (createNonce) => {
    render(<TasksPage active onBack={vi.fn()} createNonce={createNonce} />);
    await act(() => fake.settle());
    expect(screen.getByTestId('tasks-list')).toBeTruthy();
    expect(screen.queryByTestId('task-form-title')).toBeNull();
  });

  it.each([1, 3])('初始 nonce=%s：首次挂载就打开新建表单', async (createNonce) => {
    render(
      <React.StrictMode>
        <TasksPage active onBack={vi.fn()} createNonce={createNonce} />
      </React.StrictMode>,
    );
    await act(() => fake.settle());
    expect(screen.getAllByTestId('task-form-title')).toHaveLength(1);
    expect(fake.calls.some(([name]) => name === 'tasks.create')).toBe(false);
  });

  it('取消后不重复消费；后续请求可再打开，Esc 关闭后切回页面也不重开', async () => {
    const onBack = vi.fn();
    const page = (createNonce: number, active = true) => (
      <TasksPage active={active} onBack={onBack} createNonce={createNonce} />
    );
    const r = render(page(1));
    await act(() => fake.settle());
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
    r.rerender(page(1));
    await act(() => fake.settle());
    expect(screen.queryByTestId('task-form-title')).toBeNull();

    r.rerender(page(2));
    await act(() => fake.settle());
    expect(screen.getByTestId('task-form-title')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-form-title')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    r.rerender(page(2, false));
    r.rerender(page(2));
    await act(() => fake.settle());
    expect(screen.queryByTestId('task-form-title')).toBeNull();
    r.rerender(page(3));
    await act(() => fake.settle());
    expect(screen.getAllByTestId('task-form-title')).toHaveLength(1);
  });
});
