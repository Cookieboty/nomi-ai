import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
/** 悬停某一行，等自绘提示出现（完整名称 + 能力说明），返回提示文字 */
async function tipOf(name: string): Promise<string> {
  const row = screen.getAllByRole('option').find((o) => o.textContent?.includes(name))!;
  fireEvent.mouseMove(row);
  const tip = await screen.findByRole('tooltip');
  expect(row.getAttribute('aria-describedby')).toBe(tip.id);
  const text = tip.textContent ?? '';
  fireEvent.mouseLeave(screen.getByRole('listbox'));
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return text;
}

describe('ModelPicker', () => {
  it('shows "provider / model" on the trigger, groups by provider, capabilities only on hover', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('DeepSeek / deepseek-v4-pro');
    fireEvent.click(trigger);
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('Relay')).toBeTruthy();
    const texts = optionTexts();
    // 不用系统 title，改用自绘提示
    expect(screen.getAllByRole('option').every((o) => !o.hasAttribute('title'))).toBe(true);
    expect(await tipOf('deepseek-v4-pro')).toContain('128K');
    expect(await tipOf('vendor/model-x')).toContain('1M');
    // 能力说明不占选项行（避免模型名被截断）
    expect(texts.find((x) => x.includes('deepseek-v4-pro'))).not.toContain('128K');
    // 协议标签默认不显示
    expect(texts.join('|')).not.toContain('Anthropic');
  });

  it('for coding assistants hides models without tool calling and flags unknown limits', async () => {
    render(<Harness purpose="coding" />);
    fireEvent.click(screen.getByRole('combobox'));
    const texts = optionTexts();
    expect(texts.some((x) => x.includes('deepseek-embed'))).toBe(false);
    expect(await tipOf('mystery')).toContain('参数未知');
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

  it('special option labels may be translation keys (module-level constants stay memo-friendly)', () => {
    render(
      <Harness
        value="follow"
        extraOptions={[{ value: 'follow', label: 'ui.models.same-as-chat' }]}
      />,
    );
    expect(screen.getByRole('combobox').textContent).toContain('跟随对话');
    fireEvent.click(screen.getByRole('combobox'));
    expect(optionTexts()[0]).toContain('跟随对话');
  });

  it('browse: provider tabs on top, vendor filter on the side, picks across providers', () => {
    const onPick = vi.fn();
    const many: PickerProvider[] = [
      {
        id: 'or',
        name: 'OpenRouter',
        models: [
          { id: 'z-ai/glm-5.3-flash' },
          { id: 'deepseek/deepseek-v4.1-flash' },
          { id: 'anthropic/claude-opus-5.5' },
        ],
      },
      { id: 'maas', name: 'MAAS', models: [{ id: 'Aerith-opus-5.5' }, { id: 'gpt-6.1' }] },
    ];
    render(<Harness providers={many} value="maas/Aerith-opus-5.5" browse onPick={onPick} />);
    fireEvent.click(screen.getByRole('combobox'));
    // 打开时停在当前值所在的供应商
    expect(screen.getByRole('tab', { name: 'MAAS' }).getAttribute('aria-selected')).toBe('true');
    expect(optionTexts()).toEqual(['Aerith-opus-5.5', 'gpt-6.1']);
    // 厂商：认出的在前，认不出的归到「其他」
    fireEvent.click(screen.getByTestId('model-picker-vendor-'));
    expect(optionTexts()).toEqual(['Aerith-opus-5.5']);
    // 换供应商：厂商筛选清空，只列这个供应商的模型
    fireEvent.click(screen.getByRole('tab', { name: 'OpenRouter' }));
    expect(optionTexts()).toHaveLength(3);
    fireEvent.click(screen.getByTestId('model-picker-vendor-zai'));
    expect(optionTexts()).toEqual(['z-ai/glm-5.3-flash']);
    // 没有「全部」供应商：只有各供应商的标签
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual(['OpenRouter', 'MAAS']);
    fireEvent.click(screen.getByTestId('model-picker-vendor-all'));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('claude'))!);
    expect(onPick).toHaveBeenCalledWith('or/anthropic/claude-opus-5.5');
  });

  it('browse hides tabs with a single provider', () => {
    render(<Harness providers={[providers[0]]} browse />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('helpers', () => {
    expect(formatContext(128_000)).toBe('128K');
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(1_500_000)).toBe('1.5M');
    // 抹零，不四舍五入
    expect(formatContext(1_050_000)).toBe('1M');
    expect(formatContext(1_099_999)).toBe('1M');
    expect(formatContext(922_000)).toBe('922K');
    expect(formatContext(127_999)).toBe('127K');
    expect(formatContext(1_290_000)).toBe('1.2M');
    expect(splitModelRef('relay/vendor/model-x')).toEqual({
      provider: 'relay',
      model: 'vendor/model-x',
    });
    expect(splitModelRef('follow')).toBeNull();
  });
});
