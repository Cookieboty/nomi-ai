// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../src/components/Conversation/Markdown';
import { MermaidDiagram as ConversationDiagram } from '../src/components/Conversation/MermaidDiagram';
import { MermaidDiagram as PreviewDiagram } from '../src/components/ResourcePreview/MermaidDiagram';
import { PreviewMarkdown } from '../src/components/ResourcePreview/PreviewMarkdown';

const { renderDiagram, diagramTheme } = vi.hoisted(() => ({
  renderDiagram: vi.fn(),
  diagramTheme: () => ({ background: '#f5f5f5' }),
}));
vi.mock('../src/components/Conversation/mermaidRenderer', () => ({ renderDiagram, diagramTheme }));
vi.mock('../src/components/ResourcePreview/mermaidRenderer', () => ({
  renderDiagram,
  diagramTheme,
}));

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 1800 900" width="100%" style="max-width: 1800px"><style>#diagram text { fill: #222; }</style><text>开始 → 结束</text></svg>';
const text = '```mermaid\nflowchart LR\n A --> B\n```';
const fullImage = /查看大图|View full image/i;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe.each([
  {
    name: 'conversation',
    Diagram: ConversationDiagram,
    markdown: <Markdown text={text} settled />,
  },
  { name: 'file preview', Diagram: PreviewDiagram, markdown: <PreviewMarkdown text={text} /> },
])('Mermaid image preview in $name', ({ Diagram, markdown }) => {
  it('opens the global image dialog from Markdown and preserves SVG size, styles, background and Unicode', async () => {
    renderDiagram.mockResolvedValue(svg);
    const view = render(markdown);
    const canvas = await screen.findByTestId('mermaid-canvas');
    // 图在渲染完成后才带上 img 角色，大图弹窗也是懒加载的：都要等，不能同步取（Windows CI 上偶发失败）
    fireEvent.click(await within(canvas).findByRole('img'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(view.container.contains(dialog)).toBe(false);
    const image = within(dialog).getByRole('img') as HTMLImageElement;
    expect(image.alt).toMatch(/Mermaid/);
    expect(image.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const exported = new DOMParser()
      .parseFromString(decodeURIComponent(image.src.split(',')[1]), 'image/svg+xml')
      .querySelector('svg')!;
    expect(exported.getAttribute('viewBox')).toBe('0 0 1800 900');
    expect(exported.getAttribute('width')).toBe('1800');
    expect(exported.getAttribute('height')).toBe('900');
    expect(exported.style.maxWidth).toBe('none');
    expect(exported.style.backgroundColor).toBe('#f5f5f5');
    expect(exported.querySelector('style')?.textContent).toContain('#diagram text');
    expect(exported.textContent).toContain('开始 → 结束');
    expect(renderDiagram).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^(放大|Zoom in)$/i }));
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('125%');
    fireEvent.click(screen.getByTestId('image-lightbox-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('mermaid-canvas')).toBe(canvas);
  });

  it('opens from the toolbar or keyboard and restores focus after Escape', async () => {
    renderDiagram.mockResolvedValue(svg);
    render(<Diagram code="flowchart LR\nA --> B" />);
    const canvas = await screen.findByTestId('mermaid-canvas');
    const button = screen
      .getAllByRole('button', { name: fullImage })
      .find((element) => element.tagName === 'BUTTON')!;
    expect(button.getAttribute('title')).toBeNull();
    button.focus();
    fireEvent.click(button);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    for (const key of ['Enter', ' ']) {
      canvas.focus();
      fireEvent.keyDown(canvas, { key });
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(canvas);
    }
  });

  it('offers no image preview while loading, viewing source or after a render error', async () => {
    let finish!: (value: string) => void;
    renderDiagram.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Diagram code="flowchart LR\nA --> B" />);
    expect(screen.queryByRole('button', { name: fullImage })).toBeNull();
    finish(svg);
    await screen.findByTestId('mermaid-canvas');
    fireEvent.click(screen.getByRole('button', { name: /源码|Source/ }));
    expect(screen.getByTestId('mermaid-source')).toBeTruthy();
    expect(screen.queryByRole('button', { name: fullImage })).toBeNull();
    renderDiagram.mockRejectedValueOnce(new Error('syntax'));
    view.rerender(<Diagram code="bad diagram" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/源码|source/i));
    expect(screen.queryByRole('button', { name: fullImage })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismisses a stale diagram and does not reopen it when the original source returns', async () => {
    renderDiagram.mockResolvedValue(svg);
    const view = render(<Diagram code="flowchart LR\nA --> B" />);
    fireEvent.click(await screen.findByTestId('mermaid-canvas'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.rerender(<Diagram code="flowchart LR\nB --> C" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByTestId('mermaid-canvas');
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<Diagram code="flowchart LR\nA --> B" />);
    await screen.findByTestId('mermaid-canvas');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
