import { cleanup, fireEvent, render } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from '../src';

afterEach(cleanup);

type Option = { value: string; label: string; disabled?: boolean };

const THEME_OPTIONS: Option[] = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 受控用法：和设置页一样由调用方持有 value，onChange 后立刻回写 */
function Harness({
  initial = 'auto',
  options = THEME_OPTIONS,
  disabled,
  onChange,
}: {
  initial?: string | null;
  options?: Option[];
  disabled?: boolean;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <SegmentedControl
      aria-label="主题"
      options={options}
      value={value}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const group = () => document.querySelector<HTMLElement>('[role="radiogroup"]')!;
const radios = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const byLabel = (label: string) => radios().find((r) => r.textContent === label)!;

function expectFocusedChecked(label: string) {
  const el = byLabel(label);
  expect(document.activeElement).toBe(el);
  expect(el.getAttribute('aria-checked')).toBe('true');
  expect(el.tabIndex).toBe(0);
}

describe('SegmentedControl 方向键切换选中项与焦点（#428）', () => {
  it('→ / ↓ 把焦点和 aria-checked 一起移到下一个选项', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    byLabel('自动').focus();

    fireEvent.keyDown(byLabel('自动'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('light');
    expectFocusedChecked('浅色');
    expect(byLabel('自动').getAttribute('aria-checked')).toBe('false');
    expect(byLabel('自动').tabIndex).toBe(-1);

    fireEvent.keyDown(byLabel('浅色'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('dark');
    expectFocusedChecked('深色');
  });

  it('← / ↑ 反向移动，并在首尾循环', () => {
    const onChange = vi.fn();
    render(<Harness initial="light" onChange={onChange} />);
    byLabel('浅色').focus();

    fireEvent.keyDown(byLabel('浅色'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('auto');
    expectFocusedChecked('自动');

    fireEvent.keyDown(byLabel('自动'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('dark');
    expectFocusedChecked('深色');

    fireEvent.keyDown(byLabel('深色'), { key: 'ArrowUp' });
    expectFocusedChecked('浅色');

    fireEvent.keyDown(byLabel('浅色'), { key: 'ArrowRight' });
    expectFocusedChecked('深色');

    fireEvent.keyDown(byLabel('深色'), { key: 'ArrowRight' });
    expectFocusedChecked('自动');
  });

  it('跳过禁用项（两侧都跳），禁用项既不得焦点也不选中', () => {
    const options: Option[] = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
      { value: 'd', label: 'D', disabled: true },
    ];
    const onChange = vi.fn();
    render(<Harness initial="a" options={options} onChange={onChange} />);
    byLabel('A').focus();

    fireEvent.keyDown(byLabel('A'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expectFocusedChecked('C');
    expect(byLabel('B').disabled).toBe(true);
    expect(byLabel('B').getAttribute('aria-checked')).toBe('false');
    expect(byLabel('D').getAttribute('aria-checked')).toBe('false');

    fireEvent.keyDown(byLabel('C'), { key: 'ArrowRight' });
    expectFocusedChecked('A');

    fireEvent.keyDown(byLabel('A'), { key: 'ArrowLeft' });
    expectFocusedChecked('C');
  });

  it('事件从选项按钮冒泡上来时焦点同样落到新选项（不依赖 currentTarget）', () => {
    render(<Harness />);
    byLabel('自动').focus();
    // 在 radiogroup 上触发：currentTarget 仍是根节点，但内部实现只能靠自身的 ref 定位
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expectFocusedChecked('浅色');
    // 焦点已在新按钮上，继续按方向键从新选中项出发
    fireEvent.keyDown(byLabel('浅色'), { key: 'ArrowRight' });
    expectFocusedChecked('深色');
  });

  it('没有选中项时方向键从第一个可用项开始选中并聚焦', () => {
    const onChange = vi.fn();
    render(<Harness initial={null} onChange={onChange} />);
    expect(radios().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    // 没有选中项时第一个可用项可 Tab 进来
    expect(byLabel('自动').tabIndex).toBe(0);

    byLabel('自动').focus();
    fireEvent.keyDown(byLabel('自动'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('auto');
    expectFocusedChecked('自动');

    fireEvent.keyDown(byLabel('自动'), { key: 'ArrowRight' });
    expectFocusedChecked('浅色');
  });

  it('非键盘键、禁用控件不改变选中项与焦点；Tab 不被拦截（roving tabindex）', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Harness initial="light" onChange={onChange} />);
    byLabel('浅色').focus();

    for (const key of ['Enter', ' ', 'Tab', 'Home', 'End', 'a']) {
      fireEvent.keyDown(byLabel('浅色'), { key });
    }
    expect(onChange).not.toHaveBeenCalled();
    expectFocusedChecked('浅色');
    expect(byLabel('自动').tabIndex).toBe(-1);
    expect(byLabel('深色').tabIndex).toBe(-1);

    rerender(<Harness initial="light" disabled onChange={onChange} />);
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    expect(byLabel('浅色').getAttribute('aria-checked')).toBe('true');
  });

  it('切换后焦点留在新选项上，不会被再次拉回原按钮', () => {
    render(<Harness initial="dark" />);
    byLabel('深色').focus();
    fireEvent.keyDown(byLabel('深色'), { key: 'ArrowRight' });
    expectFocusedChecked('自动');
    // 用户随即用鼠标点了别处：不应被异步聚焦抢回
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
