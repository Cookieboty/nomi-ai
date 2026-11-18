// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationWelcome } from '../src/components/ConversationWelcome';

afterEach(cleanup);

describe('新会话欢迎区（图标 + 标题 + 小标题）', () => {
  it('主对话显示标题与小标题，不再自己渲染示例问题卡片', () => {
    const r = render(<ConversationWelcome title="开始" />);
    expect(r.getByTestId('welcome-screen')).toBeTruthy();
    expect(r.getByText('开始')).toBeTruthy();
    // 示例问题卡片移到了输入框下方（PromptCards），欢迎区不再有
    expect(r.queryByTestId('quick-action-hello')).toBeNull();
    expect(r.queryByTestId('welcome-prompts')).toBeNull();
  });

  it('agent 空会话使用对应图标，装饰图形不重复朗读', () => {
    const r = render(
      <ConversationWelcome backend="gemini" title="Gemini" description="开始编程" />,
    );
    expect(r.getByTestId('cli-tab-empty')).toBeTruthy();
    expect(r.getByTestId('endpoint-icon-gemini').getAttribute('aria-hidden')).toBe('true');
  });
});
