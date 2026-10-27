// @vitest-environment happy-dom
/** 语言切换：被 memo 挡住、props 不变的已挂载消息也要换成新语言（#140） */
import { applyLocale, t } from '@nomi-ai/ui';
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppEntries } from '../src/components/AppEntries';
import { UserMessage } from '../src/components/Conversation/Messages';
import type { ConvMessage } from '../src/types/conversation';

afterEach(() => applyLocale('zh-CN'));

const message = { id: 'u1', role: 'user', text: 'hello', at: 1_700_000_000_000 } as ConvMessage;
const onEdit = () => undefined;

/** 父组件本身不随语言重渲染：只剩 UserMessage 自己的订阅 */
const Static = React.memo(function Static() {
  return <UserMessage message={message} canEdit onEdit={onEdit} />;
});

describe('memo 边界随语言更新', () => {
  it('中文 → English → 中文：已挂载消息的操作按钮文案即时切换', () => {
    applyLocale('zh-CN');
    render(<Static />);
    const zh = t('ui.usage-tools.edit-and-resend');
    expect(screen.getByLabelText(zh)).toBeTruthy();
    act(() => applyLocale('en'));
    expect(screen.getByLabelText('Edit and resend')).toBeTruthy();
    expect(screen.queryByLabelText(zh)).toBeNull();
    act(() => applyLocale('zh-CN'));
    expect(screen.getByLabelText(zh)).toBeTruthy();
  });

  it('侧栏底部入口（App 里用 useMemo 缓存的 footer 元素）：切到 English 后文案刷新', () => {
    applyLocale('zh-CN');
    const noop = () => undefined;
    const Footer = React.memo(function Footer() {
      return (
        <AppEntries collapsed={false} onHub={noop} onExt={noop} onLocal={noop} onSettings={noop} />
      );
    });
    render(<Footer />);
    expect(screen.getByTestId('open-settings').textContent).toContain('设置');
    act(() => applyLocale('en'));
    expect(screen.getByTestId('open-settings').textContent).toContain('Settings');
  });
});
