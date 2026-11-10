// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

import { untilIdle } from './helpers/fakeApi';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));
vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { open: vi.fn(), web: vi.fn(), close: vi.fn(async () => undefined) },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const sent = vi.fn();
function Probe() {
  const { style, className, value, composerRef, isOpen, expanded, panel } = useResourcePreview({
    id: 'cli:a',
    cwd: '/work',
  });
  return (
    <div data-testid="preview-host" style={style} className={`main-content ${className}`}>
      <div className="chat-column">
        <button onClick={() => value.open('/work/doc.md', value.scope)}>open</button>
        <footer className="input-container" ref={composerRef}>
          <MessageInput compact={isOpen && expanded} onSend={sent} />
        </footer>
      </div>
      {panel}
    </div>
  );
}
async function openPreview() {
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    kind: 'markdown',
    content: '# Document\n\nbody',
    path: '/work/doc.md',
  });
  const r = render(<Probe />);
  fireEvent.click(screen.getByText('open'));
  await untilIdle();
  await screen.findByTestId('preview-markdown');
  return r;
}
function mockBounds() {
  const host = screen.getByTestId('preview-host');
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 1100,
    width: 1000,
    top: 0,
    bottom: 800,
    height: 800,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
  return host;
}
const width = () =>
  screen.getByTestId('preview-host').style.getPropertyValue('--resource-preview-width');
const compact = () => !!screen.getByTestId('chat-input').closest('[data-compact="true"]');

describe('Codex-style preview layout', () => {
  it('defaults to half-width side view with normal composer; expanding preserves draft and input node', async () => {
    await openPreview();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'draft stays here' } });
    expect(width()).toBe('50%');
    expect(compact()).toBe(false);
    expect(screen.queryByTestId('preview-outline')).toBeNull();
    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(width()).toBe('100%');
    expect(compact()).toBe(true);
    expect(screen.getByTestId('preview-outline')).not.toBeNull();
    expect(screen.getByTestId('chat-input')).toBe(input);
    expect(input.value).toBe('draft stays here');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(width()).toBe('50%');
    expect(compact()).toBe(false);
    expect(input.value).toBe('draft stays here');
  });
  it('drags both ways and only compacts when snapped to full width', async () => {
    await openPreview();
    mockBounds();
    const separator = screen.getByRole('separator');
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
    expect(width()).toBe('70%');
    expect(compact()).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120 });
    expect(width()).toBe('100%');
    expect(compact()).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 500 });
    expect(width()).toBe('60%');
    expect(compact()).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200 });
    expect(width()).toBe('60%');
  });
  it('restores the prior split width on drag cancellation and on collapse, resets after closing', async () => {
    await openPreview();
    mockBounds();
    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('55');
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 550 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120 });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(separator.getAttribute('aria-valuenow')).toBe('55');
    fireEvent.keyDown(separator, { key: 'End' });
    fireEvent.click(screen.getByRole('button', { name: /收为右侧预览|Collapse to side preview/ }));
    expect(separator.getAttribute('aria-valuenow')).toBe('55');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByText('open'));
    await untilIdle();
    expect(width()).toBe('50%');
  });
  it('continues sending in side and expanded modes without closing the preview', async () => {
    await openPreview();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'side send' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toHaveBeenCalledWith('side send');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    fireEvent.change(input, { target: { value: 'expanded send' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toHaveBeenCalledWith('expanded send');
    expect(screen.getByTestId('resource-preview')).not.toBeNull();
  });
});
