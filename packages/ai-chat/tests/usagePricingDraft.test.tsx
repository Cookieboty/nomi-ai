// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Pricing } from '../src/components/UsagePanel/Pricing';
import type { UsageSettings, UsageState } from '../src/services/usageClient';

const baseState = (over: Partial<UsageSettings> = {}): UsageState =>
  ({
    settings: { customPrices: [{ model: 'm-a', input: 1, output: 2 }], cnyPerUsd: 7.2, ...over },
    pricing: { date: '2026-10-16', builtin: [], sync: null },
  }) as unknown as UsageState;

let push: (s: UsageState) => void = () => undefined;
let persisted: UsageSettings;
let ipc: ReturnType<typeof vi.fn>;

const Harness: React.FC<{ initial: UsageState }> = ({ initial }) => {
  const [state, setState] = useState(initial);
  useEffect(() => {
    push = setState;
  }, []);
  return (
    <Pricing
      state={state}
      unpriced={[]}
      onSettings={(settings) => setState((s) => ({ ...s, settings }))}
    />
  );
};

/** 模拟 IPC：每次都返回结构化克隆出来的新对象，而不是同一个引用 */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  persisted = baseState().settings;
  ipc = vi.fn(async (ch: string, patch: Partial<UsageSettings>) => {
    if (ch === 'ai:usage:set-settings') {
      const next = { ...persisted, ...patch } as UsageSettings;
      // 主进程的规范化：模型名去空格
      next.customPrices = (next.customPrices ?? []).map((p) => ({ ...p, model: p.model.trim() }));
      persisted = next;
      return clone(next);
    }
    return null;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke: ipc, on: () => () => undefined };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

/** 用量刷新：内容完全相同、引用全新的 state */
const usageRefresh = (s: UsageState) => act(() => push(clone(s)));

describe('自定义价格草稿不被无关的用量刷新冲掉（#49）', () => {
  it('新增行 / 改价 / 删除 + 汇率草稿：同内容的新数组到来后全部保留', async () => {
    const init = baseState();
    const { getAllByTestId, getByTestId } = render(<Harness initial={init} />);
    fireEvent.click(getByTestId('usage-add-price'));
    const rows = () => getAllByTestId('usage-custom-row');
    expect(rows()).toHaveLength(2);
    fireEvent.change(within(rows()[1]!).getByLabelText('模型名'), { target: { value: 'draft-x' } });
    fireEvent.change(within(rows()[0]!).getByTestId('usage-price-input'), {
      target: { value: '9.5' },
    });
    fireEvent.change(getByTestId('usage-rate'), { target: { value: '6.9' } });

    await usageRefresh(init);
    await usageRefresh(init);

    expect(rows()).toHaveLength(2);
    expect((within(rows()[1]!).getByLabelText('模型名') as HTMLInputElement).value).toBe('draft-x');
    expect((within(rows()[0]!).getByTestId('usage-price-input') as HTMLInputElement).value).toBe(
      '9.5',
    );
    expect((getByTestId('usage-rate') as HTMLInputElement).value).toBe('6.9');
  });

  it('删除草稿同样保留（不会因刷新又长回来）', async () => {
    const init = baseState();
    const { getAllByLabelText, queryAllByTestId } = render(<Harness initial={init} />);
    fireEvent.click(getAllByLabelText('删除这一行')[0]!);
    expect(queryAllByTestId('usage-custom-row')).toHaveLength(0);
    await usageRefresh(init);
    expect(queryAllByTestId('usage-custom-row')).toHaveLength(0);
  });

  it('干净状态：真实的价格更新照常同步进表单，没有冲突提示', async () => {
    const init = baseState();
    const { getAllByTestId, queryByTestId } = render(<Harness initial={init} />);
    await usageRefresh(baseState({ customPrices: [{ model: 'm-a', input: 5, output: 2 }] }));
    expect(
      (
        within(getAllByTestId('usage-custom-row')[0]!).getByTestId(
          'usage-price-input',
        ) as HTMLInputElement
      ).value,
    ).toBe('5');
    expect(queryByTestId('usage-pricing-conflict')).toBeNull();
  });

  it('有草稿时真实的外部变更：保留草稿并提示冲突，可选择放弃草稿载入最新', async () => {
    const init = baseState();
    const { getAllByTestId, getByTestId, getByText, queryByTestId } = render(
      <Harness initial={init} />,
    );
    fireEvent.change(
      within(getAllByTestId('usage-custom-row')[0]!).getByTestId('usage-price-input'),
      {
        target: { value: '9.5' },
      },
    );
    await usageRefresh(baseState({ customPrices: [{ model: 'm-a', input: 5, output: 2 }] }));
    expect(getByTestId('usage-pricing-conflict')).toBeTruthy();
    expect(
      (
        within(getAllByTestId('usage-custom-row')[0]!).getByTestId(
          'usage-price-input',
        ) as HTMLInputElement
      ).value,
    ).toBe('9.5');
    fireEvent.click(getByText('放弃修改并载入最新'));
    expect(
      (
        within(getAllByTestId('usage-custom-row')[0]!).getByTestId(
          'usage-price-input',
        ) as HTMLInputElement
      ).value,
    ).toBe('5');
    expect(queryByTestId('usage-pricing-conflict')).toBeNull();
  });

  it('保存成功：显示规范化后的值，之后的刷新不再算冲突，且能再接收外部更新', async () => {
    const init = baseState();
    const { getAllByTestId, getByTestId, getByText, queryByTestId } = render(
      <Harness initial={init} />,
    );
    fireEvent.change(within(getAllByTestId('usage-custom-row')[0]!).getByLabelText('模型名'), {
      target: { value: '  m-a  ' },
    });
    fireEvent.click(getByTestId('usage-save-prices'));
    await waitFor(() => expect(getByText('已保存')).toBeTruthy());
    expect(
      (within(getAllByTestId('usage-custom-row')[0]!).getByLabelText('模型名') as HTMLInputElement)
        .value,
    ).toBe('m-a'); // 规范化（trim）后的值
    expect(queryByTestId('usage-pricing-conflict')).toBeNull();
    await usageRefresh(baseState({ customPrices: persisted.customPrices }));
    expect(queryByTestId('usage-pricing-conflict')).toBeNull();
    // 保存后又变干净：外部更新直接生效
    await usageRefresh(baseState({ customPrices: [{ model: 'm-a', input: 7, output: 2 }] }));
    expect(
      (
        within(getAllByTestId('usage-custom-row')[0]!).getByTestId(
          'usage-price-input',
        ) as HTMLInputElement
      ).value,
    ).toBe('7');
  });
});
