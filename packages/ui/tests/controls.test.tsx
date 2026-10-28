import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, Input, Slider } from '../src';

afterEach(cleanup);

describe('Checkbox / Slider', () => {
  it('stay native inputs with the in-app class', () => {
    const onChange = vi.fn();
    render(
      <>
        <Checkbox aria-label="记住" onChange={(e) => onChange(e.target.checked)} />
        <Slider aria-label="音量" min={0} max={10} value={5} onChange={() => {}} />
      </>,
    );
    const box = screen.getByRole('checkbox', { name: '记住' });
    expect(box.className).toContain('cd-checkbox');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    const slider = screen.getByRole('slider', { name: '音量' });
    expect(slider.className).toContain('cd-slider');
    expect(slider.style.getPropertyValue('--slider-fill')).toBe('50%');
  });

  it('Input type="checkbox" / "range" render the shared controls', () => {
    render(
      <>
        <Input type="checkbox" aria-label="a" />
        <Input type="range" aria-label="b" min={-50} max={50} value={25} onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole('checkbox').className).toContain('cd-checkbox');
    expect(screen.getByRole('slider').style.getPropertyValue('--slider-fill')).toBe('75%');
  });
});

function NumberHarness(props: { step?: string; min?: number; max?: number; initial: string }) {
  const [v, setV] = useState(props.initial);
  return (
    <Input
      type="number"
      data-testid="num"
      step={props.step}
      min={props.min}
      max={props.max}
      value={v}
      onChange={(e) => setV(e.target.value)}
    />
  );
}

describe('Input type="number" → NumberField', () => {
  const steps = () => document.querySelectorAll<HTMLButtonElement>('.cd-number__step');

  it('the stepper buttons change the value through onChange, clamped to min / max', () => {
    render(<NumberHarness initial="9" min={1} max={10} />);
    const input = screen.getByTestId('num') as HTMLInputElement;
    const [up, down] = steps();
    fireEvent.click(up!);
    expect(input.value).toBe('10');
    fireEvent.click(up!);
    expect(input.value).toBe('10');
    fireEvent.click(down!);
    fireEvent.click(down!);
    expect(input.value).toBe('8');
  });

  it('step="any" steps by 1 and keeps decimals; empty starts at min', () => {
    render(<NumberHarness initial="7.25" step="any" min={0} />);
    const input = screen.getByTestId('num') as HTMLInputElement;
    fireEvent.click(steps()[0]!);
    expect(input.value).toBe('8.25');
    cleanup();
    render(<NumberHarness initial="" min={1} />);
    fireEvent.click(steps()[0]!);
    expect((screen.getByTestId('num') as HTMLInputElement).value).toBe('1');
  });

  it('the data-testid stays on the real number input', () => {
    render(<NumberHarness initial="3" />);
    expect(screen.getByTestId('num').getAttribute('type')).toBe('number');
  });
});
