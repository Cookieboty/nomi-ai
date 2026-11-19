// @vitest-environment happy-dom
/** 设置仅替换内容区：应用导航可用，会话输入框保持同一个实例。 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it } from 'vitest';

import App from '../src/App';
import { onboardingClient } from '../src/components/Onboarding/client';

afterEach(cleanup);

it('在工作台内容区打开设置，返回后保留原来的草稿和会话树', async () => {
  onboardingClient.setPreparedDone(true);
  const r = render(<App />);
  const input = (await r.findByTestId('chat-input')) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '尚未发送的草稿' } });
  const rail = r.getByTestId('app-rail');
  fireEvent.click(r.getByTestId('open-settings'));
  const settings = await r.findByTestId('settings-view');
  expect(settings.closest('[data-testid="workspace-card"]')).toBeTruthy();
  expect(r.getByTestId('app-rail')).toBe(rail);
  expect(r.getByTestId('sidebar-panel').hidden).toBe(true);
  expect(r.queryByTestId('settings-brand')).toBeNull();
  expect(r.getByTestId('open-settings').getAttribute('aria-current')).toBe('page');
  fireEvent.click(r.getByTestId('nav-chats'));
  await waitFor(() => expect(r.queryByTestId('settings-view')).toBeNull());
  expect(r.getByTestId('chat-input')).toBe(input);
  expect(input.value).toBe('尚未发送的草稿');
  expect(r.getByTestId('sidebar-panel').hidden).toBe(false);
  fireEvent.click(r.getByTestId('open-settings'));
  await r.findByTestId('settings-view');
  // 侧栏不再有「返回对话」按钮，Esc 是关闭设置的入口
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(r.queryByTestId('settings-view')).toBeNull());
  expect(r.getByTestId('chat-input')).toBe(input);
  expect(input.value).toBe('尚未发送的草稿');
});
