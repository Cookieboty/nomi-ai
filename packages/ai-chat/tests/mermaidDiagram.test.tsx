// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { MermaidDiagram } from '../src/components/Conversation/MermaidDiagram';
import { renderDiagram } from '../src/components/Conversation/mermaidRenderer';

vi.mock('../src/components/Conversation/mermaidRenderer', () => ({
  diagramTheme: () => ({ dark: document.documentElement.dataset.theme === 'dark' }),
  renderDiagram: vi.fn(
    async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete document.documentElement.dataset.theme;
});

describe('Mermaid Markdown rendering', () => {
  it('renders a Mermaid fence into a diagram in the shared Markdown component, preserving source toggle', async () => {
    render(<Markdown text={'```mermaid\nflowchart LR\n A --> B\n```'} settled />);
    await screen.findByTestId('mermaid-canvas');
    expect(renderDiagram).toHaveBeenCalledWith(
      expect.stringContaining('A --> B'),
      expect.anything(),
      expect.any(Function),
    );
    expect((await screen.findByRole('img')).getAttribute('aria-label')).toMatch(/Mermaid/);
    fireEvent.click(screen.getByRole('button', { name: /源码|Source/ }));
    expect(screen.getByTestId('mermaid-source').textContent).toContain('A --> B');
    fireEvent.click(screen.getByRole('button', { name: /预览|Preview/ }));
    expect(screen.getByRole('img')).toBeTruthy();
  });
  it('does not parse an unfinished streamed fence', async () => {
    const r = render(<Markdown text={'```mermaid\nflowchart LR\n A -->'} streaming />);
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(renderDiagram).not.toHaveBeenCalled();
    r.rerender(<Markdown text={'```mermaid\nflowchart LR\n A --> B\n```'} settled />);
    await screen.findByTestId('mermaid-canvas');
  });
  it('keeps original code visible on syntax/render failures without inserting an error SVG', async () => {
    vi.mocked(renderDiagram).mockRejectedValueOnce(new Error('syntax'));
    render(<MermaidDiagram code="bad diagram" />);
    await screen.findByTestId('mermaid-source');
    expect(screen.getByRole('status').textContent).toMatch(/源码|source/);
    expect(screen.queryByTestId('mermaid-canvas')).toBeNull();
    expect(screen.getByTestId('mermaid-source').textContent).toBe('bad diagram');
  });
  it('rerenders using current theme and ignores a late obsolete SVG', async () => {
    let resolve!: (svg: string) => void;
    vi.mocked(renderDiagram).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const r = render(<MermaidDiagram code="old" />);
    r.rerender(<MermaidDiagram code="new" />);
    await screen.findByTestId('mermaid-canvas');
    await act(async () => resolve('<svg><text>obsolete</text></svg>'));
    expect(screen.getByTestId('mermaid-canvas').textContent).not.toContain('obsolete');
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
    });
    await waitFor(() =>
      expect(renderDiagram).toHaveBeenLastCalledWith('new', { dark: true }, expect.any(Function)),
    );
  });
});
