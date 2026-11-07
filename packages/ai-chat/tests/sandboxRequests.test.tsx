// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SandboxRequests } from '../src/components/Conversation/SandboxRequests';
import type { SandboxPendingItem } from '../src/services/harnessClient';

afterEach(cleanup);

const item = (p: Partial<SandboxPendingItem>): SandboxPendingItem => ({
  id: 'sbx-1',
  kind: 'category',
  value: 'ssh',
  op: 'read',
  path: '/Users/me/.ssh/config',
  at: 1,
  ...p,
});

describe('SandboxRequests', () => {
  it('renders nothing without pending items', () => {
    const r = render(<SandboxRequests items={[]} onReply={() => undefined} />);
    expect(r.queryByTestId('conv-sandbox-requests')).toBeNull();
  });

  it('offers session / always / deny and reports the choice with the request id', () => {
    const onReply = vi.fn();
    const r = render(
      <SandboxRequests
        items={[
          item({}),
          item({ id: 'sbx-2', kind: 'folder', value: '/Users/me/.ai-usage', op: 'write' }),
        ]}
        onReply={onReply}
      />,
    );
    expect(r.getAllByTestId('conv-sandbox-card')).toHaveLength(2);
    fireEvent.click(r.getAllByTestId('conv-sandbox-session')[0]!);
    fireEvent.click(r.getAllByTestId('conv-sandbox-always')[1]!);
    fireEvent.click(r.getAllByTestId('conv-sandbox-deny')[0]!);
    expect(onReply.mock.calls).toEqual([
      ['sbx-1', 'session'],
      ['sbx-2', 'always'],
      ['sbx-1', 'deny'],
    ]);
  });

  it('protected folders can only be dismissed, not allowed from the chat', () => {
    const onReply = vi.fn();
    const r = render(
      <SandboxRequests
        items={[item({ kind: 'protected', value: '/Users/me/finance' })]}
        onReply={onReply}
      />,
    );
    expect(r.queryByTestId('conv-sandbox-session')).toBeNull();
    expect(r.queryByTestId('conv-sandbox-always')).toBeNull();
    fireEvent.click(r.getByTestId('conv-sandbox-dismiss'));
    expect(onReply).toHaveBeenCalledWith('sbx-1', 'deny');
  });

  it('secret files are granted one by one; credentials and files are remembered per project', () => {
    const r = render(
      <SandboxRequests
        items={[
          item({ id: 'a', kind: 'read', value: '/repo/.env', path: '/repo/.env' }),
          item({ id: 'b', kind: 'folder', value: '/Users/me/.ai-usage', op: 'write' }),
        ]}
        onReply={() => undefined}
      />,
    );
    const always = r.getAllByTestId('conv-sandbox-always').map((b) => b.textContent);
    expect(always[0]).not.toBe(always[1]);
    // 有没有装词典都行：带路径的文案，或者「读密钥文件」这条 key
    expect(r.getAllByTestId('conv-sandbox-card')[0]!.textContent).toMatch(
      /\/repo\/\.env|sandbox-blocked-read/,
    );
  });
});
