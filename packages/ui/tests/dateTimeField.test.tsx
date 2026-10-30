import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input } from '../src';

afterEach(cleanup);

function Harness({
  type,
  initial,
  onChange,
  min,
}: {
  type: 'date' | 'time' | 'datetime-local';
  initial: string;
  onChange?: (v: string) => void;
  min?: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <Input
      type={type}
      data-testid="field"
      aria-label="字段"
      value={v}
      min={min}
      onChange={(e) => {
        setV(e.target.value);
        onChange?.(e.target.value);
      }}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: '字段' });
const pop = () => screen.queryByTestId('field-pop');

describe('Input date / time → DateTimeField', () => {
  it('does not render a native date input; the trigger shows the value', () => {
    render(<Harness type="date" initial="2026-10-20" />);
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(trigger().textContent).toContain('2026');
    expect(trigger().textContent).toContain('20');
  });

  it('picking a day emits YYYY-MM-DD through onChange and closes', () => {
    const onChange = vi.fn();
    render(<Harness type="date" initial="2026-10-20" onChange={onChange} />);
    fireEvent.click(trigger());
    const day = pop()!.querySelector<HTMLElement>('[data-day="2026-10-05"]')!;
    fireEvent.click(day);
    expect(onChange).toHaveBeenCalledWith('2026-10-05');
    expect(pop()).toBeNull();
  });

  it('respects min and moves months with the arrows', () => {
    const onChange = vi.fn();
    render(<Harness type="date" initial="2026-10-20" min="2026-10-10" onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(pop()!.querySelector<HTMLElement>('[data-day="2026-10-05"]')!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '下个月' }));
    expect(pop()!.querySelector('[data-day="2026-11-15"]')).not.toBeNull();
  });

  it('keyboard: arrow keys move the focused day, Enter picks it, Esc closes', () => {
    const onChange = vi.fn();
    render(<Harness type="date" initial="2026-10-20" onChange={onChange} />);
    fireEvent.click(trigger());
    const grid = pop()!.querySelector('[role="grid"]')!;
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('2026-10-28');
    fireEvent.click(trigger());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(pop()).toBeNull();
  });

  it('time: hour and minute columns update HH:MM', () => {
    const onChange = vi.fn();
    render(<Harness type="time" initial="09:30" onChange={onChange} />);
    expect(trigger().textContent).toContain('09:30');
    fireEvent.click(trigger());
    const hours = pop()!.querySelector('[data-unit="h"]')!;
    const minutes = pop()!.querySelector('[data-unit="m"]')!;
    fireEvent.click(hours.querySelector<HTMLElement>('[data-v="21"]')!);
    expect(onChange).toHaveBeenLastCalledWith('21:30');
    fireEvent.click(minutes.querySelector<HTMLElement>('[data-v="5"]')!);
    expect(onChange).toHaveBeenLastCalledWith('21:05');
    fireEvent.keyDown(minutes.querySelector<HTMLElement>('[data-v="5"]')!, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('21:06');
  });

  it('datetime-local keeps the time when the day changes', () => {
    const onChange = vi.fn();
    render(<Harness type="datetime-local" initial="2026-10-20T08:15" onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(pop()!.querySelector<HTMLElement>('[data-day="2026-10-22"]')!);
    expect(onChange).toHaveBeenLastCalledWith('2026-10-22T08:15');
    expect(pop()).not.toBeNull();
  });

  it('fireEvent.change on the data-testid element still works (hidden native input)', () => {
    const onChange = vi.fn();
    render(<Harness type="date" initial="2026-10-20" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('field'), { target: { value: '2026-01-02' } });
    expect(onChange).toHaveBeenCalledWith('2026-01-02');
  });
});
