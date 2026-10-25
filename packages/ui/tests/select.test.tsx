import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrandIcon, Select } from '../src';

afterEach(cleanup);

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [v, setV] = useState('b');
  return (
    <Select
      data-testid="sel"
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onChange?.(e.target.value);
      }}
      options={[
        { value: 'a', label: 'Alpha', group: 'G1' },
        { value: 'b', label: 'Beta', group: 'G1' },
        { value: 'c', label: 'Gamma', group: 'G2', disabled: true },
        { value: 'd', label: 'Delta', group: 'G2' },
      ]}
    />
  );
}

describe('Select (custom dropdown)', () => {
  it('renders a combobox trigger, not a visible native select', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain('Beta');
    expect(screen.getByTestId('sel').tagName).toBe('SELECT');
    expect(screen.getByTestId('sel').className).toContain('cd-dropdown__native');
  });

  it('opens with groups + selected check and picks via click', () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('G1')).toBeTruthy();
    expect(screen.getByText('G2')).toBeTruthy();
    const opts = screen.getAllByRole('option');
    expect(opts.find((o) => o.getAttribute('aria-selected') === 'true')?.textContent).toContain(
      'Beta',
    );
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(spy).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keyboard: arrows skip disabled, Enter commits, Escape closes', () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = document.querySelector('.cd-dropdown__menu') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // b -> c(disabled) -> d
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(spy).toHaveBeenLastCalledWith('d');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(document.querySelector('.cd-dropdown__menu') as HTMLElement, {
      key: 'Escape',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a search box for long lists and filters', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` }));
    render(<Select options={options} value="m0" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByPlaceholderText('搜索…');
    act(() => {
      fireEvent.change(search, { target: { value: 'model-11' } });
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('labels and groups given as translation keys are shown and searched as translated text', () => {
    render(
      <Select
        searchable
        value="x"
        onChange={() => {}}
        options={[
          { value: 'x', label: 'ui.mascot-theme.search', group: 'ui.mascot-theme.please-select' },
          { value: 'y', label: 'Other' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(document.querySelector('.cd-dropdown__group')?.textContent).toBe('请选择');
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('搜索…'), { target: { value: '搜索' } });
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('accepts legacy <option>/<optgroup> children and native change events', () => {
    const spy = vi.fn();
    render(
      <Select data-testid="legacy" value="x" onChange={(e) => spy(e.target.value)}>
        <optgroup label="Grp">
          <option value="x">X</option>
          <option value="y">Y</option>
        </optgroup>
      </Select>,
    );
    fireEvent.change(screen.getByTestId('legacy'), { target: { value: 'y' } });
    expect(spy).toHaveBeenCalledWith('y');
  });
});

describe('BrandIcon', () => {
  it('uses bundled svg for known brands and initials otherwise', () => {
    const { container } = render(
      <>
        <BrandIcon brand="deepseek" name="DeepSeek" />
        <BrandIcon brand="nope" name="My Proxy" />
      </>,
    );
    const spans = container.querySelectorAll('[data-brand]');
    expect(spans[0].getAttribute('data-brand')).toBe('deepseek');
    expect(spans[1].textContent).toBe('MP');
    expect(container.innerHTML).not.toContain('<svg');
  });
});
