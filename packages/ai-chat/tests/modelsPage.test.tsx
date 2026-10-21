// @vitest-environment happy-dom
/**
 * 「模型」页原型（M1.5，假数据）：分配区、编程助手行、添加第三方供应商的三步流程。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsPage } from '../src/components/ModelsPage';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dialog = () => screen.getByTestId('add-provider-dialog');

function addFlow(presetId: string, key: string) {
  fireEvent.click(screen.getByTestId('add-provider'));
  fireEvent.click(within(dialog()).getByTestId(`preset-${presetId}`));
  fireEvent.change(within(dialog()).getByTestId('add-provider-keys'), { target: { value: key } });
  fireEvent.click(within(dialog()).getByTestId('add-provider-probe'));
}

describe('ModelsPage prototype', () => {
  it('shows assignments, one row per coding assistant, and the provider list', () => {
    render(<ModelsPage />);
    expect(screen.getByTestId('assign-chat').closest('div')?.textContent).toContain(
      'DeepSeek / deepseek-v4-pro',
    );
    for (const id of ['claude', 'codex', 'gemini', 'grok', 'dsh'])
      expect(screen.getByTestId(`cli-row-${id}`)).toBeTruthy();
    // 没安装的编程助手：变灰并给出安装按钮
    expect(within(screen.getByTestId('cli-row-dsh')).getByText('安装')).toBeTruthy();
    // 环境变量提供的供应商只读显示
    expect(
      within(screen.getByTestId('provider-env-openrouter')).getByText('环境变量'),
    ).toBeTruthy();
  });

  it('add provider: pick a preset, paste keys, detection runs and saving adds it', () => {
    render(<ModelsPage />);
    addFlow('zhipu', 'sk-aaaa1111\nsk-bbbb2222');
    const save = within(dialog()).getByTestId('add-provider-save') as HTMLButtonElement;
    // 探测还没全部返回时不能保存
    expect(save.disabled).toBe(true);
    act(() => void vi.advanceTimersByTime(3000));
    const result = within(dialog()).getByTestId('add-provider-probe-result');
    expect(result.textContent).toContain('Anthropic');
    // 预设没有的协议只是跳过（灰色），不算失败
    expect(result.querySelectorAll('[data-state="skip"]')).toHaveLength(2);
    expect(result.querySelectorAll('[data-state="fail"]')).toHaveLength(0);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(screen.queryByTestId('add-provider-dialog')).toBeNull();
    const row = screen.getAllByText('智谱 GLM')[0]!.closest('[data-testid^="provider-"]')!;
    expect(row.textContent).toContain('2 个 Key');
  });

  it('cannot save when every API fails, and says why', () => {
    render(<ModelsPage />);
    addFlow('deepseek', 'sk-bad-key');
    act(() => void vi.advanceTimersByTime(3000));
    expect(within(dialog()).getByTestId('add-provider-probe-result').textContent).toContain(
      'Key 无效（401）',
    );
    expect((within(dialog()).getByTestId('add-provider-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      within(dialog()).getByText('所有协议都不可用，不能保存。请检查上面每一条的原因。'),
    ).toBeTruthy();
  });

  it('custom address needs an address before detection; local presets need no key', () => {
    render(<ModelsPage />);
    fireEvent.click(screen.getByTestId('add-provider'));
    fireEvent.click(within(dialog()).getByTestId('preset-custom'));
    fireEvent.change(within(dialog()).getByTestId('add-provider-keys'), {
      target: { value: 'sk-1234' },
    });
    const probe = within(dialog()).getByTestId('add-provider-probe') as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByTestId('add-provider-url'), {
      target: { value: 'https://relay.example.com/v1/chat/completions' },
    });
    expect(probe.disabled).toBe(false);
    fireEvent.click(within(dialog()).getByTestId('add-provider-back'));
    fireEvent.click(within(dialog()).getByTestId('preset-ollama'));
    expect(within(dialog()).getByText('本地服务不需要 Key。')).toBeTruthy();
    expect((within(dialog()).getByTestId('add-provider-probe') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
