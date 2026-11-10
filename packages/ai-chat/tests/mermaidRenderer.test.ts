// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import {
  diagramConfig,
  renderDiagram,
  sanitizeDiagram,
  type DiagramTheme,
} from '../src/components/Conversation/mermaidRenderer';

const { initialize, renderSvg } = vi.hoisted(() => ({
  initialize: vi.fn(),
  renderSvg: vi.fn(async (_id: string, _code: string, _container: HTMLElement) => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
  })),
}));
vi.mock('mermaid', () => ({ default: { initialize, render: renderSvg } }));
const theme: DiagramTheme = {
  background: '#101010',
  surface: '#202020',
  text: '#f2f2f2',
  muted: '#aaa',
  border: '#555',
  accent: '#ff8800',
  font: 'sans-serif',
  dark: true,
};

describe('Mermaid renderer security boundary', () => {
  it('protects security configuration and maps theme tokens, not a fixed white theme', () => {
    const config = diagramConfig(theme);
    expect(config.securityLevel).toBe('strict');
    expect(config.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.themeVariables?.primaryTextColor).toBe(theme.text);
    expect(config.themeVariables?.primaryColor).toBe(theme.surface);
    expect(config.secure).toContain('securityLevel');
  });
  it('strips init directives and cleans temporary render DOM', async () => {
    await renderDiagram('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA --> B', theme);
    expect(renderSvg).toHaveBeenCalledWith(
      expect.any(String),
      '\nflowchart LR\nA --> B',
      expect.any(HTMLElement),
    );
    const container = renderSvg.mock.calls.at(-1)?.[2] as unknown as HTMLElement;
    expect(container.isConnected).toBe(false);
  });
  it('serializes theme initialization/rendering across diagrams and skips cancelled jobs', async () => {
    initialize.mockClear();
    renderSvg.mockClear();
    await Promise.all([
      renderDiagram('flowchart LR\nA --> B', theme),
      renderDiagram('flowchart LR\nB --> C', { ...theme, text: '#000' }),
    ]);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(initialize.mock.invocationCallOrder[0]).toBeLessThan(
      renderSvg.mock.invocationCallOrder[0]!,
    );
    expect(renderSvg.mock.invocationCallOrder[0]).toBeLessThan(
      initialize.mock.invocationCallOrder[1]!,
    );
    await renderDiagram('flowchart LR\nA --> B', theme, () => true);
    expect(renderSvg).toHaveBeenCalledTimes(2);
  });
  it('rejects overlarge graphs, config frontmatter and remote-image syntax before rendering', async () => {
    const count = renderSvg.mock.calls.length;
    for (const code of [
      'x'.repeat(50_001),
      '---\nconfig:\n securityLevel: loose\n---\nflowchart LR',
      'flowchart LR\nA@{ img: "https://evil.test/image" }',
      'flowchart LR\nA["![image](https://evil.test/img)"]',
    ]) {
      await expect(renderDiagram(code, theme)).rejects.toThrow();
    }
    expect(renderSvg.mock.calls.length).toBe(count);
  });
  it('sanitizes SVG executable HTML, links, images and external CSS while preserving local markers', async () => {
    const clean = await sanitizeDiagram(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><image href="https://evil.test"/><a href="javascript:alert(1)"><text>unsafe link</text></a><path style="fill:url(https://evil.test);stroke:red" marker-end="url(#arrow)"/><style>@import url(https://evil.test); .a { fill:url(https://evil.test) }</style></svg>',
    );
    expect(clean).not.toMatch(/onload|script|foreignObject|iframe|<image|<a\s|href|https:\/\/evil/);
    expect(clean).toContain('url(#arrow)');
  });
});
