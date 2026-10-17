// @vitest-environment happy-dom
import { ENDPOINT_GLYPHS } from '@nomi-ai/ui';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EndpointIcon } from '../src/components/EndpointIcon';
import { CONVERSATION_BACKENDS } from '../src/types/chat';

afterEach(() => cleanup());

describe('EndpointIcon', () => {
  it('renders an accessible icon with the endpoint name for every endpoint', () => {
    for (const b of CONVERSATION_BACKENDS) {
      const r = render(<EndpointIcon backend={b} />);
      const icon = r.getByTestId(`endpoint-icon-${b}`);
      const name = {
        nomi: 'Nomi',
        claude: 'Claude Code',
        codex: 'Codex',
        dsh: 'dsh',
        grok: 'Grok',
      }[b];
      expect(icon.getAttribute('role')).toBe('img');
      expect(icon.getAttribute('aria-label')).toBe(name);
      expect(icon.querySelector('title')?.textContent).toBe(name);
      cleanup();
    }
  });

  it('decorative icons are hidden from assistive tech', () => {
    const r = render(<EndpointIcon backend="codex" decorative />);
    const icon = r.getByTestId('endpoint-icon-codex');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('aria-label')).toBeNull();
  });

  it('uses the real brand marks: Nomi app mark, OpenAI for Codex, DeepSeek whale for dsh', () => {
    // Nomi: cream app-icon tile with the brand N mark colours
    expect(ENDPOINT_GLYPHS.nomi.tile).toBe('#FCEFE1');
    expect(ENDPOINT_GLYPHS.nomi.paths.map((p) => p.stroke ?? p.fill)).toEqual([
      '#F7A67C',
      '#33291F',
      '#FB9466',
    ]);
    // Codex: OpenAI blossom path (starts "M9.205 8.658"), white on black
    expect(ENDPOINT_GLYPHS.codex.paths[0]!.d.startsWith('M9.205 8.658')).toBe(true);
    expect(ENDPOINT_GLYPHS.codex.paths[0]!.fill).toBe('#fff');
    // dsh: DeepSeek whale, brand blue
    expect(ENDPOINT_GLYPHS.dsh.paths[0]!.d.startsWith('M23.748 4.482')).toBe(true);
    expect(ENDPOINT_GLYPHS.dsh.paths[0]!.fill).toBe('#4D6BFE');
    // Claude Code keeps its coral asterisk
    expect(ENDPOINT_GLYPHS.claude.tile).toBe('#d97757');
    const r = render(<EndpointIcon backend="codex" />);
    expect(r.getByTestId('endpoint-icon-codex').querySelectorAll('path')).toHaveLength(1);
  });
});
