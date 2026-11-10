// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../src/components/Conversation/Messages';
import { MarkdownDocument } from '../src/components/ResourcePreview/MarkdownDocument';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { delegateResultMessage } from '../src/services/delegateMessage';
import { fromChatMessage } from '../src/utils/convAdapters';

import { resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const scope = { id: 'nomi:c1', cwd: '/work/parent', source: 'nomi' };

it.each([false, true])(
  'keeps upstream delegate result messages unscoped (followUp=%s), including after reload',
  (followUp) => {
    const saved = delegateResultMessage(
      {
        taskId: 'd1',
        cli: 'claude',
        status: 'done',
        summary: '[Child Readme](README.md) [Web](https://example.com)',
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 1000,
        conversationId: 'c1',
        followUp,
      },
      123,
    );
    const open = vi.fn();
    render(
      <ResourceScopeProvider value={{ scope, open }}>
        <AssistantMessage
          message={fromChatMessage(JSON.parse(JSON.stringify(saved)))!}
          canRetry={false}
        />
      </ResourceScopeProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Child Readme' })).toBeNull();
    fireEvent.click(screen.getByText(/Child Readme/));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Web' }).getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(
      screen.getByRole('link', { name: 'Web' }).getAttribute('data-resource-preview'),
    ).toBeNull();
    // No fork-only provenance fields or changes to the persisted upstream result protocol.
    expect(Object.keys(saved).sort()).toEqual(['content', 'id', 'origin', 'role', 'timestamp']);
  },
);

it.each([undefined, 'background'] as const)(
  'keeps ordinary conversation file/image links using the conversation scope (origin=%s)',
  (origin) => {
    const open = vi.fn();
    render(
      <ResourceScopeProvider value={{ scope, open }}>
        <AssistantMessage
          message={{
            id: 'assistant-1',
            role: 'assistant',
            at: 1,
            origin,
            text: '[File](README.md) [Picture](image.png)',
          }}
          canRetry={false}
        />
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'File' }));
    expect(open).toHaveBeenLastCalledWith('README.md', scope, { origin: 'assistant' });
    fireEvent.click(screen.getByRole('link', { name: 'Picture' }));
    expect(open).toHaveBeenLastCalledWith('image.png', scope, { origin: 'assistant' });
  },
);

it('resolves preview-internal links against the document, not the main conversation', () => {
  const open = vi.fn();
  render(
    <ResourceScopeProvider value={{ scope, open }}>
      <MarkdownDocument
        outline={false}
        onOutlineChange={() => undefined}
        scrollTop={0}
        onScroll={() => undefined}
        text="[Sibling](other.md)"
        context={{ scope, open }}
        documentDir="/work/child/docs"
        documentPath="/work/child/docs/readme.md"
      />
    </ResourceScopeProvider>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
  expect(open).toHaveBeenLastCalledWith('/work/child/docs/other.md', scope, { origin: 'document' });
});
