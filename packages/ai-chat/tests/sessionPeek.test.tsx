// @vitest-environment happy-dom
/** 悬停卡片：Nomi 委派出去的编程助手会话写明「由 Nomi 委派给 X」 */
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionPeek } from '../src/components/Sidebar/SessionPeek';
import type { HarnessTabMeta } from '../src/services/harnessClient';

afterEach(cleanup);

const meta = {
  id: 'c1',
  name: '分析当前工作区',
  backend: 'codex',
  createdAt: 1,
  updatedAt: 2,
} as never;
const tab = (delegation?: unknown) =>
  ({
    id: 't1',
    backend: 'codex',
    cwd: '/w/app',
    status: 'idle',
    unread: 0,
    delegation,
  }) as unknown as HarnessTabMeta;

describe('SessionPeek', () => {
  it('委派出去的会话写明由谁委派给哪个编程助手', () => {
    render(<SessionPeek c={meta} tab={tab({ by: 'nomi' })} top={0} left={0} />);
    expect(screen.getByTestId('session-peek-delegated').textContent).toBe('由 Nomi 委派给 Codex');
  });

  it('自己开的编程助手会话没有这一行', () => {
    render(<SessionPeek c={meta} tab={tab()} top={0} left={0} />);
    expect(screen.queryByTestId('session-peek-delegated')).toBeNull();
  });
});
