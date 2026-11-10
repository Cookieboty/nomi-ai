// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { PreviewDocumentContext } from '../src/components/ResourcePreview/PreviewDocumentContext';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
afterEach(cleanup);

it('preserves report marker text in documents while the conversation hides protocol markers', () => {
  const text = '[nomi-report]\nWhat I did: Example\n[/nomi-report]';
  render(
    <>
      <div data-testid="conversation">
        <Markdown text={text} settled />
      </div>
      <div data-testid="document">
        <PreviewMarkdown text={text} />
      </div>
    </>,
  );
  expect(screen.getByTestId('conversation').textContent).not.toContain('[nomi-report]');
  expect(screen.getByTestId('document').textContent).toContain('[nomi-report]');
  expect(screen.getByTestId('document').textContent).toContain('[/nomi-report]');
});

it('keeps document heading levels separate from conversation density', () => {
  const view = render(<Markdown text="# Heading" settled />);
  expect(screen.getByRole('heading').tagName).toBe('H2');
  view.rerender(<PreviewMarkdown text="# Heading" />);
  expect(screen.getByRole('heading').tagName).toBe('H1');
});

it('only resolves document links inside the document, even beneath the same host interface', () => {
  const scope = { id: 'host', cwd: '/parent' };
  const open = vi.fn();
  render(
    <ResourceScopeProvider value={{ scope, open }}>
      <PreviewDocumentContext.Provider value={{ directory: '/document/docs' }}>
        <Markdown text="[Conversation](other.md)" settled />
        <PreviewMarkdown text="[Document](other.md)" />
      </PreviewDocumentContext.Provider>
    </ResourceScopeProvider>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Conversation' }));
  expect(open).toHaveBeenLastCalledWith('other.md', scope, { origin: 'assistant' });
  fireEvent.click(screen.getByRole('link', { name: 'Document' }));
  expect(open).toHaveBeenLastCalledWith('/document/docs/other.md', scope, { origin: 'document' });
});

it.each([false, true])(
  'preserves CommonMark reference links across blocks (editable=%s)',
  (editable) => {
    const open = vi.fn();
    render(
      <ResourceScopeProvider value={{ scope: { id: 'host' }, open }}>
        <PreviewDocumentContext.Provider value={{ directory: '/document' }}>
          {editable ? (
            <EditableMarkdown
              text={'[Guide][target]\n\n## Section\n\n[target]: ./guide.md'}
              editable
              onChange={vi.fn()}
            />
          ) : (
            <PreviewMarkdown text={'[Guide][target]\n\n## Section\n\n[target]: ./guide.md'} />
          )}
        </PreviewDocumentContext.Provider>
      </ResourceScopeProvider>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Guide' }));
    expect(open.mock.calls[0]?.[0]).toBe('/document/guide.md');
  },
);
