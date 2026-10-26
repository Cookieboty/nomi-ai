// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyModeSettings } from '../src/components/SettingsView/PrivacyModeSettings';
import type { GatewayState } from '../src/services/gatewayClient';

const h = vi.hoisted(() => ({
  state: null as Partial<GatewayState> | null,
  setOptions: vi.fn(async () => ({})),
}));

vi.mock('../src/services/nomiModel', () => ({ useGatewayState: () => h.state }));
vi.mock('../src/services/gatewayClient', () => ({
  gatewayClient: { setOptions: h.setOptions },
}));

afterEach(() => {
  cleanup();
  h.setOptions.mockClear();
});

const sw = (r: ReturnType<typeof render>) => r.getByTestId('privacy-mode-switch');
const checked = (el: HTMLElement) =>
  el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true;

describe('PrivacyModeSettings', () => {
  it('旧主进程没有 privacyMode 时不显示', () => {
    h.state = { providers: [] };
    expect(render(<PrivacyModeSettings />).queryByTestId('settings-privacy-mode')).toBeNull();
  });

  it('默认开；点关先确认，取消就不改', () => {
    h.state = { privacyMode: true };
    const r = render(<PrivacyModeSettings />);
    expect(checked(sw(r))).toBe(true);
    const confirm = vi.fn<() => boolean>(() => false);
    window.confirm = confirm;
    fireEvent.click(sw(r));
    expect(confirm).toHaveBeenCalledOnce();
    expect(h.setOptions).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(sw(r));
    expect(h.setOptions).toHaveBeenCalledWith({ privacyMode: false });
  });

  it('关着时重新打开不需要确认', () => {
    h.state = { privacyMode: false };
    const r = render(<PrivacyModeSettings />);
    expect(checked(sw(r))).toBe(false);
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    fireEvent.click(sw(r));
    expect(confirm).not.toHaveBeenCalled();
    expect(h.setOptions).toHaveBeenCalledWith({ privacyMode: true });
  });
});
