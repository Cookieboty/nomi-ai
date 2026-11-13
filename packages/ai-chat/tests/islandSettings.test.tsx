// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IslandSettings } from '../src/components/SettingsView/IslandSettings';

const host = vi.hoisted(() => ({
  state: {
    enabled: true,
    style: 'auto',
    size: 'large' as string | undefined,
    kinds: { message: true, agent: true, reminder: true, approval: true },
    mode: 'pill',
    platform: 'darwin',
  },
  set: vi.fn(),
  preview: vi.fn(async () => true),
}));
vi.mock('../src/services/api', () => ({
  hasTransport: () => true,
  api: {
    island: {
      get: async () => ({ ...host.state }),
      set: host.set,
      test: host.preview,
    },
  },
}));
vi.mock('../src/services/characterName', () => ({ useCharacterName: () => 'Companion' }));

beforeEach(() => {
  host.state.size = 'large';
  host.state.enabled = true;
  host.set.mockReset().mockImplementation(async (patch: Partial<typeof host.state>) => {
    Object.assign(host.state, patch);
    return { ...host.state };
  });
  host.preview.mockClear();
});
afterEach(cleanup);

describe('Island size settings', () => {
  it('shows all three presets and keeps large as the legacy default', async () => {
    host.state.size = undefined;
    const view = render(<IslandSettings />);
    const select = (await view.findByTestId('island-size')) as HTMLSelectElement;
    expect(select.value).toBe('large');
    expect([...select.options].map((option) => option.value)).toEqual(['large', 'medium', 'small']);
    expect(host.set).not.toHaveBeenCalled();
  });

  it('updates only size and reloads the saved preset across remounts', async () => {
    const view = render(<IslandSettings />);
    const select = (await view.findByTestId('island-size')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'small' } });
    await waitFor(() => expect(select.value).toBe('small'));
    expect(host.set).toHaveBeenCalledWith({ size: 'small' });
    expect(host.state.enabled).toBe(true);
    expect(host.state.style).toBe('auto');
    view.unmount();
    const remounted = render(<IslandSettings />);
    expect(((await remounted.findByTestId('island-size')) as HTMLSelectElement).value).toBe(
      'small',
    );
    fireEvent.change(remounted.getByTestId('island-size'), { target: { value: 'medium' } });
    await waitFor(() => expect(host.set).toHaveBeenLastCalledWith({ size: 'medium' }));
    fireEvent.click(remounted.getByTestId('island-test'));
    expect(host.preview).toHaveBeenCalledOnce();
  });

  it('keeps the saved size while notifications are disabled', async () => {
    host.state.size = 'small';
    host.state.enabled = false;
    const view = render(<IslandSettings />);
    const select = (await view.findByTestId('island-size')) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('small');
  });
});
