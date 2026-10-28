// @vitest-environment happy-dom
/**
 * D5 对话窗口视图经契约访问主进程：设置 → 灵动岛（island.*）、引导插图（character.getActivePack）。
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILTIN_ONBOARDING_ART, resolveOnboardingArt } from '../src/components/Onboarding/artUrls';
import { IslandSettings } from '../src/components/SettingsView/IslandSettings';

import { installMascotHost, resetMascotHost } from './helpers/mascotHost';

vi.mock('../src/services/api', async () =>
  (await import('./helpers/mascotHost')).mascotApiModule(),
);

afterEach(() => {
  cleanup();
  resetMascotHost();
});

const settings = {
  enabled: true,
  style: 'auto' as const,
  kinds: { message: true, agent: true, reminder: true },
};

describe('Settings → 灵动岛', () => {
  it('没有主进程：只提示桌面版可用', () => {
    const view = render(<IslandSettings />);
    expect(view.getByTestId('settings-island').textContent).toBeTruthy();
    expect(view.queryByTestId('island-enabled')).toBeNull();
  });

  it('读取、写入补丁后重新读取、测试通知', async () => {
    let cur = { ...settings };
    const set = vi.fn();
    const test = vi.fn(() => true);
    const get = vi.fn(() => ({ ...cur, mode: 'pill' as const, platform: 'darwin' }));
    installMascotHost({
      'island.get': () => get(),
      'island.set': (patch) => {
        set(patch);
        cur = { ...cur, ...(patch as object), kinds: { ...cur.kinds, ...(patch.kinds ?? {}) } };
        return cur;
      },
      'island.test': () => test(),
    });
    const view = render(<IslandSettings />);
    await waitFor(() => expect(view.getByTestId('island-pill')).toBeTruthy());
    fireEvent.click(view.getByTestId('island-kind-agent'));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0]![0]).toMatchObject({ kinds: { agent: false } });
    // 写入后重新读取（原 island:set → island:get）
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByTestId('island-test'));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
  });
});

describe('引导插图', () => {
  const snap = (over: Record<string, unknown>) => ({
    source: 'builtin' as const,
    id: null,
    mode: null,
    displayName: null,
    assetBaseUrl: null,
    onboarding: null,
    voiceBaseUrl: null,
    riveUrl: null,
    staticUrl: null,
    spriteManifestUrl: null,
    hitboxes: null,
    rive: null,
    ...over,
  });

  it('没有主进程或内置包：用构建自带的插图', async () => {
    expect(await resolveOnboardingArt()).toEqual(BUILTIN_ONBOARDING_ART);
    installMascotHost({ 'character.getActivePack': () => snap({ id: 'nomi' }) });
    expect(await resolveOnboardingArt()).toEqual(BUILTIN_ONBOARDING_ART);
  });

  it('运行时覆盖包带插图：换成 character-pack:// 地址', async () => {
    const onboarding = {
      welcome: 'character-pack://pack/onboarding/welcome.webp',
      profile: 'character-pack://pack/onboarding/profile.webp',
      provider: 'character-pack://pack/onboarding/provider.webp',
      privacy: 'character-pack://pack/onboarding/privacy.webp',
    };
    installMascotHost({
      'character.getActivePack': () => snap({ source: 'userData', id: 'alt', onboarding }),
    });
    expect(await resolveOnboardingArt()).toEqual(onboarding);
  });
});
