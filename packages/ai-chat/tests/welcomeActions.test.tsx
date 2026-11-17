// @vitest-environment happy-dom
/**
 * 空会话主对话输入框下方：缺模型时常驻「添加 / 选择模型」引导卡并隐藏示例问题（点了只会报错）；
 * 模型就绪（或状态还没读到）时是示例问题卡片。引导卡默认可见，键盘 / 触屏都能操作，不靠鼠标悬停。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('../src/contexts/aiChatStore', () => ({
  useAiChatActions: () => ({ actions: { sendMessage } }),
}));
vi.mock('../src/hooks/useUserProfile', () => ({ useUserProfile: () => null }));

import { WelcomeActions } from '../src/components/ConversationWelcome/WelcomeActions';

afterEach(() => {
  cleanup();
  sendMessage.mockReset();
});

describe('空会话输入框下方：模型引导 / 示例问题', () => {
  it.each(['none', 'unassigned'] as const)(
    '缺模型（%s）：常驻引导卡、隐藏示例问题，按钮可聚焦可点',
    (status) => {
      const open = vi.fn();
      const r = render(<WelcomeActions status={status} onOpenModels={open} />);
      const card = r.getByTestId('welcome-needs-model');
      expect(card.getAttribute('data-status')).toBe(status);
      expect(card.getAttribute('aria-label')).toBeTruthy();
      // 默认可见：不是隐藏的悬浮层
      expect(card.getAttribute('hidden')).toBeNull();
      expect(card.closest('[aria-hidden="true"]')).toBeNull();
      expect(r.queryByTestId('welcome-prompts')).toBeNull();
      expect(r.queryByTestId('quick-action-hello')).toBeNull();
      const btn = r.getByTestId('welcome-add-model') as HTMLButtonElement;
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.disabled).toBe(false);
      btn.focus();
      expect(document.activeElement).toBe(btn);
      fireEvent.click(btn);
      expect(open).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it('引导卡样式不依赖悬停显隐（不再是 opacity:0 + :hover 的浮层）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(
      resolve(__dirname, '../src/components/ConversationWelcome/ModelSetupCard.module.css'),
      'utf8',
    );
    expect(css).not.toMatch(/:hover/);
    expect(css).not.toMatch(/opacity:\s*0/);
    expect(css).not.toMatch(/visibility:\s*hidden/);
    expect(css).not.toMatch(/position:\s*absolute/);
  });

  it.each(['ready', null] as const)(
    '模型就绪 / 状态未知（%s）：显示示例问题卡片，点了直接发送',
    (status) => {
      const open = vi.fn();
      const r = render(<WelcomeActions status={status} onOpenModels={open} />);
      expect(r.queryByTestId('welcome-needs-model')).toBeNull();
      expect(r.getByTestId('welcome-prompts')).toBeTruthy();
      const first = r.getByTestId('welcome-prompts').querySelector('button')!;
      fireEvent.click(first);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    },
  );
});
