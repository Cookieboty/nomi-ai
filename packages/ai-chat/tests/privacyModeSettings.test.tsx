// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyModeSettings } from '../src/components/SettingsView/PrivacyModeSettings';
import type { GatewayState, PrivacyLogEntry } from '../src/services/gatewayClient';

const h = vi.hoisted(() => ({
  state: null as Partial<GatewayState> | null,
  client: {
    setOptions: vi.fn(async () => ({})),
    privacySetAction: vi.fn(async () => ({})),
    privacyAddSecret: vi.fn(async () => ({})),
    privacyRemoveSecret: vi.fn(async () => ({})),
    privacyAddAllow: vi.fn(async () => ({})),
    privacyRemoveAllow: vi.fn(async () => ({})),
    privacyLog: vi.fn(async () => [] as PrivacyLogEntry[]),
    privacyClearLog: vi.fn(async () => undefined),
  },
}));

vi.mock('../src/services/nomiModel', () => ({ useGatewayState: () => h.state }));
vi.mock('../src/services/gatewayClient', () => ({ gatewayClient: h.client }));

afterEach(() => {
  cleanup();
  for (const f of Object.values(h.client)) f.mockClear();
});

const sw = (r: ReturnType<typeof render>) => r.getByTestId('privacy-mode-switch');
const checked = (el: HTMLElement) =>
  el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true;

const settings = (extra: Partial<NonNullable<GatewayState['privacy']>> = {}) => ({
  actions: {},
  secrets: [],
  allow: [],
  ...extra,
});

const entry = (extra: Partial<PrivacyLogEntry> = {}): PrivacyLogEntry => ({
  placeholder: '{{API_KEY_abcdefgh}}',
  kind: 'API_KEY',
  len: 40,
  head: 'sk-p',
  allowTag: 'zzzzzzzz',
  action: 'mask',
  firstAt: 1,
  lastAt: 2,
  requests: 3,
  masked: 3,
  restored: 1,
  clients: ['claude', 'nomi'],
  ...extra,
});

describe('PrivacyModeSettings', () => {
  it('旧主进程没有 privacyMode 时不显示', () => {
    h.state = { providers: [] };
    expect(render(<PrivacyModeSettings />).queryByTestId('settings-privacy-mode')).toBeNull();
  });

  it('默认开；点关先确认，取消就不改', () => {
    h.state = { privacyMode: true };
    const r = render(<PrivacyModeSettings />);
    expect(checked(sw(r))).toBe(true);
    // 没有 privacy 细项（旧主进程）时只显示开关
    expect(r.queryByTestId('settings-privacy-actions')).toBeNull();
    const confirm = vi.fn<() => boolean>(() => false);
    window.confirm = confirm;
    fireEvent.click(sw(r));
    expect(confirm).toHaveBeenCalledOnce();
    expect(h.client.setOptions).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(sw(r));
    expect(h.client.setOptions).toHaveBeenCalledWith({ privacyMode: false });
  });

  it('关着时重新打开不需要确认', () => {
    h.state = { privacyMode: false };
    const r = render(<PrivacyModeSettings />);
    expect(checked(sw(r))).toBe(false);
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    fireEvent.click(sw(r));
    expect(confirm).not.toHaveBeenCalled();
    expect(h.client.setOptions).toHaveBeenCalledWith({ privacyMode: true });
  });

  it('按类型选动作', () => {
    h.state = { privacyMode: true, privacy: settings({ actions: { PRIVATE_KEY: 'block' } }) };
    const r = render(<PrivacyModeSettings />);
    expect(r.getByTestId('settings-privacy-actions')).toBeTruthy();
    // 自绘下拉框：点触发器（第一个是 API Key）打开，再点选项
    fireEvent.click(r.getAllByRole('combobox')[0]!);
    fireEvent.click(document.querySelector('[data-value="warn"]')!);
    expect(h.client.privacySetAction).toHaveBeenCalledWith('API_KEY', 'warn');
  });

  it('登记自定义密钥，成功后清空输入；删除', async () => {
    h.state = {
      privacyMode: true,
      privacy: settings({ secrets: [{ id: 's1', name: '内网', masked: 'corp…42' }] }),
    };
    const r = render(<PrivacyModeSettings />);
    const name = r.getByTestId('privacy-secret-name') as HTMLInputElement;
    const value = r.getByTestId('privacy-secret-value') as HTMLInputElement;
    expect(value.type).toBe('password');
    fireEvent.change(name, { target: { value: '数据库' } });
    fireEvent.change(value, { target: { value: 'db-pass-1234567' } });
    fireEvent.click(r.getByTestId('privacy-secret-add'));
    expect(h.client.privacyAddSecret).toHaveBeenCalledWith('数据库', 'db-pass-1234567');
    await waitFor(() => expect(value.value).toBe(''));
    fireEvent.click(r.getByLabelText(/内网/));
    expect(h.client.privacyRemoveSecret).toHaveBeenCalledWith('s1');
  });

  it('出错时显示原因，不清空输入', async () => {
    h.state = { privacyMode: true, privacy: settings() };
    h.client.privacyAddAllow.mockRejectedValueOnce(new Error('坏了'));
    const r = render(<PrivacyModeSettings />);
    const v = r.getByTestId('privacy-allow-value') as HTMLInputElement;
    fireEvent.change(v, { target: { value: 'sk-test-fake' } });
    fireEvent.click(r.getByTestId('privacy-allow-add'));
    expect(h.client.privacyAddAllow).toHaveBeenCalledWith({ value: 'sk-test-fake' });
    await waitFor(() => expect(r.getByTestId('privacy-error').textContent).toContain('坏了'));
    expect(v.value).toBe('sk-test-fake');
  });

  it('最近隐藏的密钥：这不是密钥 → 按标记放行；已放行的不再给按钮', async () => {
    h.state = {
      privacyMode: true,
      privacy: settings({
        allow: [{ tag: 'yyyyyyyy', kind: 'TOKEN', len: 36, head: 'ghp_', at: 1 }],
      }),
    };
    h.client.privacyLog.mockResolvedValueOnce([
      entry(),
      entry({ placeholder: '{{TOKEN_bbbbbbbb}}', kind: 'TOKEN', allowTag: 'yyyyyyyy' }),
    ]);
    const r = render(<PrivacyModeSettings />);
    await waitFor(() => expect(r.getAllByTestId('privacy-log-entry')).toHaveLength(2));
    const buttons = r.getAllByTestId('privacy-not-a-secret');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(h.client.privacyAddAllow).toHaveBeenCalledWith({
      tag: 'zzzzzzzz',
      kind: 'API_KEY',
      len: 40,
      head: 'sk-p',
    });
    expect(r.getAllByTestId('privacy-log-entry')[0]!.textContent).toContain('claude、nomi');
    await act(async () => {
      fireEvent.click(r.getByTestId('privacy-log-clear'));
    });
    expect(h.client.privacyClearLog).toHaveBeenCalled();
  });

  it('隐私模式关着时细项都不能改', () => {
    h.state = { privacyMode: false, privacy: settings() };
    const r = render(<PrivacyModeSettings />);
    expect((r.getByTestId('privacy-secret-name') as HTMLInputElement).disabled).toBe(true);
    expect((r.getByTestId('privacy-allow-value') as HTMLInputElement).disabled).toBe(true);
  });
});
