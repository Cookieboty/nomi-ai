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
        gemini: 'Gemini',
        kimi: 'Kimi Code',
        minimax: 'MiniMax Code',
      }[b];
      expect(icon.getAttribute('role')).toBe('img');
      expect(icon.getAttribute('aria-label')).toBe(name);
      cleanup();
    }
  });

  it('decorative icons are hidden from assistive tech', () => {
    const r = render(<EndpointIcon backend="codex" decorative />);
    const icon = r.getByTestId('endpoint-icon-codex');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('aria-label')).toBeNull();
  });

  it.each(CONVERSATION_BACKENDS)(
    'renders %s transparently without white-only artwork',
    (backend) => {
      const r = render(<EndpointIcon backend={backend} variant="mark" />);
      const icon = r.getByTestId(`endpoint-icon-${backend}`);
      expect(icon.querySelector('rect')).toBeNull();
      expect(icon.getAttribute('aria-label')).toBeTruthy();
      for (const path of icon.querySelectorAll('path')) {
        expect(path.getAttribute('fill')).not.toBe('#fff');
        expect(path.getAttribute('stroke')).not.toBe('#fff');
      }
    },
  );

  it('uses product marks for agents, and preserves the original Nomi app mark', () => {
    // Nomi: cream app-icon tile with the brand N mark colours
    expect(ENDPOINT_GLYPHS.nomi.tile).toBe('#FCEFE1');
    expect(ENDPOINT_GLYPHS.nomi.paths.map((p) => p.stroke ?? p.fill)).toEqual([
      '#F7A67C',
      '#33291F',
      '#FB9466',
    ]);
    const productMarks = {
      claude: 'claudecode',
      codex: 'codex-color',
      dsh: 'deepseek',
      grok: 'grok',
      gemini: 'gemini',
      kimi: 'kimi',
      minimax: 'minimax',
    } as const;
    for (const [endpoint, brand] of Object.entries(productMarks)) {
      const r = render(<EndpointIcon backend={endpoint as keyof typeof productMarks} />);
      const icon = r.getByTestId(`endpoint-icon-${endpoint}`);
      expect(icon.querySelector(`[data-brand="${brand}"].cd-brand--inline`)).toBeTruthy();
      expect(icon.querySelector('.cd-brand__glyph')).toBeTruthy();
      cleanup();
    }
  });
});
