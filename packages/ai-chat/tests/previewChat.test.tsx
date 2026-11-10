// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setChatMode } from '../src/services/chatPrefs';
import { harnessClient } from '../src/services/harnessClient';

vi.mock('../src/services/projects', () => ({
  useProjects: () => [],
  projectById: (id?: string) => (id ? { id, primary: id, folders: [] } : undefined),
}));

import { previewChatFixture } from './fixtures/previewChatFixture';

beforeAll(async () => {
  await import('../src/components/ResourcePreview/ResourcePreview');
});
let fixture: ReturnType<typeof previewChatFixture>;
beforeEach(() => {
  setChatMode('normal');
  vi.spyOn(harnessClient, 'available').mockReturnValue(false);
  fixture = previewChatFixture();
});
afterEach(() => {
  cleanup();
  fixture.restore();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function open() {
  render(<fixture.App />);
  fireEvent.click(screen.getByTestId('fixture-open'));
  await screen.findByTestId('preview-markdown');
  fireEvent.keyDown(screen.getByTestId('resource-preview-splitter'), { key: 'End' });
  // 文档全屏时对话默认收成右下角的按钮，点开才是输入框
  fireEvent.click(await screen.findByTestId('preview-chat-pill'));
  await screen.findByTestId('preview-chat-header');
}
describe('preview focus chat window', () => {
  it('uses the same conversation and input nodes across collapse, expansion and returning to side preview', async () => {
    await open();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    const conversation = screen.getByTestId('conversation');
    fireEvent.change(input, { target: { value: '保留输入草稿' } });
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    expect(conversation.querySelector('table')).not.toBeNull();
    expect(conversation.querySelector('pre')).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(false);
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /收为右侧预览|Collapse to side preview/ }));
    expect(screen.getByTestId('conversation')).toBe(conversation);
    expect(screen.getByTestId('chat-input')).toBe(input);
    expect(input.value).toBe('保留输入草稿');
    expect(screen.queryByTestId('preview-chat-header')).toBeNull();
  });
  it('keeps the minimal composer to one line by default and hides secondary controls', async () => {
    await open();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.style.height).toBe('24px');
    expect(input.parentElement?.hasAttribute('data-compact')).toBe(true);
    expect(screen.queryByTestId('context-usage-bar')).toBeNull();
    expect(screen.queryByTestId('voice-mic')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /收为右侧预览|Collapse to side preview/ }));
    expect(screen.getByTestId('context-usage-bar')).toBeTruthy();
  });
  it('adds an absolute source-line reference from the paragraph menu without sending or replacing the draft', async () => {
    await open();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '解释一下这部分' } });
    const paragraph = within(screen.getByTestId('preview-markdown')).getByText(
      '此文档在切换会话时保持打开。',
    );
    fireEvent.contextMenu(paragraph, { clientX: 80, clientY: 100 });
    expect(screen.getByTestId('preview-selection-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-selection-ask'));
    await screen.findByRole('link', { name: 'design.md:3-3' });
    expect(input.value).toBe('解释一下这部分');
    expect(input.value).not.toContain('此文档在切换会话');
    expect(fixture.sent).toHaveLength(0);
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(fixture.sent).toHaveLength(1));
    expect(fixture.sent[0]?.text).toContain('[design.md:3-3](/work/design.md:3-3)');
    expect(fixture.sent[0]?.text).toContain('解释一下这部分');
  });
  it('keeps rendered file references with their own chat drafts during selection changes', async () => {
    await open();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '带引用的提问' } });
    fireEvent.contextMenu(
      within(screen.getByTestId('preview-markdown')).getByText('此文档在切换会话时保持打开。'),
    );
    fireEvent.click(screen.getByTestId('preview-selection-ask'));
    await screen.findByRole('link', { name: 'design.md:3-3' });
    const choose = async (id: string) => {
      fireEvent.click(screen.getByTestId('preview-chat-select'));
      fireEvent.click(
        within(screen.getByTestId('preview-chat-menu'))
          .getAllByRole('menuitemradio')
          .find((row) => row.getAttribute('data-conversation-id') === id)!,
      );
      await waitFor(() => expect(fixture.state.get().viewConvoId).toBe(id));
    };
    await choose(fixture.other.id);
    expect(screen.queryByRole('link', { name: 'design.md:3-3' })).toBeNull();
    await choose(fixture.source.id);
    await screen.findByRole('link', { name: 'design.md:3-3' });
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('带引用的提问');
  });
  it('closes the paragraph menu before the chat when Escape comes from elsewhere', async () => {
    await open();
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    fireEvent.contextMenu(
      within(screen.getByTestId('preview-markdown')).getByText('此文档在切换会话时保持打开。'),
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('preview-selection-menu')).toBeNull();
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
  });
  it('selects another chat, keeps the origin document and authorizes sending only to that selection', async () => {
    await open();
    const document = screen.getByTestId('preview-markdown');
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    const menu = screen.getByTestId('preview-chat-menu');
    fireEvent.change(within(menu).getByRole('textbox'), { target: { value: '另一个' } });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitemradio'));
    await waitFor(() => expect(fixture.state.get().viewConvoId).toBe(fixture.other.id));
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('preview-markdown')).toBe(document);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '发给所选会话' } });
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() =>
      expect(fixture.sent).toContainEqual({ id: fixture.other.id, text: '发给所选会话' }),
    );
  });
  it('forks with context while retaining the preview and the original conversation draft', async () => {
    await open();
    const originalMessages = [...fixture.conversations.getMessages(fixture.source.id)];
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '原会话的草稿' } });
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    fireEvent.click(screen.getByTestId('preview-chat-fork'));
    await waitFor(() => expect(fixture.conversations.list()).toHaveLength(3));
    const branch = fixture.conversations
      .list()
      .find((item) => item.id !== fixture.source.id && item.id !== fixture.other.id)!;
    await waitFor(() => expect(fixture.state.get().viewConvoId).toBe(branch.id));
    expect(fixture.conversations.getMessages(branch.id).map((m) => m.content)).toEqual(
      originalMessages.map((m) => m.content),
    );
    expect(fixture.conversations.getMessages(fixture.source.id)).toEqual(originalMessages);
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    fireEvent.click(
      within(screen.getByTestId('preview-chat-menu'))
        .getAllByRole('menuitemradio')
        .find((item) => item.getAttribute('data-conversation-id') === fixture.source.id)!,
    );
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('原会话的草稿'),
    );
  });
  it('dismisses the menu with Escape before collapsing the chat or closing the document', async () => {
    await open();
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    fireEvent.keyDown(within(screen.getByTestId('preview-chat-menu')).getByRole('textbox'), {
      key: 'Escape',
    });
    expect(screen.queryByTestId('preview-chat-menu')).toBeNull();
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
  });
  it('keeps live frames flowing through the main renderer while chat content is collapsed', async () => {
    await open();
    const conversation = screen.getByTestId('conversation');
    act(() =>
      fixture.state.set({
        ...fixture.state.get(),
        messages: [
          ...fixture.state.get().messages.slice(0, -1),
          { ...fixture.state.get().messages.at(-1)!, content: '流式追加内容' },
        ],
      }),
    );
    expect(screen.getByTestId('conversation')).toBe(conversation);
    expect(conversation.textContent).toContain('流式追加内容');
  });
  it('keeps unrelated session changes disabled until that chat is explicitly selected', async () => {
    await open();
    const document = screen.getByTestId('preview-markdown');
    await act(async () => {
      fixture.conversations.switchTo(fixture.other.id);
      fixture.state.set({
        ...fixture.state.get(),
        viewConvoId: fixture.other.id,
        messages: fixture.conversations.getMessages(fixture.other.id),
      });
    });
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    fireEvent.click(
      within(screen.getByTestId('preview-chat-menu'))
        .getAllByRole('menuitemradio')
        .find((item) => item.getAttribute('data-conversation-id') === fixture.other.id)!,
    );
    await waitFor(() =>
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('preview-markdown')).toBe(document);
    expect(screen.getByTestId('resource-preview').textContent).toMatch(/消息将发送|Messages go/);
  });
  it('moves the floating column with keys and restores its position when dragging is cancelled', async () => {
    await open();
    const column = screen.getByTestId('chat-column');
    const host = screen.getByTestId('preview-chat-host');
    const box = (x: number, y: number, width: number, height: number) => ({
      x,
      y,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON: () => ({}),
    });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(box(0, 0, 1000, 800));
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(box(200, 500, 600, 150));
    const handle = screen.getByTestId('preview-chat-drag');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(column.style.getPropertyValue('--preview-chat-x')).toBe('-16px');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 780, clientY: 520 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 700, clientY: 420 });
    expect(column.style.getPropertyValue('--preview-chat-y')).toBe('-100px');
    fireEvent.pointerCancel(window, { pointerId: 3 });
    expect(column.style.getPropertyValue('--preview-chat-x')).toBe('-16px');
    expect(column.style.getPropertyValue('--preview-chat-y')).toBe('0px');
  });
  it('only lists the document workspace, including normalized paths but excluding children and unset workspaces', async () => {
    const elsewhere = fixture.conversations.create({
      name: 'Other workspace',
      projectId: '/elsewhere',
      backend: 'nomi',
    });
    fixture.conversations.create({
      name: 'Nested workspace',
      projectId: '/work/child',
      backend: 'nomi',
    });
    fixture.conversations.create({ name: 'No workspace', backend: 'nomi' });
    fixture.conversations.switchTo(fixture.source.id);
    await open();
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    const ids = within(screen.getByTestId('preview-chat-menu'))
      .getAllByRole('menuitemradio')
      .map((row) => row.getAttribute('data-conversation-id'));
    expect(ids.sort()).toEqual([fixture.source.id, fixture.other.id].sort());
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {
      fixture.conversations.switchTo(elsewhere.id);
      fixture.state.set({ ...fixture.state.get(), viewConvoId: elsewhere.id, messages: [] });
    });
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    const anchored = within(screen.getByTestId('preview-chat-menu')).getAllByRole('menuitemradio');
    expect(anchored.map((row) => row.getAttribute('data-conversation-id')).sort()).toEqual(
      ids.sort(),
    );
    expect((screen.getByTestId('preview-chat-fork') as HTMLButtonElement).disabled).toBe(true);
  });
  it('collapses on outside pointer clicks without losing the draft or intercepting the document', async () => {
    await open();
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '继续编辑的草稿' } });
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    fireEvent.pointerDown(input, { button: 0 });
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    const menu = screen.getByTestId('preview-chat-menu');
    fireEvent.pointerDown(within(menu).getByRole('textbox'), { button: 0 });
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    expect(screen.getByTestId('preview-chat-menu')).toBe(menu);
    const outside = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      screen.getByTestId('preview-markdown').dispatchEvent(outside);
    });
    expect(outside.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('preview-chat-menu')).toBeNull();
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(false);
    expect(screen.getByTestId('chat-input')).toBe(input);
    expect(input.value).toBe('继续编辑的草稿');
  });
  it('dismisses one layer per Escape even when focus is outside the floating chat', async () => {
    await open();
    fireEvent.click(screen.getByTestId('preview-chat-toggle'));
    fireEvent.click(screen.getByTestId('preview-chat-select'));
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(screen.getByTestId('preview-chat-menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    expect(screen.getByTestId('preview-chat-menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('preview-chat-menu')).toBeNull();
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(true);
    fireEvent.keyDown(screen.getByTestId('preview-markdown'), { key: 'Escape' });
    expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-open')).toBe(false);
    expect(screen.getByTestId('preview-chat-header')).toBeTruthy();
    // 输入框 → 右下角按钮 → 退出全屏 → 关闭文档
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('preview-chat-header')).toBeNull();
    expect(screen.getByTestId('preview-chat-pill')).toBeTruthy();
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('preview-chat-pill')).toBeNull();
    expect(screen.getByTestId('preview-markdown')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('resource-preview')).toBeNull());
  });

  it('starts as a bottom-right button; opening keeps the same composer', async () => {
    render(<fixture.App />);
    fireEvent.click(screen.getByTestId('fixture-open'));
    await screen.findByTestId('preview-markdown');
    fireEvent.keyDown(screen.getByTestId('resource-preview-splitter'), { key: 'End' });
    const pill = await screen.findByTestId('preview-chat-pill');
    const column = screen.getByTestId('chat-column');
    expect(column.hasAttribute('data-preview-chat-min')).toBe(true);
    expect(screen.queryByTestId('preview-chat-header')).toBeNull();
    // 输入框还挂着（藏起来），草稿不丢
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.click(pill);
    expect(column.hasAttribute('data-preview-chat-min')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: '草稿' } });
    // 有草稿时点文档不收起；收成按钮后草稿还在
    fireEvent.pointerDown(screen.getByTestId('preview-markdown'), { button: 0 });
    expect(column.hasAttribute('data-preview-chat-min')).toBe(false);
    fireEvent.click(screen.getByTestId('preview-chat-minimize'));
    expect(column.hasAttribute('data-preview-chat-min')).toBe(true);
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('草稿');
    // 空草稿时点文档收成按钮
    fireEvent.click(screen.getByTestId('preview-chat-pill'));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.pointerDown(screen.getByTestId('preview-markdown'), { button: 0 });
    expect(column.hasAttribute('data-preview-chat-min')).toBe(true);
  });

  it('opens the selection menu after selecting text and asks in the opened chat', async () => {
    render(<fixture.App />);
    fireEvent.click(screen.getByTestId('fixture-open'));
    const doc = await screen.findByTestId('preview-markdown');
    fireEvent.keyDown(screen.getByTestId('resource-preview-splitter'), { key: 'End' });
    await screen.findByTestId('preview-chat-pill');
    const paragraph = doc.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph, { button: 0, clientX: 40, clientY: 40 });
    const menu = await screen.findByTestId('preview-selection-menu');
    // 选中弹出的菜单不抢焦点，继续打字就收起
    expect(menu.contains(document.activeElement)).toBe(false);
    fireEvent.click(screen.getByTestId('preview-selection-ask'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-column').hasAttribute('data-preview-chat-min')).toBe(false),
    );
    // 引用作为链接出现在展开的输入框上方
    await screen.findByRole('link', { name: /^design\.md:\d+-\d+$/ });
  });

  it('a click without a selection does not open the menu', async () => {
    render(<fixture.App />);
    fireEvent.click(screen.getByTestId('fixture-open'));
    const doc = await screen.findByTestId('preview-markdown');
    window.getSelection()!.removeAllRanges();
    fireEvent.mouseUp(doc.querySelector('p')!, { button: 0, clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('preview-selection-menu')).toBeNull();
  });
});
