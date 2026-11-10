// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserMessageLinks } from '../src/components/Conversation/UserMessageLinks';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';

const scope = { id: 'nomi:conversation', cwd: '/project' };
afterEach(cleanup);
describe('user message resource links', () => {
  it('routes websites and file ranges through the same host with user provenance', () => {
    const open = vi.fn();
    render(
      <ResourceScopeProvider value={{ scope, open }}>
        <UserMessageLinks
          text={'百度：https://example.com。\n[代码](src/main.go#L7-L9) 和 www.example.org'}
        />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: '代码' }));
    expect(open).toHaveBeenLastCalledWith('src/main.go#L7-L9', scope, { origin: 'user' });
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com' }));
    expect(open).toHaveBeenLastCalledWith('https://example.com', scope, { origin: 'user' });
    expect(screen.getByRole('link', { name: 'www.example.org' })).toBeTruthy();
  });
  it('resolves references across paragraphs and preserves surrounding text and code', () => {
    const text =
      '**原文**\n[文档][doc]\n\n`https://code.example`\n\n```\nhttps://fenced.example\n```\n\n[doc]: ./guide.md#intro';
    const { container } = render(<UserMessageLinks text={text} />);
    // Relative files require a host; reference syntax remains readable when no host is installed.
    expect(container.textContent).toContain('**原文**');
    expect(container.textContent).toContain('`https://code.example`');
    expect(container.textContent).toContain('https://fenced.example');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
  it('makes standard references clickable with a host and leaves unsafe links and bare paths intact', () => {
    const open = vi.fn();
    const text =
      '[文档][doc]\n\n普通 src/main.go:10 `src/main.go:10` [危险](javascript:alert%281%29)\n\n[doc]: ./guide.md#intro';
    const { container } = render(
      <ResourceScopeProvider value={{ scope, open }}>
        <UserMessageLinks text={text} />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: '文档' }));
    expect(open).toHaveBeenCalledWith('./guide.md#intro', scope, { origin: 'user' });
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toContain('[危险](javascript:alert%281%29)');
    expect(container.textContent).toContain('`src/main.go:10`');
  });
});
