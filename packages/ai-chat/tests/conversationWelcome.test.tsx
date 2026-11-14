// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationWelcome } from '../src/components/ConversationWelcome';

afterEach(cleanup);

describe('新会话欢迎区', () => {
  it.each(['none', 'unassigned'] as const)('模型状态 %s 的配置入口仍可用', (modelStatus) => {
    const open = vi.fn();
    const r = render(
      <ConversationWelcome title="开始" modelStatus={modelStatus} onOpenModels={open} />,
    );
    expect(r.getByTestId('welcome-needs-model').getAttribute('data-status')).toBe(modelStatus);
    expect(r.queryByTestId('quick-action-code')).toBeNull();
    fireEvent.click(r.getByTestId('welcome-add-model'));
    expect(open).toHaveBeenCalledOnce();
  });

  it('已有模型时保留推荐的顺序及点击行为', () => {
    const prompt = vi.fn();
    const r = render(
      <ConversationWelcome title="开始" prompts={['hello', 'code']} onPrompt={prompt} />,
    );
    expect(r.queryByTestId('welcome-needs-model')).toBeNull();
    fireEvent.click(r.getByTestId('quick-action-code'));
    expect(prompt).toHaveBeenCalledWith('code');
  });

  it('编程助手空会话使用对应图标，装饰图形不重复朗读', () => {
    const r = render(
      <ConversationWelcome backend="gemini" title="Gemini" description="开始编程" />,
    );
    expect(r.getByTestId('cli-tab-empty')).toBeTruthy();
    expect(r.getByTestId('endpoint-icon-gemini').getAttribute('aria-hidden')).toBe('true');
    expect(r.queryByTestId('welcome-add-model')).toBeNull();
  });
});
