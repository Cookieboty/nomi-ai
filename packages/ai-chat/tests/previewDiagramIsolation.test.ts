// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

import { renderDiagram as renderConversation } from '../src/components/Conversation/mermaidRenderer';
import {
  diagramConfig,
  renderDiagram as renderPreview,
  sanitizeDiagram,
} from '../src/components/ResourcePreview/mermaidRenderer';

const { initialize, render } = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize, render } }));
const theme = {
  background: '#fff',
  surface: '#eee',
  text: '#222',
  muted: '#777',
  border: '#aaa',
  accent: '#00f',
  font: 'sans-serif',
  dark: false,
};
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>example</text></svg>';

it('serializes the third-party engine across independent renderers and namespaces SVG IDs', async () => {
  let finish!: (value: { svg: string }) => void;
  render
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ svg });
  const first = renderConversation('flowchart LR\nA --> B', theme);
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  const second = renderPreview('flowchart LR\nB --> C', { ...theme, dark: true });
  await Promise.resolve();
  expect(initialize).toHaveBeenCalledTimes(1);
  finish({ svg });
  await Promise.all([first, second]);
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(render.mock.calls[0]?.[0]).toMatch(/^nomi-diagram-/);
  expect(render.mock.calls[1]?.[0]).toMatch(/^nomi-preview-diagram-/);
  expect(render.mock.calls[0]?.[2].isConnected).toBe(false);
  expect(render.mock.calls[1]?.[2].isConnected).toBe(false);
});

it('retains the preview-owned SVG and source security boundary', async () => {
  expect(diagramConfig(theme).securityLevel).toBe('strict');
  await expect(
    renderPreview('---\nconfig:\n securityLevel: loose\n---\nflowchart LR', theme),
  ).rejects.toThrow();
  await expect(renderPreview('x'.repeat(50_001), theme)).rejects.toThrow();
  const clean = await sanitizeDiagram(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><a href="https://evil.test"><text>link</text></a><path marker-end="url(#arrow)"/></svg>',
  );
  expect(clean).not.toMatch(/onload|script|href|<a\s/);
  expect(clean).toContain('url(#arrow)');
});
