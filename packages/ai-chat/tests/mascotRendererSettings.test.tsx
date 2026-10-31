// @vitest-environment happy-dom
/**
 * 设置 → 桌面角色动画（Rive）：官方角色的 .riv 是远程素材，打开后这一行显示下载进度，失败可重试
 * （docs/design/remote-character-assets.md）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MascotRendererSettings } from '../src/components/SettingsView/MascotRendererSettings';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

const base = { packId: 'nomi', remote: true };

describe('MascotRendererSettings — remote rive assets', () => {
  it('shows download progress, then the normal description once ready', async () => {
    const fake = installFakeApi({
      'mascot.getRenderer': () => 'rive',
      'character.assets': () => ({ ...base, status: 'downloading', percent: 42 }),
      'persona.get': () => ({ characterId: 'nomi', displayName: 'Nomi' }),
    });
    render(<MascotRendererSettings />);
    expect((await screen.findByTestId('settings-mascot-renderer-assets')).textContent).toMatch(
      /42%/,
    );
    await act(() =>
      fake.emit('character.assetsChanged', {
        ...base,
        status: 'ready',
        riveUrl: 'character-pack://assets/nomi/x.riv',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('settings-mascot-renderer-assets')).toBeNull());
    expect(screen.queryByTestId('settings-mascot-renderer-retry')).toBeNull();
  });

  it('on failure shows the reason and retries through character.ensureAssets', async () => {
    const fake = installFakeApi({
      'mascot.getRenderer': () => 'rive',
      'character.assets': () => ({ ...base, status: 'error', error: 'catalog HttpError: 404' }),
      'character.ensureAssets': () => ({ ...base, status: 'checking' }),
      'persona.get': () => ({ characterId: 'nomi', displayName: 'Nomi' }),
    });
    render(<MascotRendererSettings />);
    expect((await screen.findByTestId('settings-mascot-renderer-assets')).textContent).toContain(
      'catalog HttpError: 404',
    );
    fireEvent.click(screen.getByTestId('settings-mascot-renderer-retry'));
    await waitFor(() => expect(fake.inputs('character.ensureAssets')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('settings-mascot-renderer-retry')).toBeNull());
  });

  it('with the still image selected, download state is not shown', async () => {
    installFakeApi({
      'mascot.getRenderer': () => 'svg',
      'character.assets': () => ({ ...base, status: 'idle' }),
      'persona.get': () => ({ characterId: 'nomi', displayName: 'Nomi' }),
    });
    render(<MascotRendererSettings />);
    await screen.findByTestId('settings-mascot-renderer');
    expect(screen.queryByTestId('settings-mascot-renderer-assets')).toBeNull();
  });
});
