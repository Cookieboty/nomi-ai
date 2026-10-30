// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { nomiAdapter } from '../src/slash/adapters/nomi';
import { buildRegistry } from '../src/slash/registry';
import type { ModelArgOption, SlashBridge } from '../src/slash/types';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(() => {
  cleanup();
});

const options: ModelArgOption[] = [
  { value: 'opus', label: 'Opus 5.5', active: true },
  { value: 'fable', label: 'Fable 5.1', active: false },
  { value: 'amux/claude-sonnet', label: 'Amux / claude-sonnet', hint: '第三方', active: false },
];

function setup() {
  const run = vi.fn(async () => ({ handled: true }));
  const bridge: SlashBridge = {
    compose: (extra) => buildRegistry([...nomiAdapter({} as never), ...extra]),
    refresh: () => undefined,
    run,
    modelOptions: vi.fn(async () => options),
  };
  const r = render(<MessageInput slash={bridge} onSend={vi.fn()} />);
  return { r, run, ta: r.getByRole('textbox') as HTMLTextAreaElement };
}

describe('输入框里的 /model 补全', () => {
  it('敲空格列出模型、标出当前；Tab 补全模型名，再按 Enter 执行', async () => {
    const { r, run, ta } = setup();
    fireEvent.change(ta, { target: { value: '/model ' } });
    await waitFor(() => expect(r.getByTestId('slash-model-opus')).toBeTruthy());
    expect(r.getByTestId('slash-model-opus').textContent).toContain('当前');
    fireEvent.change(ta, { target: { value: '/model so' } });
    // 「供应商/模型」里模型名的前缀也能命中
    await waitFor(() =>
      expect(r.getAllByRole('menuitem').map((b) => b.dataset.testid)).toEqual([
        'slash-model-amux/claude-sonnet',
      ]),
    );
    fireEvent.change(ta, { target: { value: '/model f' } });
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('/model fable');
    expect(r.queryByTestId('slash-model-menu')).toBeTruthy();
    // 已敲全：Enter 直接执行命令
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledWith('/model fable', expect.any(Array)));
  });

  it('↑↓ 选择、点击选用；Esc 关闭列表', async () => {
    const { r, ta } = setup();
    fireEvent.change(ta, { target: { value: '/model ' } });
    await waitFor(() => expect(r.getByTestId('slash-model-menu')).toBeTruthy());
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('/model fable');
    fireEvent.change(ta, { target: { value: '/model ' } });
    await waitFor(() => expect(r.getByTestId('slash-model-opus')).toBeTruthy());
    fireEvent.click(r.getByTestId('slash-model-amux/claude-sonnet'));
    expect(ta.value).toBe('/model amux/claude-sonnet');
    fireEvent.change(ta, { target: { value: '/model x' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(r.queryByTestId('slash-model-menu')).toBeNull();
  });
});
