// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { liveOf } from '../src/components/Sidebar/SidebarRows';
import type { HarnessTabMeta } from '../src/services/harnessClient';

afterEach(cleanup);

const tab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'x',
  title: 'X',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: 's1',
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('dormant coding-assistant tab', () => {
  it('shows as dormant only when nothing more important is going on', () => {
    expect(liveOf(tab({ dormant: true }))).toBe('dormant');
    // 有新结果 / 运行中 / 出错优先
    expect(liveOf(tab({ dormant: true, status: 'running' }))).toBe('running');
    // 普通空闲没有提示
    expect(liveOf(tab())).toBe('');
  });

  it('the conversation view shows the resume hint while idle, not while running', () => {
    const base = { scopeId: 'x', messages: [], live: null, phase: 'idle' as const };
    const { rerender, queryByTestId } = render(<ConversationView {...base} />);
    expect(queryByTestId('conv-dormant')).toBeNull();
    rerender(<ConversationView {...base} dormant />);
    expect(queryByTestId('conv-dormant')?.textContent).toContain('自动续接');
    rerender(<ConversationView {...base} dormant phase="running" />);
    expect(queryByTestId('conv-dormant')).toBeNull();
  });
});
