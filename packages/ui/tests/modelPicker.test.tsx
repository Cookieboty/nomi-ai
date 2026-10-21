import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatContext, ModelPicker, splitModelRef, type PickerProvider } from '../src';

afterEach(cleanup);

const providers: PickerProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-pro', ctx: 128_000, reasoning: true, wire: 'Anthropic' },
      { id: 'deepseek-embed', toolCalling: false },
    ],
  },
  {
    id: 'relay',
    name: 'Relay',
    models: [
      { id: 'vendor/model-x', ctx: 1_000_000, vision: true },
      { id: 'mystery', metaKnown: false },
    ],
  },
];

function Harness(
  p: Partial<React.ComponentProps<typeof ModelPicker>> & { onPick?: (v: string) => void },
) {
  const [v, setV] = useState<string | null>(p.value ?? 'deepseek/deepseek-v4-pro');
  return (
    <ModelPicker
      providers={providers}
      {...p}
      value={v}
      onChange={(x) => {
        setV(x);
        p.onPick?.(x);
      }}
    />
  );
}

const optionTexts = () => screen.getAllByRole('option').map((o) => o.textContent ?? '');

describe('ModelPicker', () => {
  it('shows "provider / model" on the trigger and groups models by provider with capabilities', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('DeepSeek / deepseek-v4-pro');
    fireEvent.click(trigger);
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('Relay')).toBeTruthy();
    const texts = optionTexts();
    expect(texts.find((x) => x.includes('deepseek-v4-pro'))).toContain('128K');
    expect(texts.find((x) => x.includes('vendor/model-x'))).toContain('1M');
    // 协议标签默认不显示
    expect(texts.join('|')).not.toContain('Anthropic');
  });

  it('for coding assistants hides models without tool calling and flags unknown limits', () => {
    render(<Harness purpose="coding" />);
    fireEvent.click(screen.getByRole('combobox'));
    const texts = optionTexts();
    expect(texts.some((x) => x.includes('deepseek-embed'))).toBe(false);
    expect(texts.find((x) => x.includes('mystery'))).toContain('参数未知');
  });

  it('puts recent models first, filters by provider/ prefix, and returns provider/model refs', () => {
    const onPick = vi.fn();
    render(<Harness recent={['relay/vendor/model-x', 'gone/model']} onPick={onPick} showWire />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('最近使用')).toBeTruthy();
    expect(optionTexts()[0]).toContain('Relay / vendor/model-x');
    expect(optionTexts().join('|')).toContain('Anthropic');
    const search = document.querySelector('.cd-dropdown__menu input') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'relay/' } });
    expect(optionTexts().every((x) => !x.includes('deepseek'))).toBe(true);
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('mystery'))!);
    expect(onPick).toHaveBeenCalledWith('relay/mystery');
  });

  it('special options (e.g. "same as chat") come first and keep their own value', () => {
    render(<Harness value="follow" extraOptions={[{ value: 'follow', label: '跟随对话' }]} />);
    expect(screen.getByRole('combobox').textContent).toContain('跟随对话');
    fireEvent.click(screen.getByRole('combobox'));
    expect(optionTexts()[0]).toContain('跟随对话');
  });

  it('helpers', () => {
    expect(formatContext(128_000)).toBe('128K');
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(1_500_000)).toBe('1.5M');
    expect(splitModelRef('relay/vendor/model-x')).toEqual({
      provider: 'relay',
      model: 'vendor/model-x',
    });
    expect(splitModelRef('follow')).toBeNull();
  });
});
